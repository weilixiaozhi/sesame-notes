import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: { ...loadTestApiConfig(), databaseUrl, authRateLimitMax: 1000, rateLimitMax: 1000 },
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 分类载荷的 level 使用 JSON 数字，其余字段保持强类型边界。 */
function categoryWire(id: string, level: unknown, parentId: string | null = null, extra: object = {}) {
  return {
    mutation_id: randomUUID(),
    entity_type: 'category',
    entity_id: id,
    ledger_id: null,
    action: 'upsert',
    updated_at: '2026-09-25T00:00:00.000Z',
    payload: {
      name: `契约测试分类${id}`,
      kind: 'expense',
      level,
      sort_order: 1,
      icon: 'wallet',
      parent_id: parentId,
      ...extra,
    },
  };
}
/** 注册真实账号，验证当前分类协议。 */
async function register(): Promise<Session> {
  const result = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'category-wire-test-password',
      device: { installation_id: randomUUID(), name: '分类协议测试', platform: 'test' },
    },
  });
  expect(result.statusCode, result.body).toBe(201);
  return result.json<Session>();
}
/** 保持冻结原请求，不预先改变字段类型。 */
function push(session: Session, changes: ReturnType<typeof categoryWire>[]) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: { device_id: session.device_id, changes },
  });
}

/** 保存账号当前分类和事件，按稳定顺序比较本次请求是否产生额外写入。 */
async function catalogSnapshot(session: Session) {
  try {
    const [categories, events] = await Promise.all([
      prisma.category.findMany({ where: { ownerId: session.user.user_id }, orderBy: { id: 'asc' } }),
      prisma.syncChange.findMany({ where: { userId: session.user.user_id }, orderBy: { changeId: 'asc' } }),
    ]);
    return { categories, events };
  } catch (cause) {
    throw new Error('读取分类载荷测试的账号快照失败', { cause });
  }
}

it('数字层级准确保存权威快照并重放同一回执', async () => {
  const session = await register();
  const before = await catalogSnapshot(session);
  expect(before.categories).toHaveLength(61);
  expect(before.events).toHaveLength(61);
  const parentId = randomUUID();
  const childId = randomUUID();
  const changes = [categoryWire(parentId, 1), categoryWire(childId, 2, parentId)];
  const result = await push(session, changes);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().outcomes.map((item: { status: string }) => item.status)).toEqual(['accepted', 'accepted']);
  const after = await catalogSnapshot(session);
  const addedCategories = after.categories.filter((item) => item.id === parentId || item.id === childId);
  expect(addedCategories.toSorted((left, right) => left.level - right.level)).toMatchObject([
    { id: parentId, level: 1, parentId: null },
    { id: childId, level: 2, parentId },
  ]);
  expect(after.categories.filter((item) => item.id !== parentId && item.id !== childId)).toEqual(before.categories);
  const mutationIds = new Set<string>(changes.map((change) => change.mutation_id));
  const events = after.events.filter((item) => item.mutationId !== null && mutationIds.has(item.mutationId));
  expect(events).toHaveLength(2);
  expect(events.map((item) => (item.payload as { level: number }).level)).toEqual([1, 2]);
  expect(after.events.filter((item) => item.mutationId === null || !mutationIds.has(item.mutationId))).toEqual(
    before.events,
  );
  const replay = await push(session, changes);
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().outcomes.map((item: { status: string }) => item.status)).toEqual(['ignored', 'ignored']);
  expect(replay.json().outcomes.map((item: { change_id: string }) => item.change_id)).toEqual(
    result.json().outcomes.map((item: { change_id: string }) => item.change_id),
  );
  expect(await catalogSnapshot(session)).toEqual(after);
});

it.each(['1', '2', '01', '1.0', ' 1 ', '3', true, [1]])('非法层级值%j不能隐式转换或写入', async (level) => {
  const session = await register();
  const before = await catalogSnapshot(session);
  const id = randomUUID();
  const goodId = randomUUID();
  const changes = [categoryWire(id, level), categoryWire(goodId, 1)];
  const result = await push(session, changes);
  if (level === '3') {
    expect(result.statusCode, result.body).toBe(400);
    expect(result.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await catalogSnapshot(session)).toEqual(before);
    return;
  }
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().outcomes.map((item: { status: string }) => item.status)).toEqual(['invalid', 'accepted']);
  expect(result.json().outcomes[0]).toMatchObject({ code: 'INVALID_CATEGORY_LEVEL', message: '分类层级无效' });
  expect(result.json().outcomes[1]).not.toHaveProperty('code');
  expect(await prisma.category.count({ where: { ownerId: session.user.user_id, id } })).toBe(0);
  expect(await prisma.syncChange.count({ where: { userId: session.user.user_id, entityId: id } })).toBe(0);
  const after = await catalogSnapshot(session);
  expect(after.categories.filter((item) => item.id !== goodId)).toEqual(before.categories);
  expect(after.categories.filter((item) => item.id === goodId)).toMatchObject([{ id: goodId, level: 1 }]);
  const acceptedMutationId = changes[1]!.mutation_id;
  expect(after.events.filter((item) => item.mutationId === acceptedMutationId)).toHaveLength(1);
  expect(after.events.filter((item) => item.mutationId !== acceptedMutationId)).toEqual(before.events);
});

it('排序字段同样拒绝字符串输入', async () => {
  const session = await register();
  const before = await catalogSnapshot(session);
  const result = await push(session, [categoryWire(randomUUID(), 1, null, { sort_order: '2' })]);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().outcomes[0]).toMatchObject({
    status: 'invalid',
    code: 'INVALID_CATEGORY_SORT_ORDER',
    message: '分类排序值超出允许范围',
  });
  expect(await catalogSnapshot(session)).toEqual(before);
});

it.each([
  { name: '父节点尚不可用', level: 2, parentId: randomUUID(), status: 200, code: 'CATEGORY_PARENT_UNAVAILABLE' },
  { name: '一级带父节点', level: 1, parentId: randomUUID(), status: 200, code: 'CATEGORY_PARENT_FORBIDDEN' },
  { name: '二级缺少父节点', level: 2, parentId: null, status: 200, code: 'CATEGORY_PARENT_REQUIRED' },
  { name: '父身份格式无效', level: 2, parentId: 'not-a-uuid', status: 400, code: 'VALIDATION_ERROR' },
])('同步HTTP按真实父关系区分拒绝：$name', async (scenario) => {
  try {
    const session = await register();
    const before = await catalogSnapshot(session);
    const id = randomUUID();
    const result = await push(session, [categoryWire(id, scenario.level, scenario.parentId)]);
    expect(result.statusCode, result.body).toBe(scenario.status);
    if (scenario.status === 400) {
      // 无效 UUID 在 HTTP 结构校验边界被拒绝，整批请求不会产生可自动恢复的单项回执。
      expect(result.json()).toMatchObject({ code: scenario.code });
      expect(result.json()).not.toHaveProperty('outcomes');
    } else {
      expect(result.json()).toMatchObject({
        outcomes: [{ entity_id: id, status: 'invalid', change_id: null, code: scenario.code }],
      });
    }
    expect(await catalogSnapshot(session)).toEqual(before);
  } catch (cause) {
    throw new Error(`同步HTTP父关系错误码验证失败：${scenario.name}`, { cause });
  }
});
