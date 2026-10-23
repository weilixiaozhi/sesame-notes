import { testFixtureDatabaseUrl } from './existing-test-database.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { createRateLimit } from '../src/shared/rate-limit.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'security-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: '.e2e-storage',
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: ['http://app.example.com'],
  rateLimitMax: 300,
  authRateLimitMax: 3,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

/** Reserve a nonexistent identity within the exclusive window before failed-login probes. */
async function unusedPhone(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const phone = `139${randomInt(100_000_000).toString().padStart(8, '0')}`;
    if (!(await prisma.user.findUnique({ where: { phoneE164: `+86${phone}` }, select: { id: true } }))) return phone;
  }
  throw new Error('Could not find an unused security-test identity.');
}

describe('认证 Cookie 请求来源', () => {
  let cookieApp: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    cookieApp = buildApp({
      logger: false,
      config: { ...config, authRateLimitMax: 1000, rateLimitMax: 1000 },
      prisma,
    });
    await cookieApp.ready();
  });

  afterAll(async () => {
    await cookieApp.close();
  });

  function credentials() {
    return {
      country_code: '+86',
      phone: `138${crypto.randomUUID().replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`,
      password: 'cookie-origin-test',
      device: { installation_id: crypto.randomUUID(), name: 'origin-test', platform: 'test' },
    };
  }

  it.each([true, false])('完整注册、登录、轮换和退出（浏览器 Cookie：%s）', async (browser) => {
    const body = credentials();
    const prefix = browser ? `${API_BASE}/auth/browser` : `${API_BASE}/auth`;
    const cookieName = 'browser_refresh_token';
    const headers: Record<string, string> = browser ? { origin: config.corsOrigins[0]! } : {};
    const registered = await cookieApp.inject({
      method: 'post',
      url: `${prefix}/register`,
      payload: body,
      headers,
    });
    expect(registered.statusCode).toBe(201);
    if (browser) {
      expect(registered.cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: cookieName, httpOnly: true, sameSite: 'Strict', path: prefix }),
        ]),
      );
      expect(registered.json()).not.toHaveProperty('refresh_token');
    } else {
      expect(registered.cookies).toHaveLength(0);
    }
    const loggedIn = await cookieApp.inject({
      method: 'post',
      url: `${prefix}/login`,
      payload: body,
      headers,
    });
    expect(loggedIn.statusCode).toBe(200);
    const oldToken = browser
      ? loggedIn.cookies.find((cookie) => cookie.name === cookieName)!.value
      : (loggedIn.json().refresh_token as string);
    const refreshed = await cookieApp.inject({
      method: 'post',
      url: `${prefix}/refresh`,
      headers: { ...headers, ...(browser ? { cookie: `${cookieName}=${oldToken}` } : {}) },
      payload: browser ? {} : { refresh_token: oldToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const newToken = browser
      ? refreshed.cookies.find((cookie) => cookie.name === cookieName)!.value
      : (refreshed.json().refresh_token as string);
    expect(newToken).not.toBe(oldToken);
    const loggedOut = await cookieApp.inject({
      method: 'post',
      url: `${prefix}/logout`,
      headers: {
        ...headers,
        authorization: `Bearer ${refreshed.json().access_token}`,
        ...(browser ? { cookie: `${cookieName}=${newToken}` } : {}),
      },
      payload: browser ? {} : { refresh_token: newToken },
    });
    expect(loggedOut.statusCode).toBe(204);
    if (browser) {
      expect(loggedOut.cookies).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: cookieName, value: '', path: prefix })]),
      );
    } else {
      expect(loggedOut.cookies).toHaveLength(0);
    }
    // 旧令牌和退出后的令牌都必须失效，不能只验证 HTTP 成功。
    for (const token of [oldToken, newToken]) {
      const replay = await cookieApp.inject({
        method: 'post',
        url: `${API_BASE}/auth/refresh`,
        payload: { refresh_token: token },
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().code).toBe('INVALID_REFRESH_TOKEN');
    }
  });

  it('拒绝不可信或缺失来源，业务及 Cookie 均无副作用，正文令牌和 Bearer 不得绕过', async () => {
    const body = credentials();
    const registered = await cookieApp.inject({ method: 'post', url: `${API_BASE}/auth/register`, payload: body });
    expect(registered.statusCode).toBe(201);
    const session = registered.json();
    const attemptedRegistration = credentials();
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: session.user.user_id },
      include: { devices: true, refreshTokens: true },
    });
    const deniedHeaders: Record<string, string>[] = [
      { origin: 'http://evil.example.com' },
      { origin: 'http://app.example.com.evil.test' },
      { origin: 'https://app.example.com' },
      { origin: 'http://app.example.com:8080' },
      { origin: 'http://app.example.com/path' },
      { origin: 'http://app.example.com, http://evil.example.com' },
      { origin: 'null' },
      { origin: '' },
      {},
      // Host、代理头及 Referer 不得扩充允许来源。
      { origin: 'http://evil.example.com', host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com' },
      { referer: 'http://app.example.com/' },
    ];
    for (const source of deniedHeaders) {
      for (const [route, payload] of [
        ['register', attemptedRegistration],
        ['login', body],
        ['refresh', { refresh_token: session.refresh_token }],
        ['logout', { refresh_token: session.refresh_token }],
      ] as const) {
        const response = await cookieApp.inject({
          method: 'post',
          url: `${API_BASE}/auth/${route}`,
          payload,
          headers: {
            ...source,
            cookie: `refresh_token=${session.refresh_token}`,
            authorization: `Bearer ${session.access_token}`,
          },
        });
        expect(response.statusCode, `${route}: ${JSON.stringify(source)}`).toBe(403);
        expect(response.json()).toMatchObject({ code: 'ORIGIN_DENIED', request_id: expect.any(String) });
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    }
    // 初次登录/注册尚无 Cookie，也必须拒绝明确的恶意或缺失浏览器来源。
    for (const headers of [{ origin: 'http://evil.example.com' }, { 'sec-fetch-site': 'same-origin' }]) {
      for (const route of ['register', 'login']) {
        const response = await cookieApp.inject({
          method: 'post',
          url: `${API_BASE}/auth/${route}`,
          payload: attemptedRegistration,
          headers,
        });
        expect(response.statusCode).toBe(403);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
    }
    expect(await prisma.user.findUnique({ where: { phoneE164: `+86${attemptedRegistration.phone}` } })).toBeNull();
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: session.user.user_id },
        include: { devices: true, refreshTokens: true },
      }),
    ).toEqual(before);
  });

  it.each([{ corsOrigins: [] }, { corsOrigins: ['null'] }])(
    '白名单 $corsOrigins 不放行浏览器认证',
    async ({ corsOrigins }) => {
      const closedApp = buildApp({ logger: false, config: { ...config, corsOrigins }, prisma });
      try {
        for (const origin of ['http://app.example.com', 'null']) {
          const response = await closedApp.inject({
            method: 'post',
            url: `${API_BASE}/auth/refresh`,
            headers: { origin },
          });
          expect(response.statusCode).toBe(403);
          expect(response.json().code).toBe('ORIGIN_DENIED');
        }
      } finally {
        await closedApp.close();
      }
    },
  );
});

