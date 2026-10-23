import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const id = '11111111-1111-4111-8111-111111111111';
const adminId = '22222222-2222-4222-8222-222222222222';
const config = loadConfig({
  DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
  JWT_SECRET: 'auth-failure-test-secret-at-least-32-bytes',
  STORAGE_PATH: 'Temp/auth-failure',
});
const apps: ReturnType<typeof buildApp>[] = [];

/** 只替换安全状态数据库；普通用户与后台分别经过自己的真实认证守卫。 */
async function setup() {
  try {
    const session = {
      id,
      adminId,
      tokenHash: '1'.repeat(64),
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null as Date | null,
      admin: {
        id: adminId,
        username: 'failure_test_admin',
        email: null,
        phone: null,
        displayName: '后台存储故障测试',
        identityType: 'standard_user',
        groupId: id,
        deletedAt: null,
        version: 1,
        group: {
          id,
          name: '故障测试组',
          isEnabled: true,
          deletedAt: null,
          permissions: ['users:read'],
          pageIds: ['users'],
          version: 1,
        },
        isEnabled: true,
      },
    };
    const prisma = {
      serverEpoch: { upsert: vi.fn().mockResolvedValue({ authGeneration: id }) },
      device: { findFirst: vi.fn().mockResolvedValue({ id }) },
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      adminAccount: { findMany: vi.fn().mockResolvedValue([]) },
      adminSession: {
        findUnique: vi.fn().mockResolvedValue(session),
        update: vi.fn().mockResolvedValue(session),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ locked: '' }]),
      $transaction: vi.fn(),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => await fn(prisma));
    const app = buildApp({ logger: false, config, prisma: prisma as unknown as PrismaClient });
    apps.push(app);
    const token = await new SignJWT({
      device_id: id,
      auth_generation: id,
      credential_version: 0,
      scopes: ['profile:read'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.jwtSecret));
    return {
      app,
      prisma,
      session,
      userHeaders: { authorization: `Bearer ${token}` },
      adminHeaders: { cookie: `__Secure-sesame_admin_session=${'a'.repeat(64)}` },
    };
  } catch (cause) {
    throw new Error('认证错误分类测试初始化失败', { cause });
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it.each(['generation', 'device'] as const)('用户认证 %s 数据库失败返回 503，不伪装为凭据错误', async (stage) => {
  const { app, prisma, userHeaders } = await setup();
  const target = stage === 'generation' ? prisma.serverEpoch.upsert : prisma.device.findFirst;
  target.mockRejectedValue(new Error('DATABASE_UNAVAILABLE'));
  const log = vi.spyOn(app.log, 'error');
  const response = await app.inject({ method: 'GET', url: '/api/v1/profile/me', headers: userHeaders });
  expect(response.statusCode).toBe(503);
  expect(response.json().code).toBe('AUTH_UNAVAILABLE');
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.any(String));
  expect(response.body).not.toContain('DATABASE_UNAVAILABLE');
  expect(prisma.user.findUnique).not.toHaveBeenCalled();
  expect(prisma.adminSession.findUnique).not.toHaveBeenCalled();
});

it.each(['transaction', 'lock', 'session', 'touch'] as const)(
  '后台认证 %s 存储失败返回 503，不能回退为普通用户身份',
  async (stage) => {
    const { app, prisma, adminHeaders, userHeaders } = await setup();
    const target = {
      transaction: prisma.$transaction,
      lock: prisma.$queryRaw,
      session: prisma.adminSession.findUnique,
      touch: prisma.adminSession.update,
    }[stage];
    target.mockRejectedValue(new Error('ADMIN_DATABASE_UNAVAILABLE'));
    const log = vi.spyOn(app.log, 'error');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { ...adminHeaders, ...userHeaders },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('ADMIN_AUTH_UNAVAILABLE');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.any(String));
    expect(response.body).not.toContain('ADMIN_DATABASE_UNAVAILABLE');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.device.findFirst).not.toHaveBeenCalled();
    expect(prisma.serverEpoch.upsert).not.toHaveBeenCalled();
  },
);

it('普通用户无效 JWT 与已撤销设备仍返回 401，且不查询后台身份', async () => {
  const { app, prisma, userHeaders } = await setup();
  expect(
    (await app.inject({ method: 'GET', url: '/api/v1/profile/me', headers: { authorization: 'Bearer invalid' } }))
      .statusCode,
  ).toBe(401);
  expect(prisma.device.findFirst).not.toHaveBeenCalled();
  prisma.device.findFirst.mockResolvedValueOnce(null);
  expect((await app.inject({ method: 'GET', url: '/api/v1/profile/me', headers: userHeaders })).statusCode).toBe(401);
  expect(prisma.adminSession.findUnique).not.toHaveBeenCalled();
});

it('缺失或撤销的后台会话返回 401，当前角色缺权限返回 403', async () => {
  const { app, prisma, adminHeaders, userHeaders } = await setup();
  const missing = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: userHeaders });
  expect(missing.statusCode).toBe(401);
  expect(missing.json().code).toBe('ADMIN_UNAUTHORIZED');
  expect(prisma.$transaction).not.toHaveBeenCalled();
  prisma.adminSession.findUnique.mockResolvedValueOnce(null);
  const revoked = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: adminHeaders });
  expect(revoked.statusCode).toBe(401);
  expect(revoked.json().code).toBe('ADMIN_UNAUTHORIZED');
  const forbidden = await app.inject({ method: 'GET', url: '/api/v1/admin/accounts', headers: adminHeaders });
  expect(forbidden.statusCode).toBe(403);
  expect(forbidden.json().code).toBe('ADMIN_PERMISSION_DENIED');
  expect(prisma.adminAccount.findMany).not.toHaveBeenCalled();
});
