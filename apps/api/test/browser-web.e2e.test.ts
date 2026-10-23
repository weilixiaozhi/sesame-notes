import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { fitnessPlan, fitnessTemplate, fitnessWorkout } from './fitness-fixtures.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const databaseUrl = testFixtureDatabaseUrl();
const origin = 'http://localhost:5173';
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'browser-tests-only-secret-at-least-32-bytes',
      STORAGE_PATH: '.browser-test-storage',
    }),
    corsOrigins: [origin],
    authRateLimitMax: 10000,
    rateLimitMax: 10000,
  },
});
type Session = { access_token: string; refresh_token?: string; device_id: string; user: { user_id: string } };
type Page = { items: Array<{ id: string; revision: number }>; next_cursor: string | null };
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 每条用例创建独立账号，避免使用任何现有用户的数据。 */
function credentials() {
  return {
    country_code: '+86',
    phone: `139${randomInt(100000000).toString().padStart(8, '0')}`,
    password: 'browser-test-password',
    device: { installation_id: randomUUID(), name: '网页测试', platform: 'web' },
  };
}

/** 注册测试账号并提取浏览器可读会话和仅用于模拟浏览器传输的 Cookie。 */
async function register() {
  const payload = credentials();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/browser/register',
    headers: { origin },
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json<Session>();
  expect(session).not.toHaveProperty('refresh_token');
  const cookie = response.cookies.find((value) => value.name === 'browser_refresh_token');
  expect(cookie).toMatchObject({ httpOnly: true, path: '/api/v1/auth/browser', sameSite: 'Strict' });
  expect(cookie).not.toHaveProperty('domain');
  return { payload, session, cookie: `browser_refresh_token=${cookie!.value}` };
}

/** 模拟经过登录鉴权的浏览器查询。 */
function get(path: string, session?: Session) {
  return app.inject({
    method: 'GET',
    url: path,
    headers: session ? { authorization: `Bearer ${session.access_token}` } : {},
  });
}

describe('浏览器独立认证边界', () => {
  it('拒绝缺失、不受信和伪造来源，且 JSON 不能替代 Cookie 刷新', async () => {
    for (const headers of [
      {},
      { origin: 'null' },
      { origin: 'http://evil.example' },
      { 'sec-fetch-site': 'same-origin' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/browser/register',
        headers,
        payload: credentials(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.cookies).toHaveLength(0);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/browser/refresh',
      headers: { origin },
      payload: { refresh_token: 'x'.repeat(64) },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('REFRESH_TOKEN_REQUIRED');
  });

  it('登录、并发刷新和退出均不向脚本暴露刷新令牌，退出后旧令牌全部失效', async () => {
    const account = await register();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/browser/login',
      headers: { origin },
      payload: account.payload,
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).not.toHaveProperty('refresh_token');
    const cookie = `browser_refresh_token=${login.cookies.find((value) => value.name === 'browser_refresh_token')!.value}`;
    const refreshed = await Promise.all(
      [1, 2].map(() =>
        app.inject({ method: 'POST', url: '/api/v1/auth/browser/refresh', headers: { origin, cookie }, payload: {} }),
      ),
    );
    for (const response of refreshed) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).not.toHaveProperty('refresh_token');
      expect(response.cookies[0]!.value).not.toBe(cookie.split('=')[1]);
    }
    const session = refreshed[0]!.json<Session>();
    const newCookie = `browser_refresh_token=${refreshed[0]!.cookies[0]!.value}`;
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/browser/logout',
      headers: { origin, cookie: newCookie, authorization: `Bearer ${session.access_token}` },
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.cookies[0]).toMatchObject({ name: 'browser_refresh_token', value: '', path: '/api/v1/auth/browser' });
    for (const candidate of [cookie, newCookie, `browser_refresh_token=${refreshed[1]!.cookies[0]!.value}`]) {
      const replay = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/browser/refresh',
        headers: { origin, cookie: candidate },
        payload: {},
      });
      expect(replay.statusCode).toBe(401);
    }
  });

  it('移动端原接口仍返回令牌，浏览器 Cookie 不会被原接口消费', async () => {
    const mobile = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: credentials() });
    expect(mobile.statusCode).toBe(201);
    expect(mobile.json().refresh_token).toEqual(expect.any(String));
    const account = await register();
    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { origin, cookie: account.cookie },
      payload: {},
    });
    expect(mismatch.statusCode).toBe(400);
  });
});

