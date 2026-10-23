import type { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
  JWT_SECRET: 'resource-scope-test-secret-at-least-32-bytes',
  STORAGE_PATH: 'Temp/scope-tests',
});
const id = '11111111-1111-4111-8111-111111111111';
const apps: ReturnType<typeof buildApp>[] = [];

/** 使用真实 JWT 和路由守卫，数据库替身只提供认证状态及空同步读取。 */
async function setup(scopes: string[]) {
  try {
    const prisma = {
      serverEpoch: { upsert: vi.fn().mockResolvedValue({ authGeneration: id }) },
      device: { findFirst: vi.fn().mockResolvedValue({ id }) },
      syncChange: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([{ cursor: 0n, completedAt: new Date(0) }]),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const app = buildApp({ logger: false, config, prisma: prisma as unknown as PrismaClient });
    apps.push(app);
    const token = await new SignJWT({
      device_id: id,
      auth_generation: id,
      credential_version: 0,
      is_admin: true,
      scopes,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(id)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(config.jwtSecret));
    return { app, prisma, headers: { authorization: `Bearer ${token}` } };
  } catch (error) {
    throw new Error('资源权限测试初始化失败', { cause: error });
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('路由资源 scope 边界', () => {
  it('无关写请求和未验签请求不触发在线会话全量查询', async () => {
    const { app, headers, prisma } = await setup(['sync:read']);
    // 保留一张有效票据，使全量复核错误地触发时可以观察到数据库查询。
    expect((await app.inject({ method: 'POST', url: '/api/v1/ws/ticket', headers })).statusCode).toBe(200);
    prisma.device.findFirst.mockClear();
    prisma.serverEpoch.upsert.mockClear();

    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/ws/ticket' })).statusCode).toBe(401);

    expect(prisma.device.findFirst).not.toHaveBeenCalled();
    expect(prisma.serverEpoch.upsert).not.toHaveBeenCalled();
  });

  it('握手复核安全状态，已建连接在设备撤销响应完成前关闭', async () => {
    const { app, headers, prisma } = await setup(['sync:read']);
    const issued = await app.inject({ method: 'POST', url: '/api/v1/ws/ticket', headers });
    const ticket = issued.json().ticket as string;
    let ready: Promise<unknown[]> | undefined;
    const socket = await app.injectWS(
      `/api/v1/ws?ticket=${ticket}`,
      {},
      {
        onInit: (connection) => {
          ready = once(connection, 'message', { signal: AbortSignal.timeout(5000) });
        },
      },
    );
    try {
      await ready;
      const closed = once(socket, 'close', { signal: AbortSignal.timeout(5000) });
      prisma.device.findFirst.mockResolvedValue(null);
      // 写请求即使鉴权失败，响应钩子也必须清理刚被撤销的存量会话。
      expect((await app.inject({ method: 'POST', url: '/api/v1/ws/ticket', headers })).statusCode).toBe(401);
      const [code] = await closed;
      expect(code).toBe(1008);
    } finally {
      socket.terminate();
    }
  });

  it('取票后撤销设备不能利用旧票据完成认证握手', async () => {
    const { app, headers, prisma } = await setup(['sync:read']);
    const issued = await app.inject({ method: 'POST', url: '/api/v1/ws/ticket', headers });
    prisma.device.findFirst.mockResolvedValue(null);
    let closed: Promise<unknown[]> | undefined;
    const socket = await app.injectWS(
      `/api/v1/ws?ticket=${issued.json().ticket}`,
      {},
      {
        onInit: (connection) => {
          closed = once(connection, 'close', { signal: AbortSignal.timeout(5000) });
        },
      },
    );
    try {
      const [code] = await closed!;
      expect(code).toBe(1008);
    } finally {
      socket.terminate();
    }
  });

  it.each([
    '/ledgers',
    `/ledgers/${id}/transactions`,
    `/ledgers/${id}/categories`,
    '/exchange-rates?base=CNY',
    '/sync/pull',
    '/sync/fitness-spaces',
  ])('profile 凭证不能读取同步资源 %s', async (path) => {
    const { app, headers } = await setup(['profile:read', 'profile:write']);
    const response = await app.inject({ method: 'GET', url: `/api/v1${path}`, headers });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe('SCOPE_DENIED');
  });

  it.each(['profile:write', 'sync:read'])('%s 不能修改分类', async (scope) => {
    const { app, headers } = await setup([scope]);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/ledgers/${id}/categories/${id}`,
      headers,
      payload: { name: '分类' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe('SCOPE_DENIED');
  });

  it('只读同步凭证允许 pull 和取实时票据，不能 push', async () => {
    const { app, headers, prisma } = await setup(['sync:read']);
    expect((await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers })).statusCode).toBe(200);
    expect(prisma.syncChange.findMany).toHaveBeenCalledOnce();
    expect((await app.inject({ method: 'POST', url: '/api/v1/ws/ticket', headers })).statusCode).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers,
      payload: {
        device_id: id,
        changes: [
          {
            mutation_id: id,
            entity_id: id,
            entity_type: 'category',
            ledger_id: null,
            action: 'delete',
            updated_at: '2026-09-19T00:00:00.000Z',
            payload: {},
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('同步凭证不能读取普通用户资料', async () => {
    const { app, headers } = await setup(['sync:read', 'sync:write']);
    const response = await app.inject({ method: 'GET', url: '/api/v1/profile/me', headers });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe('SCOPE_DENIED');
  });

  it('即使 JWT 带 is_admin，用户同步凭证也不是后台身份', async () => {
    const { app, headers, prisma } = await setup(['sync:read', 'sync:write']);
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('ADMIN_UNAUTHORIZED');
    expect(prisma.device.findFirst).not.toHaveBeenCalled();
    expect(prisma.serverEpoch.upsert).not.toHaveBeenCalled();
  });
});
