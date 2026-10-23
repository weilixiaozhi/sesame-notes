import { adminMigrationTestDatabaseUrl } from './admin-migration-test-database.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOwnedFixture, linkOwnedFixtureDependencies, removeOwnedFixture } from './owned-fixture-directory.js';

const runFile = promisify(execFile);
const apiDirectory = resolve(import.meta.dirname, '..');
let project: string;
const versionProjects: string[] = [];
const databaseUrl = adminMigrationTestDatabaseUrl();
const groupId = 'b0000000-0000-4000-8000-000000000001';
const previousMigration = '20261008000000_independent_admin_accounts';
const currentMigration = '20261009000000_admin_identity_groups';

/** 在任一迁移阶段读取应用账号的基础字段，新增安全列由当前迁移链单独验证。 */
async function applicationUserSnapshot(database: PrismaClient, id: string) {
  try {
    const [user] = await database.$queryRaw<
      Array<{
        id: string;
        phoneE164: string;
        sesameNumber: string;
        passwordHash: string;
        isEnabled: boolean;
        createdAt: Date;
      }>
    >`
      SELECT id, phone_e164 AS "phoneE164", sesame_number AS "sesameNumber",
        password_hash AS "passwordHash", is_enabled AS "isEnabled", created_at AS "createdAt"
      FROM users WHERE id=${id}::uuid
    `;
    if (!user) throw new Error('应用账号迁移夹具不存在');
    return user;
  } catch (cause) {
    throw new Error('应用账号迁移基础快照读取失败', { cause });
  }
}