afterAll(async () => {
  await app.close();
});

describe('安全边界（限流与 CORS）', () => {
  it('高基数限流桶受容量约束，窗口过期后可惰性回收', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'));
    try {
      const limiter = createRateLimit(Number.MAX_SAFE_INTEGER, 60_000);
      const reply = { header: vi.fn() } as unknown as FastifyReply;
      await limiter({ ip: 'client-0' } as FastifyRequest, reply);
      vi.advanceTimersByTime(30_000);
      for (let index = 1; index < 10_000; index++) {
        await limiter({ ip: `client-${index}` } as FastifyRequest, reply);
      }

      await expect(limiter({ ip: 'client-overflow' } as FastifyRequest, reply)).rejects.toMatchObject({
        statusCode: 429,
        code: 'RATE_LIMITED',
      });

      vi.advanceTimersByTime(30_001);
      await expect(limiter({ ip: 'client-after-first-expiry' } as FastifyRequest, reply)).resolves.toBeUndefined();

      vi.advanceTimersByTime(30_000);
      await expect(limiter({ ip: 'client-after-staggered-expiry' } as FastifyRequest, reply)).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('登录接口超过阈值返回 429，正常请求不受影响', async () => {
    const phone = await unusedPhone();
    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const response = await app.inject({
        method: 'post',
        url: `${API_BASE}/auth/login`,
        payload: {
          country_code: '+86',
          phone,
          password: 'wrong-password-123',
          device: { installation_id: crypto.randomUUID(), name: 'd', platform: 'd' },
        },
        headers: { 'content-type': 'application/json' },
      });
      results.push(response.statusCode);
    }
    // 前 3 次正常业务响应（401），第 4 次被限流（429）
    expect(results.slice(0, 3)).toEqual([401, 401, 401]);
    expect(results[3]).toBe(429);

    // 非敏感接口不受认证限流影响（429 的 Retry-After 语义另测）
    const health = await app.inject({ method: 'get', url: `${API_BASE}/health` });
    expect(health.statusCode).toBe(200);
  });

  it('代理限流：可信代理的 X-Forwarded-For 各自独立计数，伪造转发头无效', async () => {
    // 可信代理实例：127.0.0.1 可写转发头，两个真实客户端 IP 独立计数
    const trustedApp = buildApp({
      logger: false,
      config: { ...config, trustProxyCidrs: ['127.0.0.1'] },
      prisma,
    });
    await trustedApp.ready();
    // 不同真实 IP 各自计数；手机号维度独立于 IP 桶，两个 XFF 用不同号码避免 phone 桶共享
    const loginPayloads: Record<string, Record<string, unknown>> = {
      '1.1.1.1': {
        country_code: '+86',
        phone: await unusedPhone(),
        password: 'wrong-password-123',
        device: { installation_id: crypto.randomUUID(), name: 'd', platform: 'd' },
      },
      '2.2.2.2': {
        country_code: '+86',
        phone: await unusedPhone(),
        password: 'wrong-password-123',
        device: { installation_id: crypto.randomUUID(), name: 'd', platform: 'd' },
      },
    };
    const fire = async (target: ReturnType<typeof buildApp>, xff: string, count: number) => {
      const results: number[] = [];
      for (let i = 0; i < count; i++) {
        const response = await target.inject({
          method: 'post',
          url: `${API_BASE}/auth/login`,
          payload: loginPayloads[xff],
          headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
        });
        results.push(response.statusCode);
      }
      return results;
    };
    try {
      // 两个不同 X-Forwarded-For 各自达到阈值（互不共享计数）
      expect(await fire(trustedApp, '1.1.1.1', 4)).toEqual([401, 401, 401, 429]);
      expect(await fire(trustedApp, '2.2.2.2', 4)).toEqual([401, 401, 401, 429]);
    } finally {
      await trustedApp.close();
    }

    // 不可信代理实例：转发头被忽略，伪造不同 XFF 仍共享同一计数
    const untrustedApp = buildApp({
      logger: false,
      config: { ...config, trustProxyCidrs: [] },
      prisma,
    });
    await untrustedApp.ready();
    try {
      const results: number[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await untrustedApp.inject({
          method: 'post',
          url: `${API_BASE}/auth/login`,
          payload: loginPayloads['1.1.1.1'],
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': i % 2 === 0 ? '9.9.9.9' : '8.8.8.8',
          },
        });
        results.push(response.statusCode);
      }
      // 伪造转发头不产生新计数桶：第 4 次仍被限流
      expect(results).toEqual([401, 401, 401, 429]);
    } finally {
      await untrustedApp.close();
    }
  });
  it('手机号维度限流：同一手机号跨不同 IP 试探也触发 429（摘要入 key，不存明文）', async () => {
    const phoneApp = buildApp({
      logger: false,
      config: { ...config, trustProxyCidrs: ['127.0.0.1'] },
      prisma,
    });
    await phoneApp.ready();
    try {
      const phone = await unusedPhone();
      const results: number[] = [];
      for (let i = 0; i < 4; i++) {
        const response = await phoneApp.inject({
          method: 'post',
          url: `${API_BASE}/auth/login`,
          payload: {
            country_code: '+86',
            phone,
            password: 'wrong-password-123',
            device: { installation_id: crypto.randomUUID(), name: 'd', platform: 'd' },
          },
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `10.0.0.${i + 1}`,
          },
        });
        results.push(response.statusCode);
      }
      // 每个 IP 桶都只有 1 次，但手机号桶累计 4 次 → 第 4 次被限流
      expect(results).toEqual([401, 401, 401, 429]);
    } finally {
      await phoneApp.close();
    }
  });

  it('CORS：白名单来源获得跨域响应头', async () => {
    const response = await app.inject({
      method: 'get',
      url: `${API_BASE}/health`,
      headers: { origin: 'http://app.example.com' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://app.example.com');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('CORS：非白名单来源不获得跨域响应头', async () => {
    const response = await app.inject({
      method: 'get',
      url: `${API_BASE}/health`,
      headers: { origin: 'http://evil.example.com' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS：预检请求按白名单放行', async () => {
    const response = await app.inject({
      method: 'options',
      url: `${API_BASE}/auth/login`,
      headers: {
        origin: 'http://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://app.example.com');
  });
});
