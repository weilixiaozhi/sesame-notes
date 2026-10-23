import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate } from './guards.js';
import { enforceUserRouteProtection } from './route-policy.js';

const apps: FastifyInstance[] = [];

/** 注册策略测试不连接数据库，只构造真实守卫检查函数身份。 */
function createApp(): FastifyInstance {
  try {
    const app = Fastify({ logger: false });
    apps.push(app);
    enforceUserRouteProtection(app);
    return app;
  } catch (cause) {
    throw new Error('用户路由策略夹具构建失败', { cause });
  }
}

/** 所有只装配的实例也必须关闭，避免用例共享资源。 */
async function closeApps(): Promise<void> {
  try {
    for (const app of apps.splice(0)) await app.close();
  } catch (cause) {
    throw new Error('用户路由策略夹具关闭失败', { cause });
  }
}
afterEach(closeApps);

describe('普通用户注册期鉴权门禁', () => {
  it('遗漏、伪装或重复守卫在路由注册时失败', () => {
    const apiRoot = createApp();
    expect(() => apiRoot.get('/api/v1', async () => ({}))).toThrow(/路由鉴权声明无效/);
    const missing = createApp();
    expect(() => missing.get('/api/v1/private', async () => ({}))).toThrow(/路由鉴权声明无效/);
    const spoofed = createApp();
    const fake = Object.assign(async () => {}, { authenticated: true, nameHint: 'authenticate' });
    expect(() => spoofed.get('/api/v1/private', { preHandler: fake }, async () => ({}))).toThrow(/路由鉴权声明无效/);
    const duplicate = createApp();
    const guard = authenticate({} as ApiConfig, {} as PrismaClient);
    expect(() => duplicate.get('/api/v1/private', { preHandler: [guard, guard] }, async () => ({}))).toThrow(
      /路由鉴权声明无效/,
    );
  });

  it('真实守卫可以注册，公开方法白名单不泄漏到其他写请求', async () => {
    const app = createApp();
    app.get('/api/v1/private', { preHandler: authenticate({} as ApiConfig, {} as PrismaClient) }, async () => ({}));
    app.get('/api/v1/health', async () => ({}));
    app.post('/api/v1/auth/login', async () => ({}));
    await app.ready();
    expect(app.hasRoute({ method: 'HEAD', url: '/api/v1/health' })).toBe(true);
    const write = createApp();
    expect(() => write.post('/api/v1/health', async () => ({}))).toThrow(/路由鉴权声明无效/);
    const wrongVerb = createApp();
    expect(() => wrongVerb.get('/api/v1/auth/login', async () => ({}))).toThrow(/路由鉴权声明无效/);
  });

  it('隐藏业务接口同样受保护，WebSocket标记只允许既有握手路径', async () => {
    const hidden = createApp();
    expect(() => hidden.get('/api/v1/hidden', { schema: { hide: true } }, async () => ({}))).toThrow(
      /路由鉴权声明无效/,
    );
    const websocket = createApp();
    websocket.get(
      '/api/v1/ws',
      { websocket: true, config: { userAuthentication: 'single-use-websocket-ticket' } },
      async () => {},
    );
    await websocket.ready();
    const borrowed = createApp();
    expect(() =>
      borrowed.get(
        '/api/v1/private',
        { websocket: true, config: { userAuthentication: 'single-use-websocket-ticket' } },
        async () => {},
      ),
    ).toThrow(/路由鉴权声明无效/);
    const missingMarker = createApp();
    expect(() => missingMarker.get('/api/v1/ws', { websocket: true }, async () => {})).toThrow(/路由鉴权声明无效/);
  });
});
