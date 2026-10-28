import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { withSyncTransaction } from '../src/shared/sync-transaction.js';

const databaseUrl = testFixtureDatabaseUrl();
const config: ApiConfig = {
  databaseUrl,
  jwtSecret: 'days-test-secret-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2592000,
  storagePath: testStoragePath('days-sync'),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({ logger: false, config, prisma });
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Outcome = {
  status: string;
  sync_id: string;
  revision: number;
  current_revision: number;
  current_deleted: boolean;
  change_id: string;
};
const createdAt = '2026-09-07T00:00:00.000Z';

/** 注册真实账号，以认证边界验证日子私有性。 */
async function register(): Promise<Session> {
  try {
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        country_code: '+86',
        phone: `138${randomInt(100_000_000).toString().padStart(8, '0')}`,
        password: 'days-test-password',
        device: { installation_id: randomUUID(), name: 'days-test', platform: 'test' },
      },
    });
    expect(result.statusCode).toBe(201);
    return result.json<Session>();
  } catch (error) {
    console.error('日子测试注册失败', { error });
    throw error;
  }
}

/** 构造固定请求；重放时直接使用原对象以保留原 mutation 指纹。 */
function change(bookId: string, entity = bookId, options: Record<string, unknown> = {}) {
  return {
    mutation_id: randomUUID(),
    entity_type: entity === bookId ? 'day_book' : 'day_event',
    entity_id: entity,
    ledger_id: null,
    day_book_id: bookId,
    action: 'upsert',
    updated_at: createdAt,
    payload: { name: '日子', created_at: createdAt } as Record<string, unknown>,
    ...options,
  };
}

/** 通过真实 push 路由提交一个 mutation，返回完整 HTTP 状态与结果。 */
async function push(session: Session, mutation: Record<string, unknown>) {
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: { authorization: `Bearer ${session.access_token}` },
      payload: { device_id: session.device_id, changes: [mutation] },
    });
    return { status: response.statusCode, body: response.json<{ outcomes: Outcome[]; code?: string }>() };
  } catch (error) {
    console.error('日子测试推送失败', { error });
    throw error;
  }
}

/** 建立一个已绑定的空本，后续记录写入使用服务端返回的身份。 */
async function book(session: Session) {
  const id = randomUUID();
  const request = change(id);
  const result = await push(session, request);
  expect(result.status).toBe(200);
  expect(result.body.outcomes[0]?.status).toBe('accepted');
  return { id, syncId: result.body.outcomes[0]!.sync_id, request };
}

/** 独立固定向量定义生日记录。 */
function eventPayload() {
  return {
    name: '生日',
    created_at: createdAt,
    category: 'birthday',
    repeat_type: 'yearly',
    statistic_type: 'year',
    countdown_mode: null,
    interval_days: null,
    event: {
      calendar_type: 'solar',
      original_year: 2024,
      original_month: 2,
      original_day: 29,
      is_leap_month: false,
      solar_date: '2024-02-29',
    },
    start: null,
    end: null,
  };
}