/** 对每个资源类型验证分页、权限、删除过滤和代次校验。 */
async function verifyPage(
  path: string,
  session: Session,
  stranger: Session,
  ids: string[],
  remove: (id: string) => Promise<unknown>,
) {
  const first = await get(`${path}?limit=2`, session);
  expect(first.statusCode, first.body).toBe(200);
  const page = first.json<Page>();
  expect(page.items).toHaveLength(2);
  expect(page.next_cursor).toEqual(expect.any(String));
  expect(page.items.every((item) => ids.includes(item.id) && item.revision === 1)).toBe(true);
  await remove(page.items[1]!.id);
  const second = await get(`${path}?limit=2&cursor=${encodeURIComponent(page.next_cursor!)}`, session);
  expect(second.statusCode, second.body).toBe(200);
  const tail = second.json<Page>();
  expect(tail.items).toHaveLength(1);
  expect(tail.next_cursor).toBeNull();
  expect(new Set([...page.items, ...tail.items].map((item) => item.id)).size).toBe(3);
  expect((await get(path, stranger)).statusCode).toBe(404);
  expect((await get(path)).statusCode).toBe(401);
  expect((await get(`${path}?cursor=bad`, session)).statusCode).toBe(400);
  expect((await get(`${path}?limit=201`, session)).statusCode).toBe(400);
  expect((await get(`${path}?sync_id=${randomUUID()}`, session)).statusCode).toBe(412);
}

it('备忘录与纪念日分页读取限制于本人云数据，游标不依赖上一页实体仍存在', async () => {
  const { session } = await register();
  const { session: stranger } = await register();
  const now = new Date('2026-09-01T00:00:00.000Z');
  const memo = await prisma.memoBook.create({
    data: {
      id: randomUUID(),
      ownerId: session.user.user_id,
      name: '测试笔记本',
      type: 'normal',
      createdAt: now,
      updatedAt: now,
    },
  });
  const memoIds: string[] = [];
  for (const deleted of [false, false, false, true]) {
    const id = randomUUID();
    await prisma.memoEntry.create({
      data: {
        id,
        memoBookId: memo.id,
        bookType: 'normal',
        title: '笔记',
        bodyFormat: 'delta_v1',
        body: { ops: [{ insert: '内容\n' }] },
        createdAt: new Date('2026-08-31T00:00:00.000Z'),
        updatedAt: now,
        deletedAt: deleted ? now : null,
      },
    });
    if (!deleted) memoIds.push(id);
  }
  const range = 'start_at=2026-09-01T00%3A00%3A00.000Z&end_at=2026-09-02T00%3A00%3A00.000Z';
  const countsPath = `/api/v1/memo-books/${memo.id}/calendar-counts?${range}`;
  const counts = await get(`${countsPath}&time_zone=America/Los_Angeles`, session);
  expect(counts.statusCode, counts.body).toBe(200);
  expect(counts.json()).toEqual({ days: [{ date: '2026-08-31', count: 3 }] });
  expect((await get(countsPath, stranger)).statusCode).toBe(404);
  expect((await get(`${countsPath}&sync_id=${randomUUID()}`, session)).statusCode).toBe(412);
  expect((await get(`${countsPath}&time_zone=invalid/zone`, session)).statusCode).toBe(400);
  expect((await get(`/api/v1/memo-books/${memo.id}/entries?${range}`, session)).json().items).toHaveLength(3);
  expect(
    (await get(`/api/v1/memo-books/${memo.id}/entries?start_at=2026-09-02T00%3A00%3A00.000Z`, session)).json().items,
  ).toHaveLength(0);
  await verifyPage(`/api/v1/memo-books/${memo.id}/entries`, session, stranger, memoIds, (id) =>
    prisma.memoEntry.update({ where: { id }, data: { deletedAt: now } }),
  );
  const day = await prisma.dayBook.create({ data: { ownerId: session.user.user_id, name: '纪念日', createdAt: now } });
  const dayIds: string[] = [];
  for (const deleted of [false, false, false, true]) {
    const row = await prisma.dayEvent.create({
      data: {
        dayBookId: day.id,
        name: '纪念日',
        category: 'anniversary',
        repeatType: 'yearly',
        statisticType: 'day',
        eventCalendarType: 'solar',
        eventOriginalYear: 2026,
        eventOriginalMonth: 9,
        eventOriginalDay: 1,
        eventIsLeapMonth: false,
        eventSolarDate: now,
        createdAt: now,
        deletedAt: deleted ? now : null,
      },
    });
    if (!deleted) dayIds.push(row.id);
  }
  await verifyPage(`/api/v1/day-books/${day.id}/events`, session, stranger, dayIds, (id) =>
    prisma.dayEvent.update({ where: { id }, data: { deletedAt: now } }),
  );
  await prisma.memoBook.update({ where: { id: memo.id }, data: { deletedAt: now } });
  expect((await get(`/api/v1/memo-books/${memo.id}/entries`, session)).statusCode).toBe(404);
});