/** 执行真实部署入口，记录错误时只包含 CLI 输出，不输出连接凭据。 */
async function migrate(url: string, setup: string, database?: PrismaClient): Promise<void> {
  try {
    // 部署入口需要独占待升级数据库；断开夹具连接后，断言阶段会按需重新连接。
    await database?.$disconnect();
    await runFile(process.execPath, [setup], {
      cwd: apiDirectory,
      env: { ...process.env, DATABASE_URL: url },
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error('后台身份增量迁移失败', { cause });
  }
}

/** 从真实历史复制旧版本，所有临时资源均位于仓库 Temp。 */
beforeAll(async () => {
  try {
    project = await createOwnedFixture('admin-migration');
    const source = join(apiDirectory, 'prisma');
    await cp(source, join(project, 'prisma'), {
      recursive: true,
      filter: (path) =>
        dirname(path) !== join(source, 'migrations') ||
        !/^\d{14}_/.test(basename(path)) ||
        basename(path) <= previousMigration,
    });
    await linkOwnedFixtureDependencies(project);
  } catch (cause) {
    throw new Error('后台迁移验收临时工程创建失败', { cause });
  }
});

/** 清理前确认绝对路径仍在项目 Temp 内，不能递归删除调用者工作区。 */
afterAll(async () => {
  try {
    for (const directory of versionProjects) await removeOwnedFixture(directory);
    if (project) await removeOwnedFixture(project);
  } catch (cause) {
    throw new Error('后台迁移验收临时工程清理失败', { cause });
  }
});

/** 创建只属于本用例的随机数据库，使用完毕只删除这个数据库。 */
async function withDatabase(run: (database: PrismaClient, url: string) => Promise<void>): Promise<void> {
  const name = `sesame_admin_migration_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const controller = new PrismaClient({ datasourceUrl: databaseUrl });
  const database = new PrismaClient({ datasourceUrl: url.toString() });
  let created = false;
  try {
    await controller.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(url.toString(), join(project, 'prisma/setup.mjs'));
    await run(database, url.toString());
  } catch (cause) {
    throw new Error('后台迁移独立数据库验收失败', { cause });
  } finally {
    await database.$disconnect();
    try {
      if (created) await controller.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      await controller.$disconnect();
    }
  }
}

/** 用旧版原生列写入账号、会话与应用数据，确保新客户端没有提前转换它们。 */
async function createLegacy(database: PrismaClient) {
  const rootId = randomUUID();
  const memberId = randomUUID();
  const sessionId = randomUUID();
  await database.$executeRaw`INSERT INTO admin_accounts (id,username,display_name,password_hash,role,must_change_password,updated_at) VALUES (${rootId}::uuid,'migration_root','旧超管','root-original-hash','super_admin',true,CURRENT_TIMESTAMP),(${memberId}::uuid,'migration_member','旧普通账号','member-original-hash','operator',false,CURRENT_TIMESTAMP)`;
  await database.$executeRaw`INSERT INTO admin_sessions (id,admin_id,token_hash,last_seen_at,expires_at) VALUES (${sessionId}::uuid,${rootId}::uuid,${'a'.repeat(64)},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + INTERVAL '1 hour')`;
  const userId = randomUUID();
  await database.$executeRaw`
    INSERT INTO users (id,phone_e164,sesame_number,password_hash)
    VALUES (${userId}::uuid,'+8613900000011','100000011','application-original-hash')
  `;
  const user = await applicationUserSnapshot(database, userId);
  await database.auditLog.create({
    data: {
      actor: 'system',
      action: 'migration.test.original',
      target: { type: 'admin_account', id: rootId },
      requestId: 'original-history',
    },
  });
  return { rootId, memberId, sessionId, user };
}

/** 准备人工清单夹具，用于核对自动升级保留显式授权决定。 */
async function prepare(database: PrismaClient, accounts: unknown[], groups?: unknown[]) {
  const payload = JSON.stringify({
    groups: groups ?? [
      {
        id: groupId,
        name: '人工指定组',
        is_enabled: true,
        permissions: ['users:read', 'status:read'],
        page_ids: ['users'],
      },
    ],
    accounts,
  });
  await database.$executeRaw`CREATE TABLE admin_identity_migration_plan (id INTEGER PRIMARY KEY CHECK(id=1),payload JSONB NOT NULL)`;
  await database.$executeRaw`INSERT INTO admin_identity_migration_plan (id,payload) VALUES (1,${payload}::jsonb)`;
}

/** 完整分配清单显式列出每个账号的旧身份和权限评审结果。 */
function mapping() {
  return [
    { username: 'migration_root', group_id: groupId, expected_role: 'super_admin', permissions_reviewed: true },
    { username: 'migration_member', group_id: groupId, expected_role: 'operator', permissions_reviewed: true },
  ];
}

it.each(['empty', 'incomplete', 'role_changed', 'unknown_group', 'unreviewed', 'restricted_permission'] as const)(
  '迁移清单 %s 时阻止切换且保留全部旧数据和会话',
  async (failure) => {
    await withDatabase(async (database, url) => {
      const legacy = await createLegacy(database);
      const original = await database.$queryRaw`SELECT * FROM admin_accounts ORDER BY username`;
      const originalAudit = await database.auditLog.findMany({ where: { requestId: 'original-history' } });
      const accounts = mapping();
      if (failure === 'incomplete') accounts.pop();
      if (failure === 'role_changed') accounts[0]!.expected_role = 'auditor';
      if (failure === 'unknown_group') accounts[0]!.group_id = randomUUID();
      if (failure === 'unreviewed') accounts[0]!.permissions_reviewed = false;
      await prepare(
        database,
        accounts,
        failure === 'restricted_permission'
          ? [{ id: groupId, name: '违规控制组', is_enabled: true, permissions: ['accounts:manage'], page_ids: [] }]
          : undefined,
      );
      if (failure === 'empty') await database.$executeRaw`DELETE FROM admin_identity_migration_plan`;
      const originalPlan = await database.$queryRaw`SELECT * FROM admin_identity_migration_plan`;
      await expect(migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database)).rejects.toThrow();
      expect(await database.$queryRaw`SELECT * FROM admin_identity_migration_plan`).toEqual(originalPlan);
      expect(await database.$queryRaw`SELECT * FROM admin_accounts ORDER BY username`).toEqual(original);
      expect(await applicationUserSnapshot(database, legacy.user.id)).toEqual(legacy.user);
      expect(await database.auditLog.findMany({ where: { requestId: 'original-history' } })).toEqual(originalAudit);
      expect(
        await database.$queryRaw`SELECT revoked_at FROM admin_sessions WHERE id=${legacy.sessionId}::uuid`,
      ).toEqual([{ revoked_at: null }]);
      expect(await database.$queryRaw`SELECT to_regclass('public.admin_groups')::text AS name`).toEqual([
        { name: null },
      ]);
      expect(
        await database.$queryRaw`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name=${currentMigration} AND finished_at IS NOT NULL`,
      ).toEqual([{ count: 0 }]);
    });
  },
  120000,
);

it('连接指定其他 schema 时在升级准备前拒绝，public 旧账号和准备表保持原样', async () => {
  await withDatabase(async (database, url) => {
    await createLegacy(database);
    const original = await database.$queryRaw`SELECT * FROM admin_accounts ORDER BY username`;
    const target = new URL(url);
    target.searchParams.set('schema', 'other');
    await expect(migrate(target.toString(), join(apiDirectory, 'prisma/setup.mjs'), database)).rejects.toThrow();
    expect(await database.$queryRaw`SELECT * FROM admin_accounts ORDER BY username`).toEqual(original);
    expect(await database.$queryRaw`SELECT to_regclass('public.admin_identity_migration_plan')::text AS name`).toEqual([
      { name: null },
    ]);
    expect(await database.$queryRaw`SELECT to_regclass('public.admin_groups')::text AS name`).toEqual([{ name: null }]);
  });
}, 120000);

it('无清单旧库自动保留三类账号和密码，普通组初始无业务权限，重复升级不覆盖后续授权', async () => {
  await withDatabase(async (database, url) => {
    const legacy = await createLegacy(database);
    const auditorId = randomUUID();
    await database.$executeRaw`
      INSERT INTO admin_accounts (id,username,display_name,password_hash,role,is_enabled,updated_at)
      VALUES (${auditorId}::uuid,'migration_auditor','旧审计账号','auditor-original-hash','auditor',false,CURRENT_TIMESTAMP)
    `;
    await migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database);
    const accounts = await database.adminAccount.findMany({
      where: { id: { in: [legacy.rootId, legacy.memberId, auditorId] } },
      include: { group: true },
      orderBy: { username: 'asc' },
    });
    expect(accounts).toHaveLength(3);
    const root = accounts.find((account) => account.id === legacy.rootId)!;
    const member = accounts.find((account) => account.id === legacy.memberId)!;
    const auditor = accounts.find((account) => account.id === auditorId)!;
    expect(root).toMatchObject({
      identityType: 'super_admin',
      passwordHash: 'root-original-hash',
      isEnabled: true,
    });
    expect(member).toMatchObject({
      identityType: 'standard_user',
      passwordHash: 'member-original-hash',
      isEnabled: true,
    });
    expect(auditor).toMatchObject({
      identityType: 'standard_user',
      passwordHash: 'auditor-original-hash',
      isEnabled: false,
    });
    expect(new Set(accounts.map((account) => account.groupId)).size).toBe(3);
    for (const account of accounts)
      expect(account.group).toMatchObject({ isEnabled: true, permissions: [], pageIds: [] });
    expect(await applicationUserSnapshot(database, legacy.user.id)).toEqual(legacy.user);
    expect(
      (await database.adminSession.findUniqueOrThrow({ where: { id: legacy.sessionId } })).revokedAt,
    ).not.toBeNull();
    expect(await database.auditLog.count({ where: { action: 'admin.identity_migrated' } })).toBe(3);
    expect(await database.$queryRaw`SELECT to_regclass('public.admin_identity_migration_plan')::text AS name`).toEqual([
      { name: null },
    ]);
    const configuredGroup = await database.adminGroup.update({
      where: { id: member.groupId },
      data: { permissions: ['users:read'], pageIds: ['users'], name: '已配置业务组' },
    });
    await migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database);
    expect(await database.adminGroup.findUniqueOrThrow({ where: { id: member.groupId } })).toEqual(configuredGroup);
    expect(await database.auditLog.count({ where: { action: 'admin.identity_migrated' } })).toBe(3);
  });
}, 120000);

it('缺清单导致的历史迁移失败在完整回滚后自动恢复', async () => {
  await withDatabase(async (database, url) => {
    const legacy = await createLegacy(database);
    await database.$disconnect();
    await expect(
      runFile(
        process.execPath,
        [
          join(apiDirectory, 'node_modules/prisma/build/index.js'),
          'migrate',
          'deploy',
          '--schema',
          join(apiDirectory, 'prisma/schema.prisma'),
        ],
        { cwd: apiDirectory, env: { ...process.env, DATABASE_URL: url } },
      ),
    ).rejects.toThrow();
    expect(
      await database.$queryRaw`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name=${currentMigration} AND finished_at IS NULL AND rolled_back_at IS NULL`,
    ).toEqual([{ count: 1 }]);
    expect(await database.$queryRaw`SELECT to_regclass('public.admin_groups')::text AS name`).toEqual([{ name: null }]);
    const failureBefore = await database.$queryRaw`
      SELECT * FROM _prisma_migrations WHERE migration_name=${currentMigration}
    `;
    const blocker = new PrismaClient({ datasourceUrl: url });
    try {
      await blocker.$queryRaw`SELECT 1`;
      await expect(migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database)).rejects.toThrow();
      expect(
        await database.$queryRaw`SELECT * FROM _prisma_migrations WHERE migration_name=${currentMigration}`,
      ).toEqual(failureBefore);
      expect(
        await database.$queryRaw`SELECT to_regclass('public.admin_identity_migration_plan')::text AS name`,
      ).toEqual([{ name: null }]);
    } finally {
      await blocker.$disconnect();
    }
    await migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database);
    expect(await database.adminAccount.findUniqueOrThrow({ where: { id: legacy.rootId } })).toMatchObject({
      identityType: 'super_admin',
      passwordHash: 'root-original-hash',
    });
    expect(await applicationUserSnapshot(database, legacy.user.id)).toEqual(legacy.user);
    expect(
      await database.$queryRaw`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name=${currentMigration} AND rolled_back_at IS NOT NULL`,
    ).toEqual([{ count: 1 }]);
    expect(
      await database.$queryRaw`SELECT count(*)::int AS count FROM _prisma_migrations WHERE migration_name=${currentMigration} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    ).toEqual([{ count: 1 }]);
  });
}, 120000);

