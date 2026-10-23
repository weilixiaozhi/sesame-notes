import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ADMIN_IDENTITY_MIGRATION,
  legacyAdminIdentityPlan,
  prepareLegacyAdminIdentity,
} from '../../apps/api/prisma/admin-identity-upgrade.mjs';

const legacyAccounts = [
  { username: 'admin_root', role: 'super_admin' },
  { username: 'admin_operator', role: 'operator' },
  { username: 'admin_auditor', role: 'auditor' },
  { username: 'admin_operator_two', role: 'operator' },
];
const legacyState = { accounts: 'admin_accounts', legacy: true, groups: null, new_columns: false };

/** 用顺序结果模拟数据库读操作，并记录写入，避免单元测试连接任何真实数据库。 */
function databaseFixture(results) {
  const queries = [];
  const writes = [];
  return {
    queries,
    writes,
    prisma: {
      /** 执行受控事务回调，将测试读取越界等异常附上场景诊断。 */
      async $transaction(run) {
        try {
          return await run({
            /** 按场景预设顺序返回查询结果，额外读取必须立即失败。 */
            async $queryRaw(strings) {
              queries.push(strings.join('?'));
              assert.ok(results.length, '数据库读取次数必须与场景匹配');
              return results.shift();
            },
            /** 记录 SQL 与绑定参数，供断言核对没有覆盖账号或人工清单。 */
            async $executeRaw(strings, ...values) {
              writes.push({ sql: strings.join('?'), values });
              return 1;
            },
          });
        } catch (cause) {
          throw new Error('后台身份升级测试事务失败', { cause });
        }
      },
    },
  };
}

/** 构造与仓库历史文件校验和一致的缺清单失败，验证恢复边界。 */
function missingPlanFailure() {
  try {
    const sql = readFileSync(
      new URL(`../../apps/api/prisma/migrations/${ADMIN_IDENTITY_MIGRATION}/migration.sql`, import.meta.url),
      'utf8',
    );
    return {
      migration_name: ADMIN_IDENTITY_MIGRATION,
      checksum: createHash('sha256').update(sql).digest('hex'),
      logs: 'ERROR: 后台账号迁移缺少显式分配清单；请先运行受控迁移准备命令，核对每个账号的目标组和权限变化',
      applied_steps_count: 0,
    };
  } catch (cause) {
    throw new Error('后台身份迁移失败夹具读取失败', { cause });
  }
}

test('旧账号按角色分组且普通业务权限为空，不读取或修改凭据和账号启停状态', () => {
  const original = structuredClone(legacyAccounts);
  const plan = legacyAdminIdentityPlan(legacyAccounts);
  assert.equal(plan.groups.length, 3);
  assert.equal(plan.accounts.length, 4);
  assert.equal(plan.accounts[1].group_id, plan.accounts[3].group_id);
  for (const group of plan.groups) {
    assert.deepEqual(group.permissions, []);
    assert.deepEqual(group.page_ids, []);
    assert.equal(group.is_enabled, true);
  }
  for (const [index, account] of plan.accounts.entries()) {
    assert.equal(account.username, original[index].username);
    assert.equal(account.expected_role, original[index].role);
    assert.equal(account.permissions_reviewed, true);
    assert.ok(plan.groups.some((group) => group.id === account.group_id));
  }
  assert.deepEqual(legacyAccounts, original);
});

for (const role of ['unknown', '__proto__', 'toString', null]) {
  test(`未知角色 ${role} 拒绝自动分配，不按普通身份兜底`, () => {
    assert.throws(() => legacyAdminIdentityPlan([{ username: 'admin_unknown', role }]), /清单生成失败/);
  });
}

test('重复或无效账号拒绝分配，空账号集合不生成多余组', () => {
  assert.throws(() => legacyAdminIdentityPlan([legacyAccounts[0], legacyAccounts[0]]), /清单生成失败/);
  assert.throws(() => legacyAdminIdentityPlan([{ username: '不合法', role: 'operator' }]), /清单生成失败/);
  assert.deepEqual(legacyAdminIdentityPlan([]), { groups: [], accounts: [] });
});

for (const state of [
  { accounts: null, legacy: false },
  { accounts: 'admin_accounts', legacy: false },
]) {
  test(`空库或已迁移结构跳过准备：${state.accounts ?? 'empty'}`, async () => {
    const fixture = databaseFixture([[state]]);
    assert.deepEqual(await prepareLegacyAdminIdentity(fixture.prisma), { accounts: 0, retry: false });
    assert.equal(fixture.writes.length, 1);
    assert.match(fixture.writes[0].sql, /pg_advisory_xact_lock/);
  });
}

test('已有准备表一律保留，不能自动覆盖人工清单或补齐无效清单', async () => {
  const fixture = databaseFixture([[legacyState], [{ name: 'admin_identity_migration_plan' }]]);
  assert.deepEqual(await prepareLegacyAdminIdentity(fixture.prisma), { accounts: 0, retry: false });
  assert.ok(fixture.writes.every((write) => !/CREATE|INSERT|UPDATE|DELETE/.test(write.sql)));
  assert.equal(fixture.queries.length, 2);
});