/** 按统一分类协议读取当前账号下的同步资源。 */
async function get(session: Session, path: string) {
  try {
    return await app.inject({
      method: 'GET',
      url: `/api/v1/sync/${path}`,
      headers: {
        authorization: `Bearer ${session.access_token}`,
      },
    });
  } catch (error) {
    console.error('日子测试同步资源读取失败', { path, error });
    throw new Error('日子测试同步资源读取失败', { cause: error });
  }
}

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('日子服务端私有本与 CAS', () => {
  it('日子原始类型逐条拒绝，合法空端点和后续记录正常提交', async () => {
    try {
      const owner = await register();
      const cloud = await book(owner);
      const invalidBookId = randomUUID();
      const invalidBook = change(invalidBookId, invalidBookId, { payload: { name: 123, created_at: createdAt } });
      const invalidEvents = [
        { ...eventPayload(), name: 123 },
        { ...eventPayload(), event: { ...eventPayload().event, original_year: '2024' } },
        { ...eventPayload(), event: { ...eventPayload().event, is_leap_month: 'false' } },
      ].map((payload) => change(cloud.id, randomUUID(), { sync_id: cloud.syncId, payload }));
      const valid = change(cloud.id, randomUUID(), { sync_id: cloud.syncId, payload: eventPayload() });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: { authorization: `Bearer ${owner.access_token}` },
        payload: { device_id: owner.device_id, changes: [invalidBook, ...invalidEvents, valid] },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().outcomes).toMatchObject([
        { status: 'invalid', code: 'INVALID_BOOK' },
        ...invalidEvents.map(() => ({ status: 'invalid', code: 'INVALID_DAY_DEFINITION' })),
        { status: 'accepted', revision: 1 },
      ]);
      expect(await prisma.dayBook.findUnique({ where: { id: invalidBookId } })).toBeNull();
      expect(
        await prisma.dayEvent.count({ where: { id: { in: invalidEvents.map((entry) => entry.entity_id) } } }),
      ).toBe(0);
      expect(
        await prisma.syncChange.count({
          where: { mutationId: { in: [invalidBook, ...invalidEvents].map((entry) => entry.mutation_id) } },
        }),
      ).toBe(0);
      const saved = await prisma.dayEvent.findUniqueOrThrow({ where: { id: valid.entity_id } });
      expect(saved).toMatchObject({ eventIsLeapMonth: false, startSolarDate: null, endSolarDate: null, revision: 1 });
      expect(saved.createdAt.toISOString()).toBe(createdAt);
      const malformed = change(cloud.id, randomUUID(), {
        sync_id: cloud.syncId,
        payload: { ...eventPayload(), created_at: '2026-02-30T00:00:00.000Z' },
      });
      const following = change(cloud.id, randomUUID(), { sync_id: cloud.syncId, payload: eventPayload() });
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: { authorization: `Bearer ${owner.access_token}` },
        payload: { device_id: owner.device_id, changes: [malformed, following] },
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json().code).toBe('VALIDATION_ERROR');
      expect(await prisma.dayEvent.count({ where: { id: { in: [malformed.entity_id, following.entity_id] } } })).toBe(
        0,
      );
    } catch (cause) {
      throw new Error('日子原始输入边界与逐条写入隔离验收失败', { cause });
    }
  });

  it('日子创建审计时间精确保留，未来时间不参与写入版本排序', async () => {
    try {
      const owner = await register();
      const cloud = await book(owner);
      const futureCreatedAt = new Date(Date.now() + 86400000).toISOString();
      const mutation = change(cloud.id, randomUUID(), {
        sync_id: cloud.syncId,
        payload: { ...eventPayload(), created_at: futureCreatedAt },
      });
      const accepted = await push(owner, mutation);
      expect(accepted.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 1 });
      const saved = await prisma.dayEvent.findUniqueOrThrow({ where: { id: mutation.entity_id } });
      expect(saved.createdAt.toISOString()).toBe(futureCreatedAt);
      const event = await prisma.syncChange.findFirstOrThrow({ where: { mutationId: mutation.mutation_id } });
      expect(event.payload).toMatchObject({ created_at: futureCreatedAt, revision: 1 });
      const full = await get(owner, `day-books/full?day_book_id=${cloud.id}&sync_id=${cloud.syncId}`);
      expect(full.statusCode, full.body).toBe(200);
      expect(full.json().day_events).toEqual([
        expect.objectContaining({ id: mutation.entity_id, created_at: futureCreatedAt }),
      ]);
      const replay = await push(owner, mutation);
      expect(replay.body.outcomes[0]).toMatchObject({
        status: 'ignored',
        revision: 1,
        change_id: accepted.body.outcomes[0]!.change_id,
      });
      const edited = await push(
        owner,
        change(cloud.id, mutation.entity_id, {
          sync_id: cloud.syncId,
          base_revision: 1,
          payload: { ...eventPayload(), name: '已编辑', created_at: futureCreatedAt },
        }),
      );
      expect(edited.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 2 });
      expect(await prisma.dayEvent.findUniqueOrThrow({ where: { id: mutation.entity_id } })).toMatchObject({
        name: '已编辑',
        createdAt: new Date(futureCreatedAt),
        revision: 2,
      });
    } catch (cause) {
      throw new Error('日子创建时间、快照与重放一致性验收失败', { cause });
    }
  });

  it('账号记账快照包含本人数据及有共享权限 Owner 的分类墓碑', async () => {
    const owner = await register();
    const editor = await register();
    const headers = { authorization: `Bearer ${owner.access_token}` };
    const ledgerId = randomUUID();
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/ledgers', headers, payload: { id: ledgerId, name: '共享' } }))
        .statusCode,
    ).toBe(201);
    const invitation = await app.inject({
      method: 'POST',
      url: `/api/v1/ledgers/${ledgerId}/invites`,
      headers,
      payload: {},
    });
    expect(invitation.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/invites/${invitation.json<{ code: string }>().code}/accept`,
          headers: { authorization: `Bearer ${editor.access_token}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const deletedCategory = await prisma.category.create({
      data: { ownerId: owner.user.user_id, name: '已删共享分类', kind: 'expense', level: 1, deletedAt: new Date() },
    });
    const ownCategory = await prisma.category.create({
      data: { ownerId: editor.user.user_id, name: '本人分类', kind: 'expense', level: 1 },
    });
    const foreignRate = await prisma.exchangeRateOverride.create({
      data: {
        ownerId: owner.user.user_id,
        baseCurrency: 'CNY',
        quoteCurrency: 'USD',
        rate: '0.14',
        deletedAt: new Date(),
      },
    });
    const snapshot = (await get(editor, 'accounting/full')).json<{
      ledger_snapshots: Array<{ ledger: { id: string } }>;
      categories: Array<{ id: string }>;
      category_tombstones: Array<{ id: string; owner_id: string; deleted_at: string }>;
      deleted_exchange_rate_override_ids: string[];
    }>();
    expect(snapshot.ledger_snapshots.map((entry) => entry.ledger.id)).toEqual([ledgerId]);
    expect(snapshot.categories.map((row) => row.id)).toContain(ownCategory.id);
    expect(snapshot.category_tombstones).toContainEqual(
      expect.objectContaining({
        id: deletedCategory.id,
        owner_id: owner.user.user_id,
        deleted_at: expect.any(String),
      }),
    );
    expect(snapshot.deleted_exchange_rate_override_ids).not.toContain(foreignRate.id);
    // 唯一共同账本删除后，历史成员行不能继续授予所有者分类墓碑的读取权限。
    await prisma.ledger.update({ where: { id: ledgerId }, data: { deletedAt: new Date() } });
    const revokedSnapshot = (await get(editor, 'accounting/full')).json<typeof snapshot>();
    expect(revokedSnapshot.category_tombstones).not.toContainEqual(
      expect.objectContaining({ id: deletedCategory.id, owner_id: owner.user.user_id }),
    );
  });

  it('过期快照不能授权云转本机，合法提交仍优先幂等重放且不伪造水位', async () => {
    const owner = await register();
    const cloud = await book(owner);
    const mutation = change(cloud.id, cloud.id, {
      sync_id: cloud.syncId,
      base_revision: 1,
      action: 'delete',
      payload: { expected_full_cursor: '0' },
    });
    const before = (await prisma.syncChange.aggregate({ _max: { changeId: true } }))._max.changeId!;
    const retainedApp = buildApp({
      logger: false,
      config: { ...config, syncRetentionMinCursor: Number(before) + 100 },
      prisma: new PrismaClient({ datasourceUrl: databaseUrl }),
    });
    try {
      await retainedApp.ready();
      const request = {
        method: 'POST' as const,
        url: '/api/v1/sync/push',
        headers: { authorization: `Bearer ${owner.access_token}` },
        payload: { device_id: owner.device_id, changes: [mutation] },
      };
      const refused = await retainedApp.inject(request);
      expect(refused.statusCode).toBe(200);
      expect(refused.json().outcomes[0].status).toBe('invalid');
      const invalidSnapshot = await retainedApp.inject({ url: '/api/v1/sync/day-books', headers: request.headers });
      expect(invalidSnapshot.statusCode).toBe(500);
      expect(invalidSnapshot.json().code).toBe('SYNC_RETENTION_INVALID');
      const snapshot = (await get(owner, `day-books/full?day_book_id=${cloud.id}`)).json<{ server_cursor: string }>();
      mutation.payload = { expected_full_cursor: snapshot.server_cursor };
      expect((await push(owner, mutation)).body.outcomes[0]?.status).toBe('accepted');
      const replay = await retainedApp.inject(request);
      expect(replay.json().outcomes[0]).toMatchObject({ status: 'ignored', revision: 2 });
    } finally {
      await retainedApp.close();
    }
  });
  it('同一实体并发编辑只接受一个基线，失败项不改变创建审计字段', async () => {
    const owner = await register();
    const cloud = await book(owner);
    const eventId = randomUUID();
    await push(owner, change(cloud.id, eventId, { sync_id: cloud.syncId, payload: eventPayload() }));
    const responses = await Promise.all(
      ['一', '二'].map((name) =>
        push(
          owner,
          change(cloud.id, eventId, {
            sync_id: cloud.syncId,
            base_revision: 1,
            payload: { ...eventPayload(), name, created_at: '2000-01-01T00:00:00.000Z' },
          }),
        ),
      ),
    );
    expect(responses.map((response) => response.body.outcomes[0]!.status).sort()).toEqual(['accepted', 'conflict']);
    const saved = await prisma.dayEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(saved.revision).toBe(2);
    expect(saved.createdAt.toISOString()).toBe(createdAt);
  });

  it('至今阶段完整同步空结束端点，旧循环倒数保存为单次且数据库禁止循环', async () => {
    const owner = await register();
    const cloud = await book(owner);
    const stageId = randomUUID();
    const stage = {
      ...eventPayload(),
      category: 'stage',
      repeat_type: 'none',
      statistic_type: 'year',
      event: null,
      start: eventPayload().event,
      end: null,
    };
    expect(
      (await push(owner, change(cloud.id, stageId, { sync_id: cloud.syncId, payload: stage }))).body.outcomes[0]
        ?.status,
    ).toBe('accepted');
    const saved = await prisma.dayEvent.findUniqueOrThrow({ where: { id: stageId } });
    expect(saved.startSolarDate?.toISOString().slice(0, 10)).toBe('2024-02-29');
    expect(saved.endSolarDate).toBeNull();
    expect(saved.endCalendarType).toBeNull();
    await expect(
      prisma.dayEvent.update({ where: { id: stageId }, data: { endSolarDate: new Date('2026-09-08') } }),
    ).rejects.toThrow();
    const countdownId = randomUUID();
    const countdown = {
      ...eventPayload(),
      category: 'countdown',
      repeat_type: 'none',
      statistic_type: 'day',
      countdown_mode: 'fixed_date',
    };
    expect(
      (await push(owner, change(cloud.id, countdownId, { sync_id: cloud.syncId, payload: countdown }))).body.outcomes[0]
        ?.status,
    ).toBe('accepted');
    expect((await prisma.dayEvent.findUniqueOrThrow({ where: { id: countdownId } })).repeatType).toBe('none');
    await expect(
      prisma.dayEvent.update({ where: { id: countdownId }, data: { repeatType: 'monthly' } }),
    ).rejects.toThrow();
  });

  it('数据库拒绝半端点、公历假投影、类型错配、无效版本及超长 Unicode 名称', async () => {
    const owner = await register();
    const cloud = await book(owner);
    const eventId = randomUUID();
    await push(owner, change(cloud.id, eventId, { sync_id: cloud.syncId, payload: eventPayload() }));
    for (const data of [
      { eventOriginalMonth: null },
      { eventIsLeapMonth: true },
      { eventOriginalDay: 28 },
      { statisticType: 'bogus' },
      { repeatType: 'monthly' },
      { revision: 0 },
      { name: '😀'.repeat(101) },
    ]) {
      await expect(prisma.dayEvent.update({ where: { id: eventId }, data })).rejects.toThrow();
    }
    await expect(prisma.dayBook.update({ where: { id: cloud.id }, data: { name: '\u0085日子' } })).rejects.toThrow();
    expect((await prisma.dayEvent.findUniqueOrThrow({ where: { id: eventId } })).revision).toBe(1);
  });

  it('目录的本集合和水位属于同一快照，目录后新本仍可由增量发现', async () => {
    const owner = await register();
    const first = await book(owner);
    const readComplete = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delayedPrisma = new PrismaClient({ datasourceUrl: databaseUrl }).$extends({
      query: {
        dayBook: {
          async findMany({ args, query }) {
            try {
              const rows = await query(args);
              readComplete.resolve();
              await release.promise;
              return rows;
            } catch (error) {
              readComplete.reject(error);
              throw error;
            }
          },
        },
      },
    });
    const delayedApp = buildApp({ logger: false, config, prisma: delayedPrisma as unknown as PrismaClient });
    try {
      await delayedApp.ready();
      const pending = delayedApp
        .inject({ url: '/api/v1/sync/day-books', headers: { authorization: `Bearer ${owner.access_token}` } })
        .then((response) => response);
      await readComplete.promise;
      const second = await book(owner);
      release.resolve();
      const directory = (await pending).json<{ day_books: Array<{ id: string }>; server_cursor: string }>();
      expect(directory.day_books.map((row) => row.id)).toEqual([first.id]);
      const full = (await get(owner, `day-books/full?day_book_id=${first.id}`)).json<{ server_cursor: string }>();
      expect(BigInt(full.server_cursor)).toBeGreaterThan(BigInt(directory.server_cursor));
      const pull = (await get(owner, `pull?since=${directory.server_cursor}`)).json<{
        changes: Array<{ entity_id: string }>;
      }>();
      expect(pull.changes.map((row) => row.entity_id)).toContain(second.id);
    } finally {
      release.resolve();
      await delayedApp.close();
    }
  });

  it('未知记录写入故障返回可重试 500 并回滚本次 mutation', async () => {
    const owner = await register();
    const cloud = await book(owner);
    const eventId = randomUUID();
    const failingPrisma = new PrismaClient({ datasourceUrl: databaseUrl }).$extends({
      query: {
        dayEvent: {
          async create() {
            throw new Error('database unavailable');
          },
        },
      },
    });
    const failingApp = buildApp({ logger: false, config, prisma: failingPrisma as unknown as PrismaClient });
    try {
      await failingApp.ready();
      const mutation = change(cloud.id, eventId, { sync_id: cloud.syncId, payload: eventPayload() });
      const response = await failingApp.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        headers: { authorization: `Bearer ${owner.access_token}` },
        payload: { device_id: owner.device_id, changes: [mutation] },
      });
      expect(response.statusCode).toBe(500);
      expect(await prisma.dayEvent.findUnique({ where: { id: eventId } })).toBeNull();
      expect(
        await prisma.syncChange.findUnique({
          where: { deviceId_mutationId: { deviceId: owner.device_id, mutationId: mutation.mutation_id } },
        }),
      ).toBeNull();
      expect((await push(owner, mutation)).body.outcomes[0]?.status).toBe('accepted');
    } finally {
      await failingApp.close();
    }
  });
  it('空本目录、实体 CAS 和首次结果幂等重放保留原 revision', async () => {
    const owner = await register();
    const cloud = await book(owner);
    const renamed = await push(
      owner,
      change(cloud.id, cloud.id, {
        sync_id: cloud.syncId,
        base_revision: 1,
        // 私有本创建时间不可修改：改名必须携带本子原有的 created_at
        payload: { name: '新名字', created_at: createdAt },
      }),
    );
    expect(renamed.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 2 });
    const replay = await push(owner, cloud.request);
    expect(replay.body.outcomes[0]).toMatchObject({ status: 'ignored', revision: 1, sync_id: cloud.syncId });
    const stale = await push(owner, change(cloud.id, cloud.id, { sync_id: cloud.syncId, base_revision: 1 }));
    expect(stale.body.outcomes[0]).toMatchObject({ status: 'conflict', current_revision: 2 });
    const directory = await get(owner, 'day-books');
    expect(directory.statusCode).toBe(200);
    expect(directory.json().day_books).toEqual([
      expect.objectContaining({ id: cloud.id, name: '新名字', created_at: createdAt }),
    ]);
    const full = await get(owner, `day-books/full?day_book_id=${cloud.id}&sync_id=${cloud.syncId}`);
    expect(full.json().day_events).toEqual([]);
  });

  it('记录禁止跨本搬移；其他账号无法读取、接管或获知本绑定', async () => {
    const owner = await register();
    const stranger = await register();
    const first = await book(owner);
    const second = await book(owner);
    const eventId = randomUUID();
    expect(
      (await push(owner, change(first.id, eventId, { sync_id: first.syncId, payload: eventPayload() }))).body
        .outcomes[0],
    ).toMatchObject({ status: 'accepted', revision: 1 });
    expect(
      (
        await push(
          owner,
          change(second.id, eventId, { sync_id: second.syncId, base_revision: 1, payload: eventPayload() }),
        )
      ).body.outcomes[0]?.status,
    ).toBe('invalid');
    const denied = await get(stranger, `day-books/full?day_book_id=${first.id}`);
    expect(denied.statusCode).toBe(404);
    const takeover = await push(stranger, change(first.id));
    expect(takeover.body.outcomes[0]?.status).toBe('invalid');
    expect(JSON.stringify(takeover.body)).not.toContain(first.syncId);
    expect((await get(stranger, 'day-books')).json().day_books).toEqual([]);
    expect(
      (await get(stranger, 'pull?since=0'))
        .json()
        .changes.filter((row: { day_book_id: string | null }) => row.day_book_id === first.id),
    ).toEqual([]);
  });

  it('转换快照前置条件拦截新增子记录，父删除原子覆盖子墓碑且成功响应可以重放', async () => {
    const owner = await register();
    const cloud = await book(owner);
    const snapshot = (await get(owner, `day-books/full?day_book_id=${cloud.id}`)).json<{ server_cursor: string }>();
    const eventId = randomUUID();
    await push(owner, change(cloud.id, eventId, { sync_id: cloud.syncId, payload: eventPayload() }));
    const refused = await push(
      owner,
      change(cloud.id, cloud.id, {
        sync_id: cloud.syncId,
        base_revision: 1,
        action: 'delete',
        payload: { expected_full_cursor: snapshot.server_cursor },
      }),
    );
    expect(refused.body.outcomes[0]?.status).toBe('invalid');
    expect((await prisma.dayEvent.findUniqueOrThrow({ where: { id: eventId } })).deletedAt).toBeNull();
    const current = (await get(owner, `day-books/full?day_book_id=${cloud.id}`)).json<{ server_cursor: string }>();
    const deletion = change(cloud.id, cloud.id, {
      sync_id: cloud.syncId,
      base_revision: 1,
      action: 'delete',
      payload: { expected_full_cursor: current.server_cursor },
    });
    const accepted = await push(owner, deletion);
    expect(accepted.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 2 });
    expect((await prisma.dayEvent.findUniqueOrThrow({ where: { id: eventId } })).revision).toBe(2);
    expect((await prisma.dayEvent.findUniqueOrThrow({ where: { id: eventId } })).deletedAt).not.toBeNull();
    expect((await push(owner, deletion)).body.outcomes[0]).toMatchObject({
      status: 'ignored',
      revision: 2,
      change_id: accepted.body.outcomes[0]!.change_id,
    });
    expect(
      (
        await push(
          owner,
          change(cloud.id, eventId, { sync_id: cloud.syncId, base_revision: 2, payload: eventPayload() }),
        )
      ).body.outcomes[0]?.status,
    ).toBe('invalid');
  });

  it('缺失删除冲突、错误绑定拒绝，指纹覆盖绑定和原始时间', async () => {
    const owner = await register();
    const cloud = await book(owner);
    const missing = await push(
      owner,
      change(cloud.id, randomUUID(), { sync_id: cloud.syncId, action: 'delete', payload: {} }),
    );
    expect(missing.body.outcomes[0]).toMatchObject({ status: 'conflict', current_revision: 0, current_deleted: true });
    const mismatch = await push(
      owner,
      change(cloud.id, randomUUID(), { sync_id: randomUUID(), payload: eventPayload() }),
    );
    expect(mismatch.status).toBe(412);
    const reused = await push(owner, { ...cloud.request, updated_at: '2026-09-06T00:00:00.000Z' });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('MUTATION_ID_REUSED');
  });

  it('账号记账 full 与零日子目录使用全局已提交水位', async () => {
    const writer = await register();
    await book(writer);
    const empty = await register();
    // 固定断言期间的全局已提交集合，其他并行套件的写入在同一同步锁后等待。
    await withSyncTransaction(prisma, async (tx) => {
      const last = await tx.syncChange.aggregate({ _max: { changeId: true } });
      const directory = await get(empty, 'day-books');
      expect(directory.statusCode).toBe(200);
      expect(directory.json().server_cursor).toBe(last._max.changeId!.toString());
      const accounting = await get(empty, 'accounting/full');
      expect(accounting.statusCode).toBe(200);
      expect(accounting.json()).toMatchObject({ ledger_snapshots: [], server_cursor: last._max.changeId!.toString() });
    });
  });
});
