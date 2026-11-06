import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

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
});
