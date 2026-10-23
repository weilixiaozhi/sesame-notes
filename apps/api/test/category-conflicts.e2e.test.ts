import { assertExclusiveTestLocksReleased, assertTestTriggerRemoved } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Static } from '@sinclair/typebox';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { CategorySchema } from '../src/shared/contracts/accounting.js';
import {
  assertCategoryConflictTestDatabase,
  categoryConflictTestDatabaseUrl,
} from './category-conflict-test-database.js';

// 默认仅隔离库；复用原测试库必须显式声明 API 已停止的独占窗口，且运行前再次核对实际库身份。
const url = categoryConflictTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
const prisma = new PrismaClient({ datasourceUrl: url });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: url,
      JWT_SECRET: 'category-conflicts-isolated-test-secret-at-least-32',
      STORAGE_PATH: '.category-conflicts-test',
    }),
    authRateLimitMax: 1000,
    rateLimitMax: 1000,
  },
});
beforeAll(async () => {
  await assertCategoryConflictTestDatabase(prisma, url, process.env);
  await app.ready();
});
afterAll(async () => {
  try {
    await assertExclusiveTestLocksReleased(prisma, process.env);
  } finally {
    await app.close();
  }
});
type Category = Static<typeof CategorySchema>;
type Session = { access_token: string; device_id: string; user: { user_id: string } };
/** 所有操作使用真实鉴权路由及账号，测试不伪造所有权。 */
function request(
  session: Session,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  payload?: object,
  key?: string,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${session.access_token}`,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(payload ? { payload } : {}),
  });
}
/** 正式建账本会初始化61项；测试直接消费服务端目录而非另造特殊空目录。 */
async function setup() {
  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'category-test-password',
      device: { installation_id: randomUUID(), name: '分类冲突测试', platform: 'test' },
    },
  });
  expect(register.statusCode, register.body).toBe(201);
  const session = register.json<Session>();
  const ledger = await request(session, '/ledgers', 'POST', { name: '分类冲突账本', currency: 'CNY' });
  expect(ledger.statusCode, ledger.body).toBe(201);
  const ledgerId = ledger.json<{ id: string }>().id;
  const categories = (await request(session, `/ledgers/${ledgerId}/categories`)).json<Category[]>();
  return { session, ledgerId, categories, leaf: categories.find((row) => row.level === 2)! };
}
/** 本地旧冻结正文不补基线，不改任何字节，重试复用同一对象。 */
function intent(category: Category, payload: object = {}, action = 'upsert') {
  return {
    mutation_id: randomUUID(),
    entity_id: category.id,
    entity_type: 'category',
    ledger_id: null,
    action,
    updated_at: '1970-01-01T00:00:00.000Z',
    payload:
      action === 'delete'
        ? payload
        : {
            name: category.name,
            kind: category.kind,
            level: category.level,
            sort_order: category.sort_order,
            icon: category.icon,
            parent_id: category.parent_id,
            ...payload,
          },
  };
}
/** HTTP 200 不代表 mutation 已应用，必须核对逐项状态。 */
async function push(session: Session, frozen: ReturnType<typeof intent>) {
  const response = await request(session, '/sync/push', 'POST', { device_id: session.device_id, changes: [frozen] });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().outcomes[0];
}
/** 模拟Web的已读取基线编辑，稳定键在同一次重试中保持不变。 */
async function rename(ctx: Awaited<ReturnType<typeof setup>>, category: Category, name: string) {
  const response = await request(
    ctx.session,
    `/ledgers/${ctx.ledgerId}/categories/${category.id}?expected_version_token=${category.version_token}`,
    'PATCH',
    { name },
    randomUUID(),
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Category>();
}

/** 同账号通过真实登录取得另一设备身份，覆盖设备来源与账号级命令的交叉占用。 */
async function anotherDevice(session: Session): Promise<Session> {
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.user_id } });
    if (!user.phoneE164?.startsWith('+86')) throw new Error('分类测试账号缺少预期手机号');
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        country_code: '+86',
        phone: user.phoneE164.slice(3),
        password: 'category-test-password',
        device: { installation_id: randomUUID(), name: '分类另一设备', platform: 'test' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const second = response.json<Session>();
    expect(second.user.user_id).toBe(session.user.user_id);
    expect(second.device_id).not.toBe(session.device_id);
    return second;
  } catch (cause) {
    throw new Error('分类跨设备回归登录失败', { cause });
  }
}

it.each(['reservation', 'event'] as const)(
  '另一设备不能用已接受的%s来源UUID确认候选，也不能破坏来源重放',
  async (kind) => {
    try {
      const ctx = await setup();
      const second = await anotherDevice(ctx.session);
      const source = intent(
        ctx.leaf,
        kind === 'event' ? { name: '设备A已提交名称', base_token: ctx.leaf.version_token } : {},
      );
      const accepted = await push(ctx.session, source);
      expect(accepted.status).toBe('accepted');
      expect(accepted.change_id === null).toBe(kind === 'reservation');
      const cloud = accepted.category_state as Category;
      const candidate = (await push(second, intent(cloud, { name: '设备B待确认内容' }))).category_conflict;
      const response = await request(second, `/category-conflicts/${candidate.id}/resolve`, 'POST', {
        mutation_id: source.mutation_id,
        expected_candidate_version: candidate.candidate_version,
        expected_cloud_token: candidate.cloud_snapshot.version_token,
        choice: 'cloud',
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe('MUTATION_ID_REUSED');
      expect(await prisma.categoryConflict.findUnique({ where: { id: candidate.id } })).toMatchObject({
        status: 'pending',
        resolutionMutationId: null,
      });
      expect(await push(ctx.session, source)).toMatchObject({
        status: kind === 'event' ? 'ignored' : 'accepted',
        change_id: accepted.change_id,
      });
    } catch (cause) {
      throw new Error('跨设备账号命令不得覆盖已接受来源身份', { cause });
    }
  },
);

it('无事件账号确认占用同时阻止另一设备REST和sync来源，相同UUID不影响其他账号', async () => {
  try {
    const ctx = await setup();
    const second = await anotherDevice(ctx.session);
    const candidate = (await push(ctx.session, intent(ctx.leaf, { name: '待确认本地内容' }))).category_conflict;
    const mutationId = randomUUID();
    const confirmed = await request(ctx.session, `/category-conflicts/${candidate.id}/resolve`, 'POST', {
      mutation_id: mutationId,
      expected_candidate_version: candidate.candidate_version,
      expected_cloud_token: candidate.cloud_snapshot.version_token,
      choice: 'cloud',
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const rest = await request(
      second,
      `/ledgers/${ctx.ledgerId}/categories/${ctx.leaf.id}?expected_version_token=${ctx.leaf.version_token}`,
      'PATCH',
      { name: ctx.leaf.name },
      mutationId,
    );
    expect(rest.statusCode, rest.body).toBe(409);
    expect(rest.json().code).toBe('MUTATION_ID_REUSED');
    const sync = await request(second, '/sync/push', 'POST', {
      device_id: second.device_id,
      changes: [{ ...intent(ctx.leaf), mutation_id: mutationId }],
    });
    expect(sync.statusCode, sync.body).toBe(409);
    expect(sync.json().code).toBe('MUTATION_ID_REUSED');
    const other = await setup();
    const independent = await request(
      other.session,
      `/ledgers/${other.ledgerId}/categories/${other.leaf.id}?expected_version_token=${other.leaf.version_token}`,
      'PATCH',
      { name: other.leaf.name },
      mutationId,
    );
    expect(independent.statusCode, independent.body).toBe(200);
  } catch (cause) {
    throw new Error('账号命令与设备来源的身份范围隔离验证失败', { cause });
  }
});

it('无基线旧冻结种子保留云改名，候选幂等且不生成第二个可见分类', async () => {
  const ctx = await setup();
  const cloud = await rename(ctx, ctx.leaf, '云端保留名');
  const frozen = intent(ctx.leaf, { name: '设备旧英文名称' });
  const beforeEvents = await prisma.syncChange.count({ where: { userId: ctx.session.user.user_id } });
  const first = await push(ctx.session, frozen);
  const again = await push(ctx.session, frozen);
  expect(first.status).toBe('conflict');
  expect(again.category_conflict.id).toBe(first.category_conflict.id);
  expect(first.category_conflict.cloud_snapshot).toMatchObject(cloud);
  expect(await prisma.category.count({ where: { ownerId: ctx.session.user.user_id } })).toBe(61);
  expect(await prisma.categoryConflict.count({ where: { ownerId: ctx.session.user.user_id } })).toBe(1);
  expect(await prisma.syncChange.count({ where: { userId: ctx.session.user.user_id } })).toBe(beforeEvents);
});

it('匹配基线的真实人工编辑不会因旧设备时间被LWW忽略；同内容无事件回权威基线', async () => {
  const ctx = await setup();
  const cloud = await rename(ctx, ctx.leaf, '第一次云编辑');
  const applied = await push(ctx.session, intent(cloud, { name: '明确人工编辑', base_token: cloud.version_token }));
  expect(applied.status).toBe('accepted');
  expect(applied.category_state.name).toBe('明确人工编辑');
  expect(Date.parse(applied.category_state.updated_at)).toBeGreaterThan(Date.parse(cloud.updated_at));
  const same = intent(applied.category_state);
  const count = await prisma.syncChange.count({ where: { userId: ctx.session.user.user_id } });
  expect(await push(ctx.session, same)).toMatchObject({
    status: 'accepted',
    change_id: null,
    category_state: applied.category_state,
  });
  expect(await prisma.syncChange.count({ where: { userId: ctx.session.user.user_id } })).toBe(count);
});

it('保留云端回执可永久重放，仅精确终结原mutation，不吞后继不同意图', async () => {
  const ctx = await setup();
  const frozen = intent(ctx.leaf, { name: '本地待确认' });
  const result = await push(ctx.session, frozen);
  const c = result.category_conflict;
  const body = {
    mutation_id: randomUUID(),
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'cloud',
  };
  const resolve = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', body);
  expect(resolve.statusCode, resolve.body).toBe(200);
  expect((await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', body)).json()).toEqual(
    resolve.json(),
  );
  expect(await push(ctx.session, frozen)).toMatchObject({
    status: 'accepted',
    change_id: null,
    category_resolution: {
      conflict_id: c.id,
      candidate_version: 2,
      source_mutation_id: frozen.mutation_id,
      resolution: 'cloud',
    },
  });
  expect((await push(ctx.session, { ...frozen, mutation_id: randomUUID() })).status).toBe('conflict');
  const changed = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
    ...body,
    choice: 'local',
  });
  expect(changed.statusCode).toBe(409);
  expect(changed.json().code).toBe('MUTATION_ID_REUSED');
});

it('云端再次变化使确认CAS失败；列表刷新返回当前token，候选内容不变', async () => {
  const ctx = await setup();
  const c = (await push(ctx.session, intent(ctx.leaf, { name: '本地候选' }))).category_conflict;
  const later = await rename(ctx, ctx.leaf, '确认期间新修改');
  const body = {
    mutation_id: randomUUID(),
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'local',
  };
  const stale = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', body);
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('CATEGORY_VERSION_CHANGED');
  const list = (await request(ctx.session, '/category-conflicts')).json();
  expect(list.items[0].local_payload.name).toBe('本地候选');
  expect(list.items[0].cloud_snapshot.version_token).toBe(later.version_token);
  const fresh = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
    ...body,
    mutation_id: randomUUID(),
    expected_cloud_token: later.version_token,
  });
  expect(fresh.statusCode, fresh.body).toBe(200);
  expect(fresh.json().category_state.name).toBe('本地候选');
});

it('云墓碑必须独立显式恢复确认，batch冲突不部分建可见分类且旧键固定重放', async () => {
  const ctx = await setup();
  const deletion = await request(
    ctx.session,
    `/ledgers/${ctx.ledgerId}/categories/${ctx.leaf.id}?expected_version_token=${ctx.leaf.version_token}`,
    'DELETE',
    undefined,
    randomUUID(),
  );
  expect(deletion.statusCode, deletion.body).toBe(204);
  const freshId = randomUUID();
  const key = randomUUID();
  const batch = {
    items: [
      { id: ctx.leaf.id, ...intent(ctx.leaf).payload },
      { id: freshId, name: '批次新分类', kind: 'expense', level: 1, parent_id: null },
    ],
  };
  const conflict = await request(ctx.session, `/ledgers/${ctx.ledgerId}/categories/add-batch`, 'POST', batch, key);
  expect(conflict.statusCode, conflict.body).toBe(409);
  expect(conflict.json().code).toBe('CATEGORY_CONFIRMATION_REQUIRED');
  expect(await prisma.category.findFirst({ where: { id: freshId, ownerId: ctx.session.user.user_id } })).toBeNull();
  const c = (await request(ctx.session, '/category-conflicts')).json().items[0];
  const body = {
    mutation_id: randomUUID(),
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'local',
  };
  expect((await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', body)).json().code).toBe(
    'CATEGORY_RESTORE_CONFIRMATION_REQUIRED',
  );
  const confirmed = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
    ...body,
    restore_deleted: true,
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  expect(confirmed.json().category_state.deleted_at).toBeNull();
  expect(
    (await request(ctx.session, `/ledgers/${ctx.ledgerId}/categories/add-batch`, 'POST', batch, key)).statusCode,
  ).toBe(409);
  expect(
    (await request(ctx.session, `/ledgers/${ctx.ledgerId}/categories/add-batch`, 'POST', batch, randomUUID()))
      .statusCode,
  ).toBe(200);
  expect(await prisma.category.count({ where: { ownerId: ctx.session.user.user_id } })).toBe(62);
});

it('不同账号即使同canonical ID也不可读或确认他人候选；并发同候选只有一个选择生效', async () => {
  const ctx = await setup();
  const other = await setup();
  const c = (await push(ctx.session, intent(ctx.leaf, { name: '唯一候选' }))).category_conflict;
  expect((await request(other.session, '/category-conflicts?status=all')).json().items).toHaveLength(0);
  const body = {
    mutation_id: randomUUID(),
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'cloud',
  };
  expect((await request(other.session, `/category-conflicts/${c.id}/resolve`, 'POST', body)).statusCode).toBe(404);
  const results = await Promise.all([
    request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', body),
    request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
      ...body,
      mutation_id: randomUUID(),
      choice: 'local',
    }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(await prisma.categoryConflict.count({ where: { id: c.id, status: 'resolved' } })).toBe(1);
});

it('确认父删除不得暗删未确认子分类；候选保持可恢复状态', async () => {
  const ctx = await setup();
  const parent = ctx.categories.find((row) => row.id === ctx.leaf.parent_id)!;
  const c = (await push(ctx.session, intent(parent, {}, 'delete'))).category_conflict;
  const result = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
    mutation_id: randomUUID(),
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'local',
  });
  expect(result.statusCode).toBe(409);
  expect(result.json().code).toBe('CATEGORY_HAS_CHILDREN');
  expect(
    await prisma.category.findFirst({ where: { id: parent.id, ownerId: ctx.session.user.user_id, deletedAt: null } }),
  ).not.toBeNull();
  expect(await prisma.categoryConflict.findUnique({ where: { id: c.id } })).toMatchObject({
    status: 'pending',
    candidateVersion: 1,
  });
});

it('首次accepted的执行快照与重复ignored的当前快照不同，后继不得借重放偷换基线', async () => {
  const ctx = await setup();
  const frozen = intent(ctx.leaf, { name: '本次执行值', base_token: ctx.leaf.version_token });
  const first = await push(ctx.session, frozen);
  expect(first).toMatchObject({ status: 'accepted', category_state: { name: '本次执行值' } });
  expect(first.change_id).toMatch(/^\d+$/);
  const later = await rename(ctx, first.category_state, '另一端后来的值');
  const duplicate = await push(ctx.session, frozen);
  expect(duplicate).toMatchObject({ status: 'ignored', change_id: first.change_id, category_state: later });
  expect(first.category_state.version_token).not.toBe(later.version_token);
});

it('同内容无事件回执占用mutation，跨实体复用及确认复用均拒绝', async () => {
  const ctx = await setup();
  const noop = intent(ctx.leaf);
  expect(await push(ctx.session, noop)).toMatchObject({ status: 'accepted', change_id: null });
  const invalid = await request(ctx.session, '/sync/push', 'POST', {
    device_id: ctx.session.device_id,
    changes: [
      {
        ...noop,
        entity_type: 'exchange_rate_override',
        entity_id: 'aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa',
        payload: { base_currency: 'CNY', quote_currency: 'USD', rate: '7.25' },
      },
    ],
  });
  expect(invalid.statusCode, invalid.body).toBe(409);
  expect(invalid.json().code).toBe('MUTATION_ID_REUSED');
  expect(await prisma.exchangeRateOverride.count({ where: { ownerId: ctx.session.user.user_id } })).toBe(0);
  expect(await prisma.category.count({ where: { ownerId: ctx.session.user.user_id } })).toBe(61);
  const c = (await push(ctx.session, intent(ctx.leaf, { name: '待确认' }))).category_conflict;
  const resolution = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
    mutation_id: noop.mutation_id,
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'cloud',
  });
  expect(resolution.statusCode).toBe(409);
  expect(resolution.json().code).toBe('MUTATION_ID_REUSED');
  expect(await push(ctx.session, noop)).toMatchObject({ status: 'accepted', change_id: null });
});

it('已删官方父与新子同批只保存父候选，动态父校验不得回滚合法候选', async () => {
  const ctx = await setup();
  const parent = ctx.categories.find((row) => row.id === ctx.leaf.parent_id)!;
  const preview = await request(ctx.session, `/ledgers/${ctx.ledgerId}/categories/removal-preview`, 'POST', {
    category_ids: [parent.id],
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const removed = await request(
    ctx.session,
    `/ledgers/${ctx.ledgerId}/categories/remove`,
    'POST',
    {
      category_ids: [parent.id],
      mode: 'delete',
      preview_token: preview.json().preview_token,
    },
    randomUUID(),
  );
  expect(removed.statusCode, removed.body).toBe(200);
  const childId = randomUUID();
  const batch = await request(
    ctx.session,
    `/ledgers/${ctx.ledgerId}/categories/add-batch`,
    'POST',
    {
      items: [
        { id: parent.id, ...intent(parent).payload },
        { id: childId, name: '恢复父之后才可添加', kind: 'expense', level: 2, parent_id: parent.id },
      ],
    },
    randomUUID(),
  );
  expect(batch.statusCode, batch.body).toBe(409);
  expect(batch.json().code).toBe('CATEGORY_CONFIRMATION_REQUIRED');
  expect(
    await prisma.categoryConflict.count({ where: { ownerId: ctx.session.user.user_id, categoryId: parent.id } }),
  ).toBe(1);
  expect(await prisma.category.findFirst({ where: { ownerId: ctx.session.user.user_id, id: childId } })).toBeNull();
  const events = await prisma.syncChange.findMany({
    where: {
      userId: ctx.session.user.user_id,
      entityType: 'category',
      entityId: parent.id,
      action: 'delete',
    },
  });
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toMatchObject({
    id: parent.id,
    version_token: expect.stringMatching(/^[a-f0-9]{64}$/),
    deleted_at: expect.any(String),
  });
});

it('数据库候选状态约束拒绝resolved且resolution为空，原pending保持不变', async () => {
  const ctx = await setup();
  const c = (await push(ctx.session, intent(ctx.leaf, { name: '约束验证' }))).category_conflict;
  await expect(
    prisma.categoryConflict.update({
      where: { id: c.id },
      data: {
        status: 'resolved',
        resolution: null,
        resolutionMutationId: randomUUID(),
        resolutionHash: 'a'.repeat(64),
        resolutionResult: {},
        resolvedAt: new Date(),
      },
    }),
  ).rejects.toThrow();
  expect(await prisma.categoryConflict.findUnique({ where: { id: c.id } })).toMatchObject({
    status: 'pending',
    resolution: null,
  });
});

it('父分类改二级不能形成三级树，候选完整保留供修复', async () => {
  const ctx = await setup();
  const parent = ctx.categories.find((row) => row.id === ctx.leaf.parent_id)!;
  const otherParent = ctx.categories.find((row) => row.level === 1 && row.id !== parent.id)!;
  const c = (await push(ctx.session, intent(parent, { level: 2, parent_id: otherParent.id }))).category_conflict;
  const response = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
    mutation_id: randomUUID(),
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'local',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().code).toBe('CATEGORY_HAS_CHILDREN');
  expect(await prisma.categoryConflict.findUnique({ where: { id: c.id } })).toMatchObject({ status: 'pending' });
});

it('本地删除候选必须先处理活交易，拒绝时保留交易和候选', async () => {
  const ctx = await setup();
  const transaction = await prisma.transaction.create({
    data: {
      ledgerId: ctx.ledgerId,
      ownerId: ctx.session.user.user_id,
      txType: 'expense',
      amount: '19.1234567891',
      nativeAmount: '19.1234567891',
      currencyCode: 'CNY',
      happenedAt: new Date('2026-01-01T00:00:00Z'),
      categoryId: ctx.leaf.id,
      categoryName: ctx.leaf.name,
      categoryKind: 'expense',
      note: '金额必须保留',
    },
  });
  const c = (await push(ctx.session, intent(ctx.leaf, {}, 'delete'))).category_conflict;
  const response = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
    mutation_id: randomUUID(),
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'local',
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ code: 'CATEGORY_HAS_TRANSACTIONS' });
  expect(await prisma.categoryConflict.findUnique({ where: { id: c.id } })).toMatchObject({ status: 'pending' });
  expect(await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).toEqual(transaction);
  const deleted = await request(ctx.session, `/ledgers/${ctx.ledgerId}/transactions/${transaction.id}`, 'DELETE', {
    base_revision: transaction.revision,
  });
  expect(deleted.statusCode, deleted.body).toBe(204);
  const resolved = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
    mutation_id: randomUUID(),
    expected_candidate_version: c.candidate_version,
    expected_cloud_token: c.cloud_snapshot.version_token,
    choice: 'local',
  });
  expect(resolved.statusCode, resolved.body).toBe(200);
  const kept = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
  expect(kept).toMatchObject({
    id: transaction.id,
    categoryId: null,
    categoryName: null,
    note: transaction.note,
  });
  expect(kept.amount.toString()).toBe(transaction.amount.toString());
  expect(kept.nativeAmount.toString()).toBe(transaction.nativeAmount.toString());
  expect(kept.deletedAt).not.toBeNull();
  expect(kept.revision).toBe(transaction.revision + 1);
});

it('自定义同名分类不认领官方身份，但显式REST基线失配仍拒绝覆盖', async () => {
  const ctx = await setup();
  const custom = await request(ctx.session, `/ledgers/${ctx.ledgerId}/categories`, 'POST', {
    id: randomUUID(),
    name: ctx.leaf.name,
    kind: 'expense',
    level: 1,
  });
  expect(custom.statusCode, custom.body).toBe(201);
  const first = custom.json<Category>();
  const next = await rename(ctx, first, '自定义真实新名称');
  const stale = await request(
    ctx.session,
    `/ledgers/${ctx.ledgerId}/categories/${first.id}?expected_version_token=${first.version_token}`,
    'PATCH',
    { name: '旧表单不应覆盖' },
    randomUUID(),
  );
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('CATEGORY_VERSION_CHANGED');
  expect(await prisma.categoryConflict.count({ where: { ownerId: ctx.session.user.user_id } })).toBe(0);
  expect(await prisma.category.findFirst({ where: { ownerId: ctx.session.user.user_id, id: first.id } })).toMatchObject(
    { name: next.name },
  );
});

it('事件插入失败时分类变化和候选决策同事务回滚，重试仍可确认', async () => {
  const ctx = await setup();
  const c = (await push(ctx.session, intent(ctx.leaf, { name: '不得部分提交' }))).category_conflict;
  const before = await prisma.category.findUniqueOrThrow({
    where: { id_ownerId: { id: ctx.leaf.id, ownerId: ctx.session.user.user_id } },
  });
  const mutation = randomUUID();
  const trigger = `category_rollback_${randomUUID().replaceAll('-', '')}`;
  process.stdout.write(`TEST_TRIGGER_FIXTURE ${JSON.stringify({ trigger, table: 'sync_changes' })}\n`);
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated category rollback probe'; END $$`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON sync_changes FOR EACH ROW WHEN (NEW.mutation_id = '${mutation}'::uuid) EXECUTE FUNCTION ${trigger}()`,
    );
    const response = await request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
      mutation_id: mutation,
      expected_candidate_version: c.candidate_version,
      expected_cloud_token: c.cloud_snapshot.version_token,
      choice: 'local',
    });
    expect(response.statusCode).toBe(500);
    expect(
      await prisma.category.findUniqueOrThrow({
        where: { id_ownerId: { id: ctx.leaf.id, ownerId: ctx.session.user.user_id } },
      }),
    ).toEqual(before);
    expect(await prisma.categoryConflict.findUnique({ where: { id: c.id } })).toMatchObject({
      status: 'pending',
      resolution: null,
      resolutionMutationId: null,
    });
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON sync_changes`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION ${trigger}()`);
    await assertTestTriggerRemoved(prisma, trigger);
  }
});

/** 明确观察数据库锁队列，不能以sleep制造看似通过的撤权时序。 */
async function waitForCategoryResolutionLock() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid = lock.pid
        WHERE activity.datname = current_database() AND lock.locktype = 'advisory'
          AND lock.classid = 1936028513 AND lock.objid = 1 AND lock.objsubid = 2 AND NOT lock.granted
      ) AS waiting
    `;
    if (state?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('分类确认没有进入同步写锁队列');
}

it.each(['device', 'account'] as const)(
  '确认等待写锁期间%s撤权，不产生分类、候选或事件变化',
  async (revocation) => {
    const ctx = await setup();
    const c = (await push(ctx.session, intent(ctx.leaf, { name: '撤权后不得提交' }))).category_conflict;
    const before = await prisma.category.findUniqueOrThrow({
      where: { id_ownerId: { id: ctx.leaf.id, ownerId: ctx.session.user.user_id } },
    });
    const count = await prisma.syncChange.count({ where: { userId: ctx.session.user.user_id } });
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1936028513, 1)`;
        ready();
        await gate;
      },
      { timeout: 15000 },
    );
    await Promise.race([locked, blocker]);
    const pending = request(ctx.session, `/category-conflicts/${c.id}/resolve`, 'POST', {
      mutation_id: randomUUID(),
      expected_candidate_version: c.candidate_version,
      expected_cloud_token: c.cloud_snapshot.version_token,
      choice: 'local',
    }).then((response) => response);
    try {
      await waitForCategoryResolutionLock();
      if (revocation === 'device')
        await prisma.device.update({ where: { id: ctx.session.device_id }, data: { revokedAt: new Date() } });
      else await prisma.user.update({ where: { id: ctx.session.user.user_id }, data: { isEnabled: false } });
    } finally {
      release();
      try {
        await blocker;
      } finally {
        // Drain this request even if the queue/revocation assertion failed.
        await pending.catch(() => undefined);
      }
    }
    const result = await pending;
    expect(result.statusCode).toBe(401);
    expect(
      await prisma.category.findUniqueOrThrow({
        where: { id_ownerId: { id: ctx.leaf.id, ownerId: ctx.session.user.user_id } },
      }),
    ).toEqual(before);
    expect(await prisma.categoryConflict.findUnique({ where: { id: c.id } })).toMatchObject({
      status: 'pending',
      resolution: null,
    });
    expect(await prisma.syncChange.count({ where: { userId: ctx.session.user.user_id } })).toBe(count);
  },
  15000,
);

it('旧冻结delete保留额外字段参与身份指纹，同包重放稳定而换字段拒绝', async () => {
  const ctx = await setup();
  const oldPayload = {
    ...intent(ctx.leaf).payload,
    updated_at: '2020-01-01T00:00:00.000Z',
    old_client_marker: '原包额外字段',
  };
  const frozen = intent(ctx.leaf, oldPayload, 'delete');
  const first = await push(ctx.session, frozen);
  expect(first.status).toBe('conflict');
  expect(await push(ctx.session, frozen)).toMatchObject({ category_conflict: { id: first.category_conflict.id } });
  const changed = await request(ctx.session, '/sync/push', 'POST', {
    device_id: ctx.session.device_id,
    changes: [{ ...frozen, payload: { ...oldPayload, old_client_marker: '不得偷换' } }],
  });
  expect(changed.statusCode, changed.body).toBe(409);
  expect(changed.json().code).toBe('MUTATION_ID_REUSED');
  expect(await prisma.categoryConflict.count({ where: { ownerId: ctx.session.user.user_id } })).toBe(1);
});
