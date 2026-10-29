import cookie from '@fastify/cookie';
import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { registerErrorHandler } from '../../shared/errors.js';
import { enforceAdminRouteProtection } from '../admin/index.js';
import { registerAnalyticsRoutes } from './index.js';

const ORIGIN = 'https://admin.analytics.test';
const headers = { origin: ORIGIN, cookie: `__Secure-sesame_admin_session=${'a'.repeat(64)}` };
const apps: FastifyInstance[] = [];

/** 使用真实会话守卫与响应序列化验证只读目录，数据库替身不提供任何分类元数据模型。 */
async function application(permissions = ['analytics:read']) {
  const session = {
    id: 'session',
    tokenHash: 'hash',
    revokedAt: null,
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    admin: {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'analytics_ops',
      displayName: '统计管理员',
      email: null,
      phone: null,
      identityType: 'standard_user',
      groupId: 'group',
      isEnabled: true,
      deletedAt: null,
      version: 1,
      group: {
        id: 'group',
        name: '统计组',
        version: 1,
        isEnabled: true,
        deletedAt: null,
        permissions,
        pageIds: permissions.includes('analytics:read') ? ['analytics'] : [],
      },
    },
  };
  const db = {
    adminSession: { findUnique: vi.fn().mockResolvedValue(session), update: vi.fn().mockResolvedValue({}) },
    productAnalyticsState: {
      findUnique: vi.fn().mockResolvedValue({
        startedAt: new Date('2020-01-01'),
        bannerStartedAt: new Date('2026-10-01'),
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (run: (tx: typeof db) => Promise<unknown>) => run(db));
  const app = Fastify({ logger: false });
  apps.push(app);
  enforceAdminRouteProtection(app);
  app.addSchema(ErrorSchema);
  registerErrorHandler(app);
  await app.register(cookie);
  registerAnalyticsRoutes(app, db as unknown as PrismaClient, { adminOrigins: [ORIGIN] } as ApiConfig);
  await app.ready();
  return { app, db };
}

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } catch (cause) {
    throw new Error('埋点目录测试资源释放失败', { cause });
  }
});

it('埋点目录无需日期即可读取，保留事件身份与平台范围', async () => {
  const { app, db } = await application();
  const response = await app.inject({ method: 'GET', url: '/api/v1/admin/analytics/catalog', headers });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<{ events: Array<Record<string, unknown>> }>();
  expect(result.events.length).toBeGreaterThan(0);
  expect(result.events.find((event) => event.id === 'accounting_transaction_view')).toMatchObject({
    platforms: ['app', 'web'],
  });
  expect(result.events.find((event) => event.id === 'banner_impression')).toMatchObject({
    kind: 'action',
    behavior: 'view',
    platforms: ['app'],
  });
  expect(result.events.find((event) => event.id === 'banner_click')).toMatchObject({
    kind: 'action',
    behavior: 'click',
    platforms: ['app'],
  });
  expect(db.productAnalyticsState.findUnique).not.toHaveBeenCalled();
  expect(db.$queryRaw.mock.calls).toHaveLength(1);
  expect(String(db.$queryRaw.mock.calls[0]![0])).toContain('pg_advisory_xact_lock');
});

it('Banner 列表统计只需要 Banner 读取权限，统计后台权限不能代替入口管理授权', async () => {
  const { app, db } = await application(['banners:read']);
  db.$queryRaw.mockImplementation(async (query) =>
    String(query.sql ?? query).includes('current_banners')
      ? [
          {
            banner_id: 'builtin:fitness-plan-library',
            slot: 'fitness-plan-library',
            source: 'builtin',
            version: 0,
            impressions: 2n,
            clicks: 3n,
          },
          {
            banner_id: 'builtin:fitness-template-library',
            slot: 'fitness-template-library',
            source: 'builtin',
            version: 0,
            impressions: 0n,
            clicks: 0n,
          },
        ]
      : [],
  );
  const url = '/api/v1/admin/banners/statistics?start_date=2026-10-12&end_date=2026-10-12';
  const result = await app.inject({ method: 'GET', url, headers });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({
    scope: 'current',
    items: [
      { impressions: 2, clicks: 3, ctr: 1.5 },
      { impressions: 0, clicks: 0, ctr: null },
    ],
    coverage: { audience: 'authenticated_users', complete: true },
  });
  expect((await app.inject({ method: 'GET', url, headers: { origin: ORIGIN } })).statusCode).toBe(401);
  const denied = await application(['analytics:read']);
  expect((await denied.app.inject({ method: 'GET', url, headers })).statusCode).toBe(403);
});

