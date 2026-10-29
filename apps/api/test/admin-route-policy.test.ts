import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { enforceAdminRouteProtection } from '../src/modules/admin/index.js';

const apps: FastifyInstance[] = [];
const registeredGuards = new Map<string, NonNullable<RouteOptions['preHandler']>>();
const config = loadConfig({
  DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
  JWT_SECRET: 'admin-route-policy-test-secret-at-least-32-bytes',
  STORAGE_PATH: 'Temp/admin-route-policy',
});

/** 从正式路由公开的注册信息取得原始守卫，测试不复制或伪造认证策略。 */
beforeAll(async () => {
  const app = buildApp({
    logger: false,
    config,
    prisma: { $disconnect: vi.fn().mockResolvedValue(undefined) } as unknown as PrismaClient,
  });
  app.addHook('onRoute', (route) => {
    if (route.preHandler !== undefined) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registeredGuards.set(`${method} ${route.url}`, route.preHandler);
    }
  });
  try {
    await app.ready();
  } finally {
    await app.close();
  }
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function protectedApp() {
  const app = Fastify({ logger: false });
  enforceAdminRouteProtection(app);
  apps.push(app);
  return app;
}

function guard(key: string) {
  const value = registeredGuards.get(key);
  expect(value, `正式路由缺少守卫：${key}`).toBeDefined();
  return value!;
}

describe('后台路由默认拒绝漏配置', () => {
  it.each(['/api/v1/admin', '/api/v1/admin/new-feature', '/api/v1/admin/auth/new-method'])(
    '未声明独立认证守卫的 %s 不能注册',
    (url) => {
      const app = protectedApp();
      expect(() => app.get(url, async () => ({ ok: true }))).toThrow('独立管理员鉴权守卫');
    },
  );

  it('只有精确 POST 登录入口可以公开，GET 或混合方法不能借用例外', () => {
    const app = protectedApp();
    expect(() => app.post('/api/v1/admin/auth/login', async () => ({ ok: true }))).not.toThrow();
    expect(() => app.get('/api/v1/admin/auth/login', async () => ({ ok: true }))).toThrow('独立管理员鉴权守卫');
    const other = protectedApp();
    expect(() =>
      other.route({
        method: ['POST', 'PUT'],
        url: '/api/v1/admin/auth/login',
        handler: async () => ({ ok: true }),
      }),
    ).toThrow('独立管理员鉴权守卫');
  });

  it('身份查询守卫不能作为无具体权限的后台业务守卫', () => {
    const app = protectedApp();
    expect(() =>
      app.get('/api/v1/admin/new-feature', { preHandler: guard('GET /api/v1/admin/auth/me') }, async () => ({})),
    ).toThrow('具体权限');
  });

  it('用户读取权限不能保护后台写接口', () => {
    const app = protectedApp();
    expect(() =>
      app.post('/api/v1/admin/new-feature', { preHandler: guard('GET /api/v1/admin/users') }, async () => ({})),
    ).toThrow('只读权限');
  });

  it.each(['/api/v1/admin/analytics', '/api/v1/admin/fitness/exercises', '/api/v1/admin/banners'])(
    '新模块只读权限不能保护写接口：%s',
    (path) => {
      const app = protectedApp();
      expect(() =>
        app.post('/api/v1/admin/new-feature', { preHandler: guard(`GET ${path}`) }, async () => ({})),
      ).toThrow('只读权限');
    },
  );

  it('本人改密守卫不能扩展到普通后台功能', () => {
    const app = protectedApp();
    expect(() =>
      app.get('/api/v1/admin/new-feature', { preHandler: guard('POST /api/v1/admin/auth/password') }, async () => ({})),
    ).toThrow('本人权限');
  });

  it('重复的独立身份守卫不能产生含混认证策略', () => {
    const app = protectedApp();
    const original = guard('GET /api/v1/admin/users');
    const hooks = Array.isArray(original) ? original : [original];
    expect(() => app.get('/api/v1/admin/new-feature', { preHandler: [...hooks, ...hooks] }, async () => ({}))).toThrow(
      '独立管理员鉴权守卫',
    );
  });

  it('正确的后台读写守卫和普通业务路径可以注册', () => {
    const app = protectedApp();
    expect(() =>
      app.get('/api/v1/admin/new-read', { preHandler: guard('GET /api/v1/admin/users') }, async () => ({})),
    ).not.toThrow();
    expect(() =>
      app.post(
        '/api/v1/admin/new-write',
        { preHandler: guard('PATCH /api/v1/admin/users/:user_id/disable') },
        async () => ({}),
      ),
    ).not.toThrow();
    expect(() => app.get('/api/v1/administrator', async () => ({}))).not.toThrow();
    expect(() => app.get('/api/v1/health', async () => ({}))).not.toThrow();
  });
});
