import { testStoragePath } from './test-storage-path.js';
import { assertExclusiveTestLocksReleased, testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { uuidV5 } from '../src/shared/uuid.js';
import { recurringOccurrenceId } from '../src/modules/accounting/index.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: process.env.STORAGE_PATH ?? testStoragePath('sync-id'),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

function uuid(): string {
  return randomUUID();
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function api(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
  token?: string,
) {
  const response = await app.inject({
    method,
    url: `${API_BASE}${path}`,
    payload: body,
    headers: {
      ...(token ? bearer(token) : {}),
      // 任何带 body 的方法（POST/PATCH）都必须声明 JSON，否则 Fastify 不解析请求体
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return {
    status: response.statusCode,
    json: (): unknown => (response.body ? JSON.parse(response.body) : null),
    body: response.body,
  };
}

/** 生成每次调用唯一且可登录的手机号（+86 区号，11 位） */
function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

/** 注册独立账号，并返回同步身份验证使用的认证上下文。 */
async function registerUser(): Promise<{ token: string; deviceId: string; userId: string }> {
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone: uniquePhone(),
    password: 'password-123456',
    device: { installation_id: uuid(), name: 'e2e-device', platform: 'e2e' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as { access_token: string; device_id: string; user: { user_id: string } };
  return { token: session.access_token, deviceId: session.device_id, userId: session.user.user_id };
}

/** 构造一次账本级 upsert push 的请求体；sync_id 可缺省（首次上云无 binding）。 */
function ledgerPushBody(deviceId: string, ledgerId: string, syncId?: string, updatedAt = '2026-08-22T10:00:00.000Z') {
  return {
    device_id: deviceId,
    changes: [
      {
        mutation_id: uuid(),
        entity_type: 'ledger',
        entity_id: ledgerId,
        ledger_id: ledgerId,
        action: 'upsert',
        updated_at: updatedAt,
        ...(syncId === undefined ? {} : { sync_id: syncId }),
        payload: { name: '同步账本', currency: 'CNY', month_start_day: 1, aa_enabled: false },
      },
    ],
  };
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  try {
    await assertExclusiveTestLocksReleased(prisma, process.env);
  } finally {
    await app.close();
  }
});

describe('Ledger sync_id（同步身份）', () => {
  it('REST 创建云端账本时服务端生成 sync_id（不信任客户端）', async () => {
    const { token } = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/ledgers', { id: ledgerId, name: 'REST 账本' }, token);
    expect(create.status).toBe(201);
    const ledger = create.json() as { id: string; sync_id: string };
    expect(ledger.id).toBe(ledgerId);
    expect(ledger.sync_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const dbRow = await prisma.ledger.findUnique({ where: { id: ledgerId } });
    expect(dbRow?.syncId).toBe(ledger.sync_id);
  });

  it('sync push 首次创建账本（无 sync_id）：服务端生成并随 outcome 返回', async () => {
    const { token, deviceId } = await registerUser();
    const ledgerId = uuid();
    const push = await api('post', '/sync/push', ledgerPushBody(deviceId, ledgerId), token);
    expect(push.status).toBe(200);
    const result = push.json() as {
      outcomes: Array<{ entity_id: string; status: string; sync_id?: string }>;
    };
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.status).toBe('accepted');
    expect(result.outcomes[0]!.sync_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const dbRow = await prisma.ledger.findUnique({ where: { id: ledgerId } });
    expect(dbRow?.syncId).toBe(result.outcomes[0]!.sync_id);
  });

  it('sync push 幂等重放账本创建：ignored outcome 返回首次创建的 sync_id', async () => {
    const { token, deviceId } = await registerUser();
    const ledgerId = uuid();
    const body = ledgerPushBody(deviceId, ledgerId);
    const create = await api('post', '/sync/push', body, token);
    expect(create.status).toBe(200);
    const created = create.json() as { outcomes: Array<{ status: string; sync_id?: string }> };
    expect(created.outcomes[0]!.status).toBe('accepted');
    expect(created.outcomes[0]!.sync_id).toBeDefined();

    // 创建已提交但响应丢失：客户端用同一 mutation 重放，
    // 重放必须返回首次事件的 sync_id，让客户端识别当次创建建立的绑定。
    const replay = await api('post', '/sync/push', body, token);
    expect(replay.status).toBe(200);
    const replayed = replay.json() as { outcomes: Array<{ status: string; sync_id?: string }> };
    expect(replayed.outcomes[0]!.status).toBe('ignored');
    expect(replayed.outcomes[0]!.sync_id).toBe(created.outcomes[0]!.sync_id);
  });

  it('sync push 携带正确 sync_id：正常接受', async () => {
    const { token, deviceId } = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/sync/push', ledgerPushBody(deviceId, ledgerId), token);
    const created = create.json() as { outcomes: Array<{ sync_id?: string }> };
    const syncId = created.outcomes[0]!.sync_id!;
    // 时间戳必须严格晚于首次创建（首次为固定历史时间）：用当前时间保证
    // 在任何机器时钟下都晚于首次，且不会被未来漂移钳制（now ≤ now+5s）
    const push = await api(
      'post',
      '/sync/push',
      ledgerPushBody(deviceId, ledgerId, syncId, new Date().toISOString()),
      token,
    );
    expect(push.status).toBe(200);
    const result = push.json() as { outcomes: Array<{ status: string }> };
    expect(result.outcomes[0]!.status).toBe('accepted');
  });

  it('sync push 携带错误 sync_id：412 SYNC_ID_MISMATCH（含 client/current sync_id）', async () => {
    const { token, deviceId } = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/sync/push', ledgerPushBody(deviceId, ledgerId), token);
    const created = create.json() as { outcomes: Array<{ sync_id?: string }> };
    const currentSyncId = created.outcomes[0]!.sync_id!;
    const staleSyncId = uuid();
    const push = await api('post', '/sync/push', ledgerPushBody(deviceId, ledgerId, staleSyncId), token);
    expect(push.status).toBe(412);
    const body = push.json() as {
      code: string;
      details?: { client_sync_id?: string; current_sync_id?: string };
    };
    expect(body.code).toBe('SYNC_ID_MISMATCH');
    expect(body.details?.client_sync_id).toBe(staleSyncId);
    expect(body.details?.current_sync_id).toBe(currentSyncId);
  });

  it('分类 parent_id 接受确定性 UUIDv5 父分类', async () => {
    const { token, deviceId, userId } = await registerUser();
    // 自定义父子使用确定性 UUIDv5，名称与账号默认目录保持独立。
    const v5ParentId = uuidV5(uuid(), 'parent-category');
    const v5ChildId = uuidV5(v5ParentId, 'child-category');
    const push = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: v5ParentId,
            ledger_id: null,
            action: 'upsert',
            updated_at: '2026-08-22T10:00:00.000Z',
            payload: { name: 'UUIDv5父分类', kind: 'expense', level: 1, sort_order: 0, icon: null, parent_id: null },
          },
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: v5ChildId,
            ledger_id: null,
            action: 'upsert',
            updated_at: '2026-08-22T10:00:01.000Z',
            payload: {
              name: 'UUIDv5子分类',
              kind: 'expense',
              level: 2,
              sort_order: 0,
              icon: null,
              parent_id: v5ParentId,
            },
          },
        ],
      },
      token,
    );
    expect(push.status).toBe(200);
    const result = push.json() as { outcomes: Array<{ status: string }> };
    expect(result.outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted']);
    expect(
      await prisma.category.findUnique({ where: { id_ownerId: { id: v5ChildId, ownerId: userId } } }),
    ).toMatchObject({ level: 2, parentId: v5ParentId });
  });

  it('确定性 UUIDv5 分类支持同步删除（tombstone）', async () => {
    const { token, deviceId } = await registerUser();
    const v5CategoryId = uuid().replace(/^([0-9a-f]{8}-[0-9a-f]{4}-)4/, '$15');
    const upsert = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: v5CategoryId,
            ledger_id: null,
            action: 'upsert',
            updated_at: '2026-08-22T10:00:00.000Z',
            payload: { name: '临时分类', kind: 'expense', level: 1, sort_order: 0, icon: null, parent_id: null },
          },
        ],
      },
      token,
    );
    expect(upsert.status).toBe(200);
    const del = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: v5CategoryId,
            ledger_id: null,
            action: 'delete',
            updated_at: '2026-08-22T10:05:00.000Z',
            payload: {},
          },
        ],
      },
      token,
    );
    expect(del.status).toBe(200);
    const outcome = del.json() as { outcomes: Array<{ status: string }> };
    expect(outcome.outcomes[0]!.status).toBe('accepted');
    const row = await prisma.category.findFirst({ where: { id: v5CategoryId } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('user 级实体（分类）push 不校验 sync_id', async () => {
    const { token, deviceId } = await registerUser();
    const categoryId = uuid();
    const push = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: categoryId,
            ledger_id: null,
            action: 'upsert',
            updated_at: '2026-08-22T10:00:00.000Z',
            payload: { name: '用户级同步分类', kind: 'expense', level: 1, sort_order: 0, icon: null, parent_id: null },
          },
        ],
      },
      token,
    );
    expect(push.status).toBe(200);
    expect(push.json()).toMatchObject({ outcomes: [{ status: 'accepted', entity_id: categoryId }] });
  });

  it('分类同步载荷接受确定性 UUIDv5：分类实体与交易 category_id 均放行', async () => {
    const { token, deviceId, userId } = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/sync/push', ledgerPushBody(deviceId, ledgerId), token);
    expect(create.status).toBe(200);
    const created = create.json() as { outcomes: Array<{ sync_id?: string }> };
    const syncId = created.outcomes[0]!.sync_id!;
    // 自定义分类使用确定性 UUIDv5，分类实体与交易引用必须接受同一身份。
    const v5CategoryId = uuidV5(uuid(), 'transaction-category');
    const txnId = uuid();
    const push = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: v5CategoryId,
            ledger_id: null,
            action: 'upsert',
            updated_at: '2026-08-22T10:00:00.000Z',
            payload: { name: 'UUIDv5交易分类', kind: 'expense', level: 1, sort_order: 0, icon: null, parent_id: null },
          },
          {
            mutation_id: uuid(),
            entity_type: 'transaction',
            entity_id: txnId,
            ledger_id: ledgerId,
            sync_id: syncId,
            action: 'upsert',
            updated_at: '2026-08-22T10:01:00.000Z',
            payload: {
              tx_type: 'expense',
              amount: '10.5',
              happened_at: '2026-08-22T10:01:00.000Z',
              note: 'v5 分类交易',
              category_id: v5CategoryId,
              currency_code: 'CNY',
              native_amount: '10.5',
              recurring_id: null,
              payer_member_id: null,
              aa_mode: null,
              splits: null,
              last_edited_at: null,
            },
          },
        ],
      },
      token,
    );
    expect(push.status).toBe(200);
    const result = push.json() as { outcomes: Array<{ status: string }> };
    expect(result.outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted']);
    expect(await prisma.transaction.findFirst({ where: { id: txnId, ownerId: userId } })).toMatchObject({
      categoryId: v5CategoryId,
      categoryName: 'UUIDv5交易分类',
    });
  });

  it('交易与账本实体 id 接受确定性 UUIDv5：CSV 导入与本地副本派生的 id 可上云', async () => {
    const { token, deviceId } = await registerUser();
    // 移动端 CSV 导入按 uuidV5 派生实体 id 以保证重复导入幂等，
    // 本地账本副本同样用 v5；契约必须放行，否则整批推送会被 400 拒绝。
    const v5LedgerId = uuid().replace(/^([0-9a-f]{8}-[0-9a-f]{4}-)4/, '$15');
    const v5TxnId = uuid().replace(/^([0-9a-f]{8}-[0-9a-f]{4}-)4/, '$15');

    const create = await api('post', '/sync/push', ledgerPushBody(deviceId, v5LedgerId), token);
    expect(create.status).toBe(200);
    const created = create.json() as { outcomes: Array<{ status: string; sync_id?: string }> };
    expect(created.outcomes[0]!.status).toBe('accepted');

    const push = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'transaction',
            entity_id: v5TxnId,
            ledger_id: v5LedgerId,
            sync_id: created.outcomes[0]!.sync_id!,
            action: 'upsert',
            updated_at: '2026-08-22T10:02:00.000Z',
            payload: {
              tx_type: 'expense',
              amount: '12.5',
              happened_at: '2026-08-22T10:02:00.000Z',
              note: '导入交易',
              category_id: null,
              currency_code: 'CNY',
              native_amount: '12.5',
              recurring_id: null,
              payer_member_id: null,
              aa_mode: null,
              splits: null,
              last_edited_at: null,
            },
          },
        ],
      },
      token,
    );
    expect(push.status).toBe(200);
    expect((push.json() as { outcomes: Array<{ status: string }> }).outcomes.map((o) => o.status)).toEqual([
      'accepted',
    ]);
  });

  it('UUIDv5 周期模板支持现代同步发生和 REST 历史编辑，普通创建拒绝周期来源', async () => {
    const { token, deviceId } = await registerUser();
    const ledgerId = uuid();
    const created = await api('post', '/ledgers', { id: ledgerId, name: '周期模板引用' }, token);
    expect(created.status).toBe(201);
    const syncId = (created.json() as { sync_id: string }).sync_id;
    const recurringId = uuidV5(ledgerId, 'recurring-template');
    const occurrenceDate = '2026-08-22';
    const pushTransactionId = recurringOccurrenceId(ledgerId, recurringId, occurrenceDate);
    const timestamp = '2026-08-22T10:02:00.000Z';

    // 周期模板先进入同步队列，后续交易沿用相同账本内已确认的实体引用。
    const pushed = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'recurring_transaction',
            entity_id: recurringId,
            ledger_id: ledgerId,
            sync_id: syncId,
            action: 'upsert',
            updated_at: timestamp,
            payload: {
              tx_type: 'expense',
              amount: '12.5',
              currency_code: 'CNY',
              category_id: null,
              note: null,
              frequency: 'daily',
              protocol_version: 1,
              time_zone: 'UTC',
              interval: 1,
              day_of_month: null,
              day_of_week: null,
              month_of_year: null,
              start_date: timestamp,
              end_date: null,
              last_generated_date: null,
              enabled: true,
            },
          },
          {
            mutation_id: uuid(),
            entity_type: 'transaction',
            entity_id: pushTransactionId,
            ledger_id: ledgerId,
            sync_id: syncId,
            action: 'upsert',
            updated_at: timestamp,
            payload: {
              tx_type: 'expense',
              amount: '12.5',
              happened_at: timestamp,
              note: '同步周期交易',
              category_id: null,
              currency_code: 'CNY',
              native_amount: '12.5',
              recurring_id: recurringId,
              occurrence_date: occurrenceDate,
              payer_member_id: null,
              aa_mode: null,
              splits: null,
              last_edited_at: null,
            },
          },
        ],
      },
      token,
    );
    expect(pushed.status).toBe(200);
    expect(pushed.json()).toMatchObject({ outcomes: [{ status: 'accepted' }, { status: 'accepted' }] });
    expect(await prisma.transaction.findUnique({ where: { id: pushTransactionId } })).toMatchObject({
      ledgerId,
      recurringId,
    });

    const restTransactionId = uuid();
    const rest = await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: restTransactionId,
        tx_type: 'expense',
        amount: '12.5',
        happened_at: timestamp,
        currency_code: 'CNY',
        native_amount: '12.5',
        recurring_id: recurringId,
      },
      token,
    );
    expect(rest.status).toBe(400);
    expect(rest.json()).toMatchObject({ code: 'RECURRING_GENERATION_REQUIRED' });
    const edited = await api(
      'patch',
      `/ledgers/${ledgerId}/transactions/${pushTransactionId}`,
      {
        base_revision: 1,
        note: '保留 UUIDv5 规则引用',
      },
      token,
    );
    expect(edited.status).toBe(200);
    expect(edited.json()).toMatchObject({ recurring_id: recurringId, occurrence_date: occurrenceDate, revision: 2 });
  });

  it('full 首次返回当前 sync_id，携带该身份再次请求正常返回', async () => {
    const { token } = await registerUser();
    const ledgerId = uuid();
    await api('post', '/ledgers', { id: ledgerId, name: '全量账本' }, token);
    const full = await api('get', `/sync/full?ledger_id=${ledgerId}`, undefined, token);
    expect(full.status).toBe(200);
    const snapshot = full.json() as { ledger: { id: string; sync_id: string } };
    expect(snapshot.ledger.id).toBe(ledgerId);
    expect(snapshot.ledger.sync_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const boundFull = await api(
      'get',
      `/sync/full?ledger_id=${ledgerId}&sync_id=${snapshot.ledger.sync_id}`,
      undefined,
      token,
    );
    expect(boundFull.status).toBe(200);
  });

  it('full 携带错误 sync_id：412 SYNC_ID_MISMATCH，禁止静默覆盖', async () => {
    const { token } = await registerUser();
    const ledgerId = uuid();
    await api('post', '/ledgers', { id: ledgerId, name: '全量账本3' }, token);
    const first = await api('get', `/sync/full?ledger_id=${ledgerId}`, undefined, token);
    const snapshot = first.json() as { ledger: { sync_id: string } };
    const staleSyncId = uuid();
    const full = await api('get', `/sync/full?ledger_id=${ledgerId}&sync_id=${staleSyncId}`, undefined, token);
    expect(full.status).toBe(412);
    const body = full.json() as {
      code: string;
      details?: { client_sync_id?: string; current_sync_id?: string };
    };
    expect(body.code).toBe('SYNC_ID_MISMATCH');
    expect(body.details?.client_sync_id).toBe(staleSyncId);
    expect(body.details?.current_sync_id).toBe(snapshot.ledger.sync_id);
  });
});