it('目录和事件分析沿用统计读取权限并拒绝不可信来源和普通用户凭据', async () => {
  const { app } = await application([]);
  expect((await app.inject({ method: 'GET', url: '/api/v1/admin/analytics/catalog', headers })).statusCode).toBe(403);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/admin/analytics/details?start_date=2026-10-12&end_date=2026-10-12',
        headers,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/admin/analytics/catalog',
        headers: { ...headers, origin: 'https://untrusted.test' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/admin/analytics/catalog',
        headers: { origin: ORIGIN, authorization: 'Bearer user-token' },
      })
    ).statusCode,
  ).toBe(401);
});

it('事件分析支持访问、点击和完成筛选，已移除的元数据写入接口不存在', async () => {
  const { app } = await application();
  for (const behavior of ['view', 'click', 'complete']) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/analytics/details?start_date=2026-10-12&end_date=2026-10-12&behavior=${behavior}`,
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).not.toHaveProperty('funnels');
    expect(response.json()).not.toHaveProperty('categories');
  }
  expect(
    (
      await app.inject({
        method: 'GET',
        url: '/api/v1/admin/analytics/details?start_date=2026-10-12&end_date=2026-10-12&behavior=free',
        headers,
      })
    ).statusCode,
  ).toBe(400);
  for (const request of [
    { method: 'POST' as const, url: '/api/v1/admin/analytics/categories' },
    { method: 'PATCH' as const, url: '/api/v1/admin/analytics/categories/accounting' },
    { method: 'DELETE' as const, url: '/api/v1/admin/analytics/categories/accounting' },
    { method: 'PATCH' as const, url: '/api/v1/admin/analytics/definitions/view%3Aaccounting' },
  ])
    expect((await app.inject({ ...request, headers })).statusCode).toBe(404);
});

it('事件分析拒绝不可能的页面、来源端和行为组合，合法来源可正常查询', async () => {
  const { app } = await application();
  const base = '/api/v1/admin/analytics/details?start_date=2026-10-12&end_date=2026-10-12';
  for (const filter of [
    '&platform=web&page_id=accounting.aa_split.editor',
    '&event_name=credentials_save_click&page_id=settings',
    '&event_name=fitness_template_added&behavior=click',
    '&platform=web&event_name=settings_theme_changed',
  ]) {
    const response = await app.inject({ method: 'GET', url: `${base}${filter}`, headers });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain('ANALYTICS_FILTER_INVALID');
  }
  for (const filter of [
    '&platform=web&event_name=fitness_template_added&page_id=fitness.templates.library.detail&behavior=complete',
    '&platform=web&event_name=accounting_transaction_view&page_id=accounting.transaction&behavior=view',
  ]) {
    const response = await app.inject({ method: 'GET', url: `${base}${filter}`, headers });
    expect(response.statusCode, response.body).toBe(200);
  }
});

it('漏斗是受限只读 POST，统计读取权限即可查询且仍要求可信写请求来源', async () => {
  const { app } = await application();
  const body = {
    start_date: '2026-10-12',
    end_date: '2026-10-12',
    steps: ['accounting_view', 'accounting_transaction_created'],
    scope: 'user',
    window_minutes: 30,
  };
  const secured = { ...headers, 'x-admin-request': '1' };
  expect(
    (await app.inject({ method: 'POST', url: '/api/v1/admin/analytics/funnel', headers, payload: body })).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/analytics/funnel',
        headers: { ...secured, origin: 'https://untrusted.test' },
        payload: body,
      })
    ).statusCode,
  ).toBe(403);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/analytics/funnel',
    headers: secured,
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    scope: 'user',
    window_minutes: 30,
    steps: [
      { id: 'accounting_view', users: 0 },
      { id: 'accounting_transaction_created', users: 0 },
    ],
  });
  for (const invalid of [
    { ...body, steps: ['accounting_view'] },
    { ...body, steps: Array.from({ length: 9 }).fill('accounting_view') },
    { ...body, window_minutes: 0 },
    { ...body, window_minutes: 10081 },
    { ...body, steps: ['accounting_view', 'free_event'] },
    { ...body, scope: 'device' },
    { ...body, steps: ['home_view', 'fitness_workout_view'], platform: 'app' },
  ]) {
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/admin/analytics/funnel', headers: secured, payload: invalid }))
        .statusCode,
    ).toBe(400);
  }
});