it('迁移按显式分配夹具保留账号密码及应用数据，转换身份、分配单组并撤销旧会话', async () => {
  await withDatabase(async (database, url) => {
    const legacy = await createLegacy(database);
    const history =
      await database.$queryRaw`SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`;
    await prepare(database, mapping(), [
      {
        id: groupId,
        name: '自定义受控组',
        is_enabled: true,
        permissions: ['users:read', 'status:read'],
        page_ids: ['users'],
      },
    ]);
    await migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database);
    const root = await database.adminAccount.findUniqueOrThrow({
      where: { id: legacy.rootId },
      include: { group: true },
    });
    const member = await database.adminAccount.findUniqueOrThrow({ where: { id: legacy.memberId } });
    expect(root).toMatchObject({
      username: 'migration_root',
      identityType: 'super_admin',
      passwordHash: 'root-original-hash',
      group: { name: '自定义受控组', permissions: ['users:read', 'status:read'] },
    });
    expect(member).toMatchObject({
      identityType: 'standard_user',
      groupId: root.groupId,
      passwordHash: 'member-original-hash',
    });
    expect(await applicationUserSnapshot(database, legacy.user.id)).toEqual(legacy.user);
    expect(
      (await database.adminSession.findUniqueOrThrow({ where: { id: legacy.sessionId } })).revokedAt,
    ).not.toBeNull();
    expect(
      await database.$queryRaw`SELECT migration_name,checksum FROM _prisma_migrations WHERE migration_name <= ${previousMigration} AND finished_at IS NOT NULL ORDER BY migration_name`,
    ).toEqual(history);
    expect(await database.auditLog.count({ where: { action: 'admin.identity_migrated' } })).toBe(2);
    expect(await database.auditLog.count({ where: { requestId: 'original-history' } })).toBe(1);
    expect(await database.$queryRaw`SELECT to_regclass('public.admin_identity_migration_plan')::text AS name`).toEqual([
      { name: null },
    ]);
    // 重跑只核对历史并跳过已执行迁移，不能覆盖维护人员改过的组配置。
    if (root.groupId === null) throw new Error('显式迁移映射未保留用户组归属');
    await database.adminGroup.update({ where: { id: root.groupId }, data: { name: '已由维护人员更名' } });
    await migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database);
    expect((await database.adminGroup.findUniqueOrThrow({ where: { id: root.groupId } })).name).toBe(
      '已由维护人员更名',
    );
  });
}, 120000);

