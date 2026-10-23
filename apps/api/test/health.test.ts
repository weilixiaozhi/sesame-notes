import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { loadTestApiConfig } from './test-api-config.js';

const apps: Array<ReturnType<typeof buildApp>> = [];

/** 数据库连接立即被拒绝（端口 1）的测试配置：模拟运行期 DB 宕机。 */
const dbDownConfig: ApiConfig = {
  databaseUrl: 'postgresql://sesame:sesame@127.0.0.1:1/sesame_notes',
  jwtSecret: 'test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: '.test-storage',
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

/** 创建测试服务并在用例结束后统一关闭，避免监听器泄漏影响后续测试。 */
function createTestApp(): ReturnType<typeof buildApp> {
  try {
    const app = buildApp({ logger: false, config: loadTestApiConfig() });
    apps.push(app);
    return app;
  } catch (cause) {
    throw new Error('健康检查测试服务构建失败', { cause });
  }
}

/** 关闭当前用例创建的全部服务实例。 */
async function closeTestApps(): Promise<void> {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
}

afterEach(closeTestApps);

describe('GET /api/v1/health', () => {
  it('返回客户端可识别的健康状态和请求编号', async () => {
    const app = createTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      status: 'ok',
      request_id: response.headers['x-request-id'],
    });
  });

  it('把调用方传入的请求编号原样返回，便于跨端排查', async () => {
    const app = createTestApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'mobile-request-1' },
    });

    expect(response.headers['x-request-id']).toBe('mobile-request-1');
    expect(response.json()).toEqual({ status: 'ok', request_id: 'mobile-request-1' });
  });
});

describe('GET /api/v1/health/ready', () => {
  it('数据库宕机时 readiness 返回 503，进程级 liveness 不受影响', async () => {
    const app = buildApp({ logger: false, config: dbDownConfig });
    apps.push(app);

    const ready = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'unavailable', request_id: ready.headers['x-request-id'] });

    // liveness 只证明 HTTP 进程存活，不探测数据库
    const live = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'ok' });
  });
});

describe('OpenAPI 契约', () => {
  it('健康检查与 readiness 均为无需令牌的公开接口', async () => {
    const app = createTestApp();
    await app.ready();

    const paths = app.swagger().paths as Record<string, { get?: { security?: unknown } }>;
    expect(paths['/api/v1/health']?.get?.security).toEqual([]);
    expect(paths['/api/v1/health/ready']?.get?.security).toEqual([]);
  });
});
