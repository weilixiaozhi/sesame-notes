import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { PrismaClient } from '@prisma/client';

const apps: ReturnType<typeof buildApp>[] = [];
const origin = 'http://localhost:5173';

/** 只验证数据库访问前的 HTTP 边界，显式使用不可达地址避免连接任何用户数据库。 */
function createApp(authRateLimitMax = 10) {
  const app = buildApp({
    logger: false,
    prisma: {
      refreshToken: { findUnique: async () => null },
      $disconnect: async () => undefined,
    } as unknown as PrismaClient,
    config: {
      ...loadConfig({
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
        JWT_SECRET: 'browser-boundary-test-secret-32-bytes',
        STORAGE_PATH: '.test-storage',
      }),
      corsOrigins: [origin],
      authRateLimitMax,
    },
  });
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it('浏览器认证端点强制来源校验并禁止缓存认证响应', async () => {
  const app = createApp();
  for (const path of ['register', 'login', 'refresh', 'logout']) {
    for (const headers of [
      {},
      { origin: 'null' },
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'same-origin' },
    ]) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/auth/browser/${path}`, headers, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.cookies).toHaveLength(0);
    }
  }
});

it('浏览器刷新不会读取请求体或移动端 Cookie 中的刷新令牌', async () => {
  const app = createApp();
  for (const cookie of [undefined, `refresh_token=${'x'.repeat(64)}`]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/browser/refresh',
      headers: { origin, ...(cookie ? { cookie } : {}) },
      payload: { refresh_token: 'x'.repeat(64) },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('REFRESH_TOKEN_REQUIRED');
  }
});

it('移动端与浏览器共享认证限流，切换入口不能扩大尝试额度', async () => {
  const app = createApp(3);
  const paths = [
    '/api/v1/auth/refresh',
    '/api/v1/auth/browser/refresh',
    '/api/v1/auth/refresh',
    '/api/v1/auth/browser/refresh',
  ];
  const statuses: number[] = [];
  for (const path of paths)
    statuses.push(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { origin },
          payload: path.includes('/browser/') ? {} : { refresh_token: 'x'.repeat(64) },
        })
      ).statusCode,
    );
  expect(statuses).toEqual([401, 401, 401, 429]);
});

it('应用刷新要求正文令牌，不从 Cookie 补齐缺失字段', async () => {
  const app = createApp();
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { origin, cookie: `refresh_token=${'x'.repeat(64)}` },
    payload: {},
  });
  expect(response.statusCode).toBe(400);
  expect(response.cookies).toHaveLength(0);
});

it('浏览器 OpenAPI 会话去除刷新令牌，移动端原契约保持必填', async () => {
  const app = createApp();
  await app.ready();
  const document = app.swagger();
  for (const [path, status] of [
    ['register', '201'],
    ['login', '200'],
    ['refresh', '200'],
  ] as const) {
    const browser = document.paths?.[`/api/v1/auth/browser/${path}`]?.post;
    const mobile = document.paths?.[`/api/v1/auth/${path}`]?.post;
    expect(browser?.security).toEqual([]);
    const browserSchema = (
      browser?.responses?.[status] as unknown as {
        content: { 'application/json': { schema: { required: string[]; properties: object } } };
      }
    ).content['application/json'].schema;
    const mobileSchema = (
      mobile?.responses?.[status] as unknown as { content: { 'application/json': { schema: { required: string[] } } } }
    ).content['application/json'].schema;
    expect(browserSchema.required).not.toContain('refresh_token');
    expect(browserSchema.properties).not.toHaveProperty('refresh_token');
    expect(mobileSchema.required).toContain('refresh_token');
  }
});