it('最终空库初始化的首个超管归入默认分组，重复初始化不覆盖现有账号', async () => {
  await withDatabase(async (database, url) => {
    await migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database);
    const env = {
      ...process.env,
      DATABASE_URL: url,
      SEED_CONFIRM: 'CREATE_ADMIN',
      SEED_ADMIN_USERNAME: 'initial_default_group',
      SEED_ADMIN_PASSWORD: 'Chosen admin password 2026!',
      SEED_ADMIN_GROUP_ID: undefined,
      SEED_ADMIN_EMAIL: undefined,
      SEED_ADMIN_PHONE: undefined,
      SEED_ADMIN_COUNTRY_CODE: undefined,
    };
    await runFile(process.execPath, ['--import', 'tsx', join(apiDirectory, 'src/admin-bootstrap.ts')], {
      cwd: apiDirectory,
      env,
    });
    const account = await database.adminAccount.findUniqueOrThrow({ where: { username: 'initial_default_group' } });
    expect(account).toMatchObject({
      identityType: 'super_admin',
      groupId: 'a0000000-0000-4000-8000-000000000000',
      isEnabled: true,
      createdBy: '系统初始化',
    });
    await runFile(process.execPath, ['--import', 'tsx', join(apiDirectory, 'src/admin-bootstrap.ts')], {
      cwd: apiDirectory,
      env,
    });
    expect(await database.adminAccount.findUniqueOrThrow({ where: { id: account.id } })).toEqual(account);
  });
}, 120000);