describe('/sync/full 一致性快照', () => {
  it('实体集合未包含并发分类时，server_cursor 也不得越过该分类事件', async () => {
    const { token, deviceId, userId } = await registerUser();
    const ledgerId = uuid();
    const created = await api('post', '/ledgers', { id: ledgerId, name: '一致性快照账本' }, token);
    expect(created.status).toBe(201);

    const readerPrisma = new PrismaClient({
      datasourceUrl: DATABASE_URL,
      log: [{ emit: 'event', level: 'query' }],
    });
    const readerApp = buildApp({ logger: false, config, prisma: readerPrisma });
    const writerLocked = Promise.withResolvers<void>();
    const allowWrite = Promise.withResolvers<void>();
    const categoryRead = Promise.withResolvers<void>();
    const categoryId = uuid();
    let writer: Promise<bigint> | undefined;

    readerPrisma.$on('query', (event) => {
      if (/FROM\s+"(?:public"\.)?"categories"/i.test(event.query)) categoryRead.resolve();
    });

    try {
      await readerApp.ready();
      // 写事务先锁住事件表暂停 cursor；分类读取完成后再原子写入分类与事件。
      writer = prisma.$transaction(
        async (tx) => {
          try {
            await tx.$executeRawUnsafe('LOCK TABLE "sync_changes" IN ACCESS EXCLUSIVE MODE');
            writerLocked.resolve();
            await allowWrite.promise;
            await tx.category.create({
              data: {
                id: categoryId,
                ownerId: userId,
                name: '并发分类',
                kind: 'expense',
                updatedByDeviceId: deviceId,
              },
            });
            const change = await tx.syncChange.create({
              data: {
                userId,
                ledgerId: null,
                scope: 'user',
                entityType: 'category',
                entityId: categoryId,
                action: 'upsert',
                mutationId: uuid(),
                payload: { id: categoryId, name: '并发分类' },
                updatedAt: new Date(),
                deviceId,
              },
            });
            return change.changeId;
          } catch (error) {
            writerLocked.reject(error);
            console.error('构造 full 并发写事务失败', { categoryId, error });
            throw error;
          }
        },
        { timeout: 15_000 },
      );
      await writerLocked.promise;

      const full = readerApp.inject({
        method: 'get',
        url: `${API_BASE}/sync/full?ledger_id=${ledgerId}`,
        headers: bearer(token),
      });
      await categoryRead.promise;
      allowWrite.resolve();

      const [response, changeId] = await Promise.all([full, writer]);
      expect(response.statusCode).toBe(200);
      const snapshot = JSON.parse(response.body) as {
        categories: Array<{ id: string }>;
        server_cursor: string;
      };
      const containsCategory = snapshot.categories.some((category) => category.id === categoryId);
      const cursorContainsChange = BigInt(snapshot.server_cursor) >= changeId;
      expect(containsCategory).toBe(cursorContainsChange);
    } catch (error) {
      console.error('验证 full 实体集合与游标一致快照失败', { ledgerId, categoryId, error });
      throw error;
    } finally {
      allowWrite.resolve();
      if (writer) {
        const [result] = await Promise.allSettled([writer]);
        if (result?.status === 'rejected') console.error('清理 full 并发写事务失败', { error: result.reason });
      }
      const [closed] = await Promise.allSettled([readerApp.close()]);
      if (closed?.status === 'rejected') console.error('关闭 full 并发读取应用失败', { error: closed.reason });
    }
  }, 20_000);
});