it.each([
  ['templates', 'fitness_template', fitnessTemplate],
  ['plans', 'fitness_plan', fitnessPlan],
  ['workouts', 'fitness_workout', fitnessWorkout],
] as const)('健身 %s 独立契约、分页和所有权隔离', async (path, entityType, fixture) => {
  const { session } = await register();
  const { session: stranger } = await register();
  const now = new Date('2026-09-01T00:00:00.000Z');
  const space = await prisma.fitnessSpace.create({
    data: { id: randomUUID(), ownerId: session.user.user_id, name: '健身测试', createdAt: now, updatedAt: now },
  });
  const ids: string[] = [];
  for (const deleted of [false, false, false, true]) {
    const id = randomUUID();
    await prisma.fitnessEntity.create({
      data: {
        id,
        fitnessSpaceId: space.id,
        entityType,
        payload: { ...fixture(), created_at: now.toISOString(), updated_at: now.toISOString() },
        status: entityType === 'fitness_workout' ? 'scheduled' : null,
        createdAt: now,
        updatedAt: now,
        deletedAt: deleted ? now : null,
      },
    });
    if (!deleted) ids.push(id);
  }
  await verifyPage(`/api/v1/fitness-spaces/${space.id}/${path}`, session, stranger, ids, (id) =>
    prisma.fitnessEntity.update({ where: { id }, data: { deletedAt: now, revision: { increment: 1 } } }),
  );
  await prisma.fitnessSpace.update({ where: { id: space.id }, data: { deletedAt: now } });
  expect((await get(`/api/v1/fitness-spaces/${space.id}/${path}`, session)).statusCode).toBe(404);
});

it('凭据卡片按精确整数排序键分页，上一页被删除后游标仍可继续', async () => {
  const { session } = await register();
  const now = new Date('2026-09-01T00:00:00.000Z');
  const book = await prisma.memoBook.create({
    data: {
      id: randomUUID(),
      ownerId: session.user.user_id,
      name: '凭据排序',
      type: 'credentials',
      createdAt: now,
      updatedAt: now,
    },
  });
  const ids: string[] = [];
  for (const orderKey of [9007199254740993n, 10n, 9007199254740994n]) {
    const id = randomUUID();
    await prisma.memoEntry.create({
      data: {
        id,
        memoBookId: book.id,
        bookType: 'credentials',
        title: '卡片',
        bodyFormat: 'fields_v1',
        body: { fields: [{ label: '账号', value: 'test' }] },
        orderKey,
        createdAt: now,
        updatedAt: now,
      },
    });
    ids.push(id);
  }
  const path = `/api/v1/memo-books/${book.id}/entries?limit=2`;
  const first = await get(path, session);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().items.map((item: { id: string }) => item.id)).toEqual([ids[1], ids[0]]);
  await prisma.memoEntry.update({ where: { id: ids[0] }, data: { deletedAt: now } });
  const next = await get(`${path}&cursor=${encodeURIComponent(first.json().next_cursor)}`, session);
  expect(next.statusCode, next.body).toBe(200);
  expect(next.json().items.map((item: { id: string }) => item.id)).toEqual([ids[2]]);
  expect(next.json().next_cursor).toBeNull();
});