/** 创建指定历史版本的真实部署目录，用于验证已部署可选组向默认组的增量升级。 */
async function versionSetup(through: string): Promise<string> {
  try {
    const directory = await createOwnedFixture('admin-version');
    versionProjects.push(directory);
    const source = join(apiDirectory, 'prisma');
    await cp(source, join(directory, 'prisma'), {
      recursive: true,
      filter: (path) =>
        dirname(path) !== join(source, 'migrations') || !/^\d{14}_/.test(basename(path)) || basename(path) <= through,
    });
    await linkOwnedFixtureDependencies(directory);
    return join(directory, 'prisma/setup.mjs');
  } catch (cause) {
    throw new Error('默认组迁移历史测试工程创建失败', { cause });
  }
}

it('默认组迁移仅回填NULL、撤相应会话，保留非空归属及同名业务组，并建立数据库默认值与保护', async () => {
  await withDatabase(async (database, url) => {
    await migrate(url, await versionSetup('20261009010000_optional_admin_group'), database);
    const defaultId = 'a0000000-0000-4000-8000-000000000000';
    const occupiedName = await database.adminGroup.create({
      data: { name: '默认分组', permissions: ['users:read'], pageIds: ['users'] },
    });
    const occupiedFallback = await database.adminGroup.create({
      data: { name: '默认分组（系统）', description: '原有业务组' },
    });
    const ungroupedId = randomUUID();
    await database.$executeRaw`INSERT INTO admin_accounts (id,username,display_name,password_hash,group_id,updated_at) VALUES (${ungroupedId}::uuid,'before_no_group','待归组用户','unchanged-password',NULL,CURRENT_TIMESTAMP)`;
    const grouped = await database.adminAccount.create({
      data: {
        username: 'before_with_group',
        displayName: '已归组用户',
        passwordHash: 'existing-password',
        groupId: occupiedName.id,
      },
      // 历史版本没有联系方式列，只读取该版本已经存在的字段。
      omit: { email: true, phone: true },
    });
    const nullSession = await database.adminSession.create({
      data: {
        adminId: ungroupedId,
        tokenHash: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 3600000),
        lastSeenAt: new Date(),
      },
    });
    const existingSession = await database.adminSession.create({
      data: {
        adminId: grouped.id,
        tokenHash: 'c'.repeat(64),
        expiresAt: new Date(Date.now() + 3600000),
        lastSeenAt: new Date(),
      },
    });
    await migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database);
    const defaultGroup = await database.adminGroup.findUniqueOrThrow({ where: { id: defaultId } });
    expect(defaultGroup).toMatchObject({ name: '默认分组（系统 2）', isEnabled: true, permissions: [], pageIds: [] });
    expect(await database.adminGroup.findUniqueOrThrow({ where: { id: occupiedName.id } })).toEqual(occupiedName);
    expect(await database.adminGroup.findUniqueOrThrow({ where: { id: occupiedFallback.id } })).toEqual(
      occupiedFallback,
    );
    expect(await database.adminAccount.findUniqueOrThrow({ where: { id: ungroupedId } })).toMatchObject({
      groupId: defaultId,
      passwordHash: 'unchanged-password',
      version: 2,
    });
    expect(await database.adminAccount.findUniqueOrThrow({ where: { id: grouped.id } })).toEqual({
      ...grouped,
      email: null,
      phone: null,
    });
    expect((await database.adminSession.findUniqueOrThrow({ where: { id: nullSession.id } })).revokedAt).not.toBeNull();
    expect(await database.adminSession.findUniqueOrThrow({ where: { id: existingSession.id } })).toEqual(
      existingSession,
    );
    expect(await database.$queryRaw`SELECT count(*)::int AS count FROM admin_accounts WHERE group_id IS NULL`).toEqual([
      { count: 0 },
    ]);
    const automaticId = randomUUID();
    await database.$executeRaw`INSERT INTO admin_accounts (id,username,display_name,password_hash,updated_at) VALUES (${automaticId}::uuid,'database_default','数据库默认值','unchanged-password',CURRENT_TIMESTAMP)`;
    expect((await database.adminAccount.findUniqueOrThrow({ where: { id: automaticId } })).groupId).toBe(defaultId);
    await expect(
      database.$executeRaw`UPDATE admin_accounts SET group_id=NULL WHERE id=${automaticId}::uuid`,
    ).rejects.toMatchObject({ meta: { code: '23502' } });
    await expect(
      database.$executeRaw`UPDATE admin_groups SET is_enabled=false WHERE id=${defaultId}::uuid`,
    ).rejects.toMatchObject({ meta: { code: '23514' } });
    await expect(database.$executeRaw`DELETE FROM admin_groups WHERE id=${defaultId}::uuid`).rejects.toMatchObject({
      meta: { code: '23514' },
    });
    await database.adminGroup.update({
      where: { id: defaultId },
      data: { name: '默认组自定义名称', description: '允许维护', permissions: ['users:read'], pageIds: ['users'] },
    });
    expect((await database.adminGroup.findUniqueOrThrow({ where: { id: defaultId } })).permissions).toEqual([
      'users:read',
    ]);
  });
}, 120000);