test('旧结构没有账号时不建立准备表', async () => {
  const fixture = databaseFixture([[legacyState], [{ name: null }], []]);
  assert.deepEqual(await prepareLegacyAdminIdentity(fixture.prisma), { accounts: 0, retry: false });
  assert.ok(fixture.writes.every((write) => !/CREATE|INSERT|UPDATE|DELETE/.test(write.sql)));
});

test('无准备表的旧库一次性写入完整映射且不改账号', async () => {
  const fixture = databaseFixture([[legacyState], [{ name: null }], legacyAccounts]);
  assert.deepEqual(await prepareLegacyAdminIdentity(fixture.prisma), { accounts: 4, retry: false });
  const inserts = fixture.writes.filter((write) => /INSERT INTO/.test(write.sql));
  assert.equal(inserts.length, 1);
  assert.equal(JSON.parse(inserts[0].values[0]).accounts.length, 4);
  assert.ok(fixture.writes.every((write) => !/UPDATE|DELETE/.test(write.sql)));
});

test('精确缺清单失败且历史校验和、回滚结构匹配时允许正常重试', async () => {
  const fixture = databaseFixture([
    [{ ...legacyState, migrations: '_prisma_migrations' }],
    [missingPlanFailure()],
    [{ name: null }],
    [{ clients: 0n }],
  ]);
  assert.deepEqual(await prepareLegacyAdminIdentity(fixture.prisma), { accounts: 0, retry: true });
  assert.ok(fixture.writes.every((write) => !/CREATE|INSERT|UPDATE|DELETE/.test(write.sql)));
});

test('失败记录未保存日志时，只对完整回滚、零执行步骤且缺少准备表的目标迁移正常重试', async () => {
  const fixture = databaseFixture([
    [{ ...legacyState, migrations: '_prisma_migrations' }],
    [{ ...missingPlanFailure(), logs: null }],
    [{ name: null }],
    [{ clients: 0n }],
    [{ ...legacyState, migrations: '_prisma_migrations' }],
    [],
    [{ name: null }],
    legacyAccounts,
  ]);
  assert.deepEqual(await prepareLegacyAdminIdentity(fixture.prisma), { accounts: 0, retry: true });
  assert.ok(fixture.writes.every((write) => !/CREATE|INSERT|UPDATE|DELETE/.test(write.sql)));
  assert.deepEqual(await prepareLegacyAdminIdentity(fixture.prisma), { accounts: 4, retry: false });
  assert.equal(fixture.writes.filter((write) => /INSERT/.test(write.sql)).length, 1);
});

test('仍有其他数据库连接时不能恢复未完成且无日志的迁移记录', async () => {
  const fixture = databaseFixture([
    [{ ...legacyState, migrations: '_prisma_migrations' }],
    [{ ...missingPlanFailure(), logs: null }],
    [{ name: null }],
    [{ clients: 1n }],
  ]);
  await assert.rejects(prepareLegacyAdminIdentity(fixture.prisma), /后台账号自动升级准备失败/);
  assert.ok(fixture.writes.every((write) => !/CREATE|INSERT|UPDATE|DELETE/.test(write.sql)));
});

for (const failure of [
  { checksum: 'incorrect-checksum' },
  { logs: 'ERROR: 清单权限不合法' },
  { migration_name: '20261009020000_default_admin_group' },
]) {
  test(`非预期迁移失败保留阻断：${Object.keys(failure)[0]}`, async () => {
    const fixture = databaseFixture([
      [{ ...legacyState, migrations: '_prisma_migrations' }],
      [{ ...missingPlanFailure(), ...failure }],
      [{ name: null }],
    ]);
    await assert.rejects(prepareLegacyAdminIdentity(fixture.prisma), /后台账号自动升级准备失败/);
    assert.ok(fixture.writes.every((write) => !/CREATE|INSERT|UPDATE|DELETE/.test(write.sql)));
  });
}

for (const state of [{ groups: 'admin_groups' }, { new_columns: true }]) {
  test(`失败事务结构未完整回滚时拒绝恢复：${Object.keys(state)[0]}`, async () => {
    const fixture = databaseFixture([
      [{ ...legacyState, migrations: '_prisma_migrations', ...state }],
      [missingPlanFailure()],
      [{ name: null }],
    ]);
    await assert.rejects(prepareLegacyAdminIdentity(fixture.prisma), /后台账号自动升级准备失败/);
    assert.ok(fixture.writes.every((write) => !/CREATE|INSERT|UPDATE|DELETE/.test(write.sql)));
  });
}

for (const condition of ['prepared_plan', 'applied_steps', 'unknown_migration', 'multiple_failures']) {
  test(`没有失败日志也不能跳过异常状态：${condition}`, async () => {
    const failure = { ...missingPlanFailure(), logs: null };
    if (condition === 'applied_steps') failure.applied_steps_count = 1;
    if (condition === 'unknown_migration') failure.migration_name = '20261009020000_default_admin_group';
    const fixture = databaseFixture([
      [{ ...legacyState, migrations: '_prisma_migrations' }],
      condition === 'multiple_failures' ? [failure, failure] : [failure],
      [{ name: condition === 'prepared_plan' ? 'admin_identity_migration_plan' : null }],
    ]);
    await assert.rejects(prepareLegacyAdminIdentity(fixture.prisma), /后台账号自动升级准备失败/);
    assert.ok(fixture.writes.every((write) => !/CREATE|INSERT|UPDATE|DELETE/.test(write.sql)));
  });
}
