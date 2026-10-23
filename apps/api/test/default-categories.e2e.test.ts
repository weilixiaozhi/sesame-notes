import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Static } from '@sinclair/typebox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ensureOwnerMember } from '../src/modules/accounting/index.js';
import { hashPassword } from '../src/modules/auth/index.js';
import type { CategorySchema, LedgerSchema } from '../src/shared/contracts/accounting.js';
import type { PushOutcome, SyncMutationEnvelope } from '../src/shared/sync-mutation.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'default-categories-test-secret-at-least-32-bytes',
      STORAGE_PATH: testStoragePath('default-categories'),
    }),
    authRateLimitMax: 1000,
    rateLimitMax: 1000,
  },
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Category = Static<typeof CategorySchema>;
type Ledger = Static<typeof LedgerSchema>;
const epoch = '1970-01-01T00:00:00.000Z';
const diningId = 'ffec6471-df8b-5bb3-8a05-93ef863ca958';
const breakfastId = '02d2cbc5-0298-5dea-ae85-f4616e0eafc2';
const housingId = 'da377fd1-ecfc-5913-8819-65b13a84925b';

beforeAll(() => app.ready());
afterAll(() => app.close());

/** 注册直接提交完整默认目录，账本仍由用户第一次记账创建。 */
async function register() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'default-categories-password',
      device: { installation_id: randomUUID(), name: '默认分类验证', platform: 'test' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json<Session>();
  expect(await prisma.category.count({ where: { ownerId: session.user.user_id } })).toBe(61);
  expect(await prisma.ledger.count({ where: { ownerId: session.user.user_id } })).toBe(0);
  return session;
}
/** 直接构造部署前已存在的账号，再经正常登录取得设备，不能删除新注册目录来伪造旧状态。 */
async function legacySession() {
  try {
    const phone = `138${randomInt(100000000).toString().padStart(8, '0')}`;
    const password = 'legacy-default-categories-password';
    await prisma.user.create({
      data: {
        phoneE164: `+86${phone}`,
        sesameNumber: randomInt(100000000, 1000000000).toString(),
        passwordHash: await hashPassword(password),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        country_code: '+86',
        phone,
        password,
        device: { installation_id: randomUUID(), name: '历史账号验证', platform: 'test' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const session = response.json<Session>();
    expect(await prisma.category.count({ where: { ownerId: session.user.user_id } })).toBe(0);
    return session;
  } catch (cause) {
    throw new Error('创建历史分类账号测试夹具失败', { cause });
  }
}
/** 真实认证请求只访问隔离 Fastify 实例。 */
function call(
  session: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: object,
  key?: string,
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${session.access_token}`, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  });
}
/** 创建由服务器原子分配默认分类的账本。 */
async function createLedger(session: Session, name = '默认分类账本') {
  const response = await call(session, 'POST', '/ledgers', { name, currency: 'CNY' });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Ledger>();
}
/** 从当前账本的所有者分类视图读取，保留原始层级和排序字段。 */
async function categories(session: Session, ledger: Pick<Ledger, 'id'>) {
  const response = await call(session, 'GET', `/ledgers/${ledger.id}/categories`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Category[]>();
}
/** 人工命令使用实时云基线和本次固定UUID；设备时间不能替代CAS。 */
async function mutateCategory(
  session: Session,
  ledger: Pick<Ledger, 'id'>,
  id: string,
  method: 'PATCH' | 'DELETE',
  payload?: object,
) {
  const current = (await categories(session, ledger)).find((row) => row.id === id);
  expect(current).toBeDefined();
  const key = randomUUID();
  return call(
    session,
    method,
    `/ledgers/${ledger.id}/categories/${id}?expected_version_token=${current!.version_token}`,
    payload,
    key,
  );
}
/** 分类列表接口排序不同；按ID比较完整快照，仍校验全部字段与条目数。 */
function byCategoryId(rows: Category[]) {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}
/** 用手机默认模板的稳定内容指纹校验全部61项，不从生产目录读取预期值。 */
function expectMobileCatalog(rows: Category[]) {
  expect(rows).toHaveLength(61);
  expect(new Set(rows.map((row) => row.id)).size).toBe(61);
  expect(rows.filter((row) => row.level === 1)).toHaveLength(20);
  expect(rows.filter((row) => row.level === 2)).toHaveLength(41);
  expect(rows.find((row) => row.id === diningId)).toMatchObject({
    name: '餐饮',
    level: 1,
    sort_order: 0,
    icon: 'utensils',
    parent_id: null,
  });
  expect(rows.find((row) => row.id === breakfastId)).toMatchObject({
    name: '早餐',
    level: 2,
    sort_order: 0,
    icon: 'sandwich',
    parent_id: diningId,
  });
  const normalized = rows
    .map((row) => [row.id, row.name, row.kind, row.level, row.sort_order, row.parent_id, row.icon])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  expect(createHash('sha256').update(JSON.stringify(normalized)).digest('hex')).toBe(
    'ba0cbddef26f6e75a612e94b714ea8e6b31e63d023eee3610d50121d945a3d88',
  );
}
/** 一次构造完整原命令，重试复用同一个mutation与正文，不补写云基线。 */
function categoryMutation(row: Category, updatedAt: string, name = row.name, baseToken?: string): SyncMutationEnvelope {
  return {
    mutation_id: randomUUID(),
    entity_type: 'category',
    entity_id: row.id,
    ledger_id: null,
    action: 'upsert',
    updated_at: updatedAt,
    payload: {
      name,
      kind: row.kind,
      level: row.level,
      sort_order: row.sort_order,
      icon: row.icon,
      parent_id: row.parent_id,
      ...(baseToken === undefined ? {} : { base_token: baseToken }),
    },
  };
}
/** 推送完整用户级分类命令，使用公开同步包络类型。 */
async function pushCategory(session: Session, change: SyncMutationEnvelope) {
  const response = await call(session, 'POST', '/sync/push', { device_id: session.device_id, changes: [change] });
  expect(response.statusCode, response.body).toBe(200);
  const outcomes = response.json<{ outcomes: PushOutcome[] }>().outcomes;
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ mutation_id: change.mutation_id, entity_id: change.entity_id });
  return outcomes[0]!;
}

/** 直接准备升级前已经存在的空账本，不删除新逻辑产生的默认数据。 */
async function existingEmptyLedger(user: Session) {
  return prisma.$transaction(async (tx) => {
    const ledger = await tx.ledger.create({
      data: { syncId: randomUUID(), ownerId: user.user.user_id, name: '已有空账本', currency: 'CNY' },
    });
    const now = new Date();
    await ensureOwnerMember(tx, ledger.id, user.user.user_id, {
      createdAt: now,
      updatedAt: now,
      updatedByDeviceId: user.device_id,
    });
    return ledger;
  });
}
/** 初始化命令沿用批量分类接口及稳定幂等键。 */
function initialize(user: Session, ledger: Pick<Ledger, 'id'>, key = randomUUID()) {
  return call(
    user,
    'POST',
    `/ledgers/${ledger.id}/categories/add-batch`,
    { items: [], initialize_defaults: true },
    key,
  );
}

describe('账号首次默认分类初始化', () => {
  it('新手机只同步住房首笔账单仍有完整61项，未使用的分类可直接记下一笔且重试不重复', async () => {
    try {
      const user = await register();
      const ledgerId = randomUUID();
      const stamp = '2026-10-15T01:00:00.000Z';
      const ledgerResponse = await call(user, 'POST', '/sync/push', {
        device_id: user.device_id,
        changes: [
          {
            mutation_id: randomUUID(),
            entity_type: 'ledger',
            entity_id: ledgerId,
            ledger_id: ledgerId,
            action: 'upsert',
            updated_at: stamp,
            payload: { name: '手机首次账本', currency: 'CNY', month_start_day: 1, aa_enabled: false },
          },
        ],
      });
      expect(ledgerResponse.statusCode, ledgerResponse.body).toBe(200);
      const ledgerOutcome = ledgerResponse.json<{ outcomes: PushOutcome[] }>().outcomes[0]!;
      expect(ledgerOutcome).toMatchObject({ status: 'accepted', sync_id: expect.any(String) });
      const firstId = randomUUID();
      const firstMutation = randomUUID();
      const firstRequest = {
        device_id: user.device_id,
        changes: [
          {
            mutation_id: firstMutation,
            entity_type: 'transaction',
            entity_id: firstId,
            ledger_id: ledgerId,
            sync_id: ledgerOutcome.sync_id,
            action: 'upsert',
            updated_at: stamp,
            payload: {
              tx_type: 'expense',
              amount: '128.5',
              native_amount: '128.5',
              currency_code: 'CNY',
              happened_at: stamp,
              category_id: housingId,
              note: '住房首笔',
              recurring_id: null,
              payer_member_id: null,
              aa_mode: null,
              splits: [],
              last_edited_at: null,
            },
          },
        ],
      };
      const first = await call(user, 'POST', '/sync/push', firstRequest);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ outcomes: [{ status: 'accepted' }] });
      expectMobileCatalog(await categories(user, { id: ledgerId }));
      const original = await prisma.transaction.findUniqueOrThrow({ where: { id: firstId } });
      expect(original).toMatchObject({ categoryId: housingId, note: '住房首笔' });
      expect(original.amount.toString()).toBe('128.5');

      // 第二笔直接引用此前从未使用的默认分类，不能依赖客户端先上传该分类。
      const second = await call(user, 'POST', '/sync/push', {
        device_id: user.device_id,
        changes: [
          {
            ...firstRequest.changes[0],
            mutation_id: randomUUID(),
            entity_id: randomUUID(),
            payload: {
              ...firstRequest.changes[0]!.payload,
              category_id: breakfastId,
              amount: '15',
              native_amount: '15',
              note: '早餐第二笔',
            },
          },
        ],
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({ outcomes: [{ status: 'accepted' }] });
      const repeated = await call(user, 'POST', '/sync/push', firstRequest);
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(repeated.json<{ outcomes: PushOutcome[] }>().outcomes).toEqual(
        first.json<{ outcomes: PushOutcome[] }>().outcomes.map((outcome) => ({ ...outcome, status: 'ignored' })),
      );
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: firstId } })).toEqual(original);
      expect(await prisma.transaction.count({ where: { ledgerId } })).toBe(2);
      expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(61);
      expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(61);
      const full = await call(user, 'GET', `/sync/full?ledger_id=${ledgerId}`);
      expect(full.statusCode, full.body).toBe(200);
      expectMobileCatalog(full.json<{ categories: Category[] }>().categories);
    } catch (cause) {
      throw new Error('手机首笔住房与后续未使用分类同步回归失败', { cause });
    }
  });

  it('注册生成手机61项完整目录，按父先子后写用户级同步事件并可full/pull读取', async () => {
    const user = await register();
    const ledger = await createLedger(user);
    const rows = await categories(user, ledger);
    expectMobileCatalog(rows);
    expect(rows.every((row) => row.updated_at === epoch)).toBe(true);
    const events = await prisma.syncChange.findMany({
      where: { userId: user.user.user_id, entityType: 'category' },
      orderBy: { changeId: 'asc' },
    });
    expect(events).toHaveLength(61);
    const seen = new Set<string>();
    for (const event of events) {
      expect(event).toMatchObject({ scope: 'user', ledgerId: null, action: 'upsert', deviceId: user.device_id });
      const row = rows.find((row) => row.id === event.entityId)!;
      expect(event.payload).toEqual(row);
      if (row.parent_id) expect(seen.has(row.parent_id)).toBe(true);
      expect(seen.has(row.id)).toBe(false);
      seen.add(row.id);
    }
    const full = await call(user, 'GET', `/sync/full?ledger_id=${ledger.id}`);
    expect(full.statusCode, full.body).toBe(200);
    expectMobileCatalog(full.json<{ categories: Category[] }>().categories);
    const pull = await call(user, 'GET', '/sync/pull?since=0&limit=1000');
    expect(pull.statusCode, pull.body).toBe(200);
    const changes = pull
      .json<{ changes: Array<{ entity_type: string; payload: Category }> }>()
      .changes.filter((change) => change.entity_type === 'category');
    expectMobileCatalog(changes.map((change) => change.payload));
  });

  it('同账号并发创建两个账本保持注册目录及61条事件唯一', async () => {
    const user = await register();
    const [first, second] = await Promise.all([createLedger(user, '并发甲'), createLedger(user, '并发乙')]);
    expect(first.id).not.toBe(second.id);
    expectMobileCatalog(await categories(user, first));
    expect(await categories(user, second)).toEqual(await categories(user, first));
    expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(61);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(61);
  });

  it('再次创建账本保留用户改名、图标、顺序及主动删除墓碑', async () => {
    const user = await register();
    const first = await createLedger(user);
    const changed = await mutateCategory(user, first, diningId, 'PATCH', {
      name: '我的三餐',
      icon: 'wallet',
      sort_order: 40,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const deleted = await mutateCategory(user, first, breakfastId, 'DELETE');
    expect(deleted.statusCode, deleted.body).toBe(204);
    const before = await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } });
    const count = await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } });
    const initialized = await initialize(user, first);
    expect(initialized.statusCode, initialized.body).toBe(200);
    expect(byCategoryId(initialized.json<Category[]>())).toEqual(byCategoryId(await categories(user, first)));
    const second = await createLedger(user, '第二本');
    expect(await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(count);
    const visible = await categories(user, second);
    expect(visible).toHaveLength(60);
    expect(visible.find((row) => row.id === diningId)).toMatchObject({
      name: '我的三餐',
      icon: 'wallet',
      sort_order: 40,
    });
    expect(visible.some((row) => row.id === breakfastId)).toBe(false);
  });

  it('只有删除墓碑的既有账号仍保持空目录，不因新建账本复活默认值', async () => {
    const user = await legacySession();
    const id = randomUUID();
    const deletedAt = new Date('2026-09-01T00:00:00.000Z');
    await prisma.category.create({
      data: {
        id,
        ownerId: user.user.user_id,
        name: '用户已删分类',
        kind: 'expense',
        level: 1,
        deletedAt,
        updatedAt: deletedAt,
      },
    });
    const ledger = await createLedger(user);
    expect(await categories(user, ledger)).toEqual([]);
    expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(1);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(0);
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id, ownerId: user.user.user_id } } }))
        .deletedAt,
    ).toEqual(deletedAt);
  });

  it.each(['custom', 'partial'] as const)('已有%s目录不自动补齐或覆盖用户内容', async (mode) => {
    const user = await legacySession();
    const id = mode === 'partial' ? diningId : randomUUID();
    const record = await prisma.category.create({
      data: {
        id,
        ownerId: user.user.user_id,
        name: mode === 'custom' ? '餐饮' : '用户自己配置',
        kind: 'expense',
        level: 1,
        sortOrder: 18,
        icon: 'wallet',
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    const ledger = await createLedger(user);
    const visible = await categories(user, ledger);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ id, name: record.name });
    expect(visible.some((row) => row.id === diningId)).toBe(mode === 'partial');
    expect(
      await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id, ownerId: user.user.user_id } } }),
    ).toEqual(record);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(0);
  });

  it('既有同名分类保持独立身份，重复初始化和新账本不认领或重种官方分类', async () => {
    const user = await register();
    const first = await createLedger(user);
    const customId = randomUUID();
    try {
      // 既有同名目录保留独立 UUID，初始化只检查默认身份，不按显示名称认领用户数据。
      await prisma.category.create({
        data: {
          id: customId,
          ownerId: user.user.user_id,
          name: '餐饮',
          kind: 'expense',
          level: 1,
          icon: 'wallet',
        },
      });
    } catch (cause) {
      console.error('构造既有同名分类测试数据失败', cause);
      throw new Error('既有同名分类测试数据初始化失败', { cause });
    }
    const rows = await categories(user, first);
    expect(rows).toHaveLength(62);
    expectMobileCatalog(rows.filter((row) => row.id !== customId));
    expect(rows.filter((row) => row.name === '餐饮').map((row) => row.id)).toEqual(
      expect.arrayContaining([diningId, customId]),
    );
    expect(rows.filter((row) => row.name === '餐饮')).toHaveLength(2);
    const before = await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } });
    const count = await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } });
    const initialized = await initialize(user, first);
    expect(initialized.statusCode, initialized.body).toBe(200);
    expect(byCategoryId(initialized.json<Category[]>())).toEqual(byCategoryId(rows));
    const second = await createLedger(user, '同名分类的第二本');
    expect(await categories(user, second)).toEqual(rows);
    expect(await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(count);
    expect(await prisma.categoryConflict.count({ where: { ownerId: user.user.user_id } })).toBe(0);
  });

  it('账本主键冲突导致整笔创建失败时分类与同步事件一起回滚', async () => {
    const owner = await register();
    const occupied = await createLedger(owner);
    const user = await legacySession();
    const failed = await call(user, 'POST', '/ledgers', { id: occupied.id, name: '失败不能残留分类' });
    expect(failed.statusCode, failed.body).toBe(500);
    expect(failed.json()).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
    expect(await prisma.ledger.count({ where: { ownerId: user.user.user_id } })).toBe(0);
    expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(0);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id } })).toBe(0);
    expectMobileCatalog(await categories(user, await createLedger(user, '重试成功')));
  });

  it('加入共享账本只读取所有者目录，不为受邀账号初始化或修改所有者目录', async () => {
    const owner = await register();
    const ledger = await createLedger(owner);
    const guest = await legacySession();
    const invitation = await call(owner, 'POST', `/ledgers/${ledger.id}/invites`, {});
    expect(invitation.statusCode, invitation.body).toBe(201);
    const joined = await call(guest, 'POST', `/invites/${invitation.json<{ code: string }>().code}/accept`);
    expect(joined.statusCode, joined.body).toBe(200);
    expectMobileCatalog(await categories(guest, ledger));
    expect(await prisma.category.count({ where: { ownerId: guest.user.user_id } })).toBe(0);
    expect(await prisma.category.count({ where: { ownerId: owner.user.user_id } })).toBe(61);
    expect((await initialize(guest, ledger)).statusCode).toBe(403);
  });

  it('不同账号使用相同稳定ID但不共享改名与删除状态', async () => {
    const first = await register();
    const second = await register();
    const firstLedger = await createLedger(first);
    const secondLedger = await createLedger(second);
    expect((await mutateCategory(first, firstLedger, diningId, 'PATCH', { name: '只有甲的名称' })).statusCode).toBe(
      200,
    );
    expect((await mutateCategory(first, firstLedger, breakfastId, 'DELETE')).statusCode).toBe(204);
    expectMobileCatalog(await categories(second, secondLedger));
    expect(
      await prisma.category.count({
        where: { id: diningId, ownerId: { in: [first.user.user_id, second.user.user_id] } },
      }),
    ).toBe(2);
  });

  it('无基线旧种子只建不可见候选，未来时间不能绕过CAS，旧设备时间的正确基线编辑仍保存', async () => {
    const user = await register();
    const ledger = await createLedger(user);
    const rows = await categories(user, ledger);
    const parent = rows.find((row) => row.id === diningId)!;
    const child = rows.find((row) => row.id === breakfastId)!;
    const renamed = await mutateCategory(user, ledger, diningId, 'PATCH', { name: '用户已经改名' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await mutateCategory(user, ledger, breakfastId, 'DELETE')).statusCode).toBe(204);
    const before = await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } });
    const count = await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } });
    const oldParent = categoryMutation(parent, epoch);
    const oldChild = categoryMutation(child, epoch);
    const parentOutcome = await pushCategory(user, oldParent);
    const childOutcome = await pushCategory(user, oldChild);
    expect(parentOutcome).toMatchObject({
      status: 'conflict',
      change_id: null,
      category_conflict: {
        category_id: diningId,
        source_mutation_id: oldParent.mutation_id,
        local_payload: { name: parent.name },
        cloud_snapshot: { id: diningId, name: '用户已经改名' },
      },
    });
    expect(childOutcome).toMatchObject({
      status: 'conflict',
      change_id: null,
      category_conflict: {
        category_id: breakfastId,
        source_mutation_id: oldChild.mutation_id,
        cloud_snapshot: { id: breakfastId, deleted_at: expect.any(String) },
      },
    });
    expect(await pushCategory(user, oldParent)).toEqual(parentOutcome);
    expect(await pushCategory(user, oldChild)).toEqual(childOutcome);
    expect(await prisma.categoryConflict.count({ where: { ownerId: user.user.user_id } })).toBe(2);

    const futureWithoutBase = categoryMutation(parent, '2100-01-01T00:00:00.000Z', '未来时间不能替代基线');
    const futureOutcome = await pushCategory(user, futureWithoutBase);
    expect(futureOutcome).toMatchObject({
      status: 'conflict',
      change_id: null,
      category_conflict: { category_id: diningId, source_mutation_id: futureWithoutBase.mutation_id },
    });
    expect(await pushCategory(user, futureWithoutBase)).toEqual(futureOutcome);
    expect(await prisma.categoryConflict.count({ where: { ownerId: user.user.user_id } })).toBe(3);
    expect(await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(count);
    const visible = await categories(user, ledger);
    expect(visible).toHaveLength(60);
    expect(visible.filter((row) => row.id === diningId)).toHaveLength(1);
    expect(visible.find((row) => row.id === diningId)?.name).toBe('用户已经改名');
    expect(visible.some((row) => row.id === breakfastId)).toBe(false);

    const current = visible.find((row) => row.id === diningId)!;
    const edit = categoryMutation(current, epoch, '手机真正的新修改', current.version_token);
    expect(await pushCategory(user, edit)).toMatchObject({
      status: 'accepted',
      change_id: expect.any(String),
      category_state: { id: diningId, name: '手机真正的新修改', deleted_at: null },
    });
    const after = await categories(user, ledger);
    expect(after).toHaveLength(60);
    expect(after.filter((row) => row.id === diningId)).toHaveLength(1);
    const edited = after.find((row) => row.id === diningId)!;
    expect(edited.name).toBe('手机真正的新修改');
    expect(Date.parse(edited.updated_at)).toBeGreaterThan(Date.parse(current.updated_at));
    expect(edited.version_token).not.toBe(current.version_token);
    expect(after.some((row) => row.id === breakfastId)).toBe(false);
    expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(61);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(
      count + 1,
    );
  });

  it('升级前空账本GET不写数据，显式初始化和丢回执重试只产生一次61项', async () => {
    const user = await legacySession();
    const ledger = await existingEmptyLedger(user);
    expect(await categories(user, ledger)).toEqual([]);
    expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(0);
    const key = randomUUID();
    const [first, concurrent] = await Promise.all([initialize(user, ledger, key), initialize(user, ledger)]);
    expect(first.statusCode, first.body).toBe(200);
    expectMobileCatalog(first.json<Category[]>());
    expect(concurrent.statusCode, concurrent.body).toBe(200);
    expect(concurrent.json()).toEqual(first.json());
    const repeated = await initialize(user, ledger, key);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toEqual(first.json());
    expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(61);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(61);
  });

  it('已有空账本初始化遇墓碑保持空，重复新命令也不复活；禁止初始化夹带分类', async () => {
    const user = await legacySession();
    const ledger = await existingEmptyLedger(user);
    await prisma.category.create({
      data: {
        id: diningId,
        ownerId: user.user.user_id,
        name: '已删除',
        kind: 'expense',
        level: 1,
        deletedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    for (let index = 0; index < 2; index++) {
      const response = await initialize(user, ledger);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual([]);
    }
    expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(1);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id, entityType: 'category' } })).toBe(0);
    const invalid = await call(
      user,
      'POST',
      `/ledgers/${ledger.id}/categories/add-batch`,
      {
        initialize_defaults: true,
        items: [{ id: randomUUID(), name: '夹带', kind: 'expense', level: 1 }],
      },
      randomUUID(),
    );
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(await prisma.category.count({ where: { ownerId: user.user.user_id } })).toBe(1);
  });
});