it('默认组固定引用被占用时拒绝升级，不覆盖账号归属或用户组配置', async () => {
  await withDatabase(async (database, url) => {
    await migrate(url, await versionSetup('20261009010000_optional_admin_group'), database);
    const occupied = await database.adminGroup.create({
      data: {
        id: 'a0000000-0000-4000-8000-000000000000',
        name: '既有业务引用',
        permissions: ['audit:read'],
        pageIds: ['audit'],
      },
    });
    const accountId = randomUUID();
    await database.$executeRaw`INSERT INTO admin_accounts (id,username,display_name,password_hash,group_id,updated_at) VALUES (${accountId}::uuid,'collision_account','原账号','original-hash',NULL,CURRENT_TIMESTAMP)`;
    const original = await database.$queryRaw`SELECT * FROM admin_accounts WHERE id=${accountId}::uuid`;
    await expect(migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database)).rejects.toThrow();
    expect(await database.adminGroup.findUniqueOrThrow({ where: { id: occupied.id } })).toEqual(occupied);
    expect(await database.$queryRaw`SELECT * FROM admin_accounts WHERE id=${accountId}::uuid`).toEqual(original);
    expect(
      await database.$queryRaw`SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_accounts' AND column_name='group_id'`,
    ).toEqual([{ is_nullable: 'YES' }]);
  });
}, 120000);

it('联系方式迁移保留账号与会话，允许空值并对已删除账号的登录凭据继续约束唯一性', async () => {
  await withDatabase(async (database, url) => {
    await migrate(url, await versionSetup('20261009020000_default_admin_group'), database);
    const firstId = randomUUID();
    const secondId = randomUUID();
    await database.$executeRaw`
      INSERT INTO admin_accounts (id,username,display_name,password_hash,updated_at)
      VALUES (${firstId}::uuid,'contact_first','第一个账号','first-original-hash',CURRENT_TIMESTAMP),
             (${secondId}::uuid,'contact_second','第二个账号','second-original-hash',CURRENT_TIMESTAMP)
    `;
    const originalAccounts = await database.$queryRaw<Array<Record<string, unknown>>>`
      SELECT to_jsonb(a) AS account FROM admin_accounts a ORDER BY username
    `;
    const session = await database.adminSession.create({
      data: {
        adminId: firstId,
        tokenHash: 'd'.repeat(64),
        expiresAt: new Date(Date.now() + 3600000),
        lastSeenAt: new Date(),
      },
    });
    await migrate(url, join(apiDirectory, 'prisma/setup.mjs'), database);
    // 比较全部历史列，避免新增联系方式时误改密码、用户名、状态或行版本。
    expect(
      await database.$queryRaw`
        SELECT to_jsonb(a) - 'email' - 'phone' AS account FROM admin_accounts a ORDER BY username
      `,
    ).toEqual(originalAccounts);
    expect(await database.adminSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(session);
    expect(
      await database.adminAccount.findMany({ select: { email: true, phone: true }, orderBy: { username: 'asc' } }),
    ).toEqual([
      { email: null, phone: null },
      { email: null, phone: null },
    ]);
    await database.adminAccount.update({
      where: { id: firstId },
      data: { email: 'ops@example.com', phone: '+8613800000000', isEnabled: false, deletedAt: new Date() },
    });
    await expect(
      database.adminAccount.update({ where: { id: secondId }, data: { email: 'ops@example.com' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      database.adminAccount.update({ where: { id: secondId }, data: { phone: '+8613800000000' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    for (const email of ['', 'Ops@example.com', ' ops@example.com', 'ops@example.com ', 'ops@localhost']) {
      await expect(
        database.$executeRaw`UPDATE admin_accounts SET email=${email} WHERE id=${secondId}::uuid`,
      ).rejects.toMatchObject({
        meta: { code: '23514', message: expect.stringContaining('admin_accounts_email_canonical_check') },
      });
    }
    for (const phone of ['', '13800000000', '+013800000000', '+12345', '+86 13800000000']) {
      await expect(
        database.$executeRaw`UPDATE admin_accounts SET phone=${phone} WHERE id=${secondId}::uuid`,
      ).rejects.toMatchObject({
        meta: { code: '23514', message: expect.stringContaining('admin_accounts_phone_canonical_check') },
      });
    }
    const updated = await database.adminAccount.update({
      where: { id: secondId },
      data: { email: "o'hara+ops@example.com", phone: '+123456' },
    });
    expect(updated).toMatchObject({ email: "o'hara+ops@example.com", phone: '+123456' });
    await database.adminAccount.update({ where: { id: secondId }, data: { email: null, phone: null } });
    await database.adminAccount.update({ where: { id: firstId }, data: { email: null, phone: null } });
    expect(await database.adminAccount.count({ where: { email: null, phone: null } })).toBe(2);
  });
}, 120000);
