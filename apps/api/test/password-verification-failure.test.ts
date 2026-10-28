import cookie from '@fastify/cookie';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { hashPassword, registerAuthRoutes } from '../src/modules/auth/index.js';
import { signAccessToken } from '../src/modules/auth/testing.js';
import { registerErrorHandler } from '../src/shared/errors.js';

const cryptoFailure = vi.hoisted(() => ({ password: '', error: undefined as Error | undefined }));

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return {
    ...crypto,
    /** 仅让指定密码的派生任务失败，其余密码散列、令牌签发和比较仍执行真实加密。 */
    scrypt: (...args: Parameters<typeof crypto.scrypt>) => {
      const cause = cryptoFailure.error;
      if (cause && args[0] === cryptoFailure.password) {
        const callback = args.at(-1) as (error: Error, key: Buffer) => void;
        queueMicrotask(() => callback(cause, Buffer.alloc(0)));
        return;
      }
      crypto.scrypt(...args);
    },
  };
});

const userId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const generation = '33333333-3333-4333-8333-333333333333';
const password = 'current-password-verification-fixture';
const nextPassword = 'next-password-verification-fixture';
const origin = 'http://localhost:5173';
const apps: ReturnType<typeof Fastify>[] = [];

/** 真实认证路由读取内存账号和设备；所有会话或凭据写入都可观察，不连接数据库。 */
async function setup() {
  try {
    const config = {
      ...loadConfig({
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
        JWT_SECRET: 'password-verification-test-secret-at-least-32-bytes',
        STORAGE_PATH: 'Temp/password-verification-failure',
      }),
      corsOrigins: [origin],
      authRateLimitMax: 1000,
    };
    const user = {
      id: userId,
      phoneE164: '+8613800138000',
      sesameNumber: '123456789',
      passwordHash: await hashPassword(password),
      credentialVersion: 0,
      isEnabled: true,
      profile: null,
    };
    const device = { id: deviceId, userId, revokedAt: null };
    const refreshTokens = [{ id: 'existing-refresh-token', userId, deviceId, revokedAt: null }];
    const prisma = {
      serverEpoch: { findUniqueOrThrow: vi.fn(async () => ({ authGeneration: generation })) },
      user: {
        findUnique: vi.fn(async () => user),
        update: vi.fn(async ({ data }: { data: { passwordHash: string } }) => Object.assign(user, data)),
      },
      device: {
        findFirst: vi.fn(async () => device),
        upsert: vi.fn(async () => device),
      },
      refreshToken: {
        create: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      $queryRaw: vi.fn(async () => [{ id: userId }]),
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(async (operation: (tx: typeof prisma) => Promise<unknown>) =>
      operation(prisma),
    );
    const records: string[] = [];
    const failures: Error[] = [];
    const app = Fastify({ logger: { stream: { write: (record) => records.push(record) } } });
    apps.push(app);
    await app.register(cookie);
    registerErrorHandler(app);
    registerAuthRoutes(app, prisma as unknown as PrismaClient, config, async () => {
      throw new Error('登录和改密不能触发账号业务初始化');
    });
    app.addHook('onError', async (_request, _reply, error) => {
      failures.push(error);
    });
    await app.ready();
    const token = await signAccessToken(
      { userId, deviceId, authGeneration: generation, credentialVersion: 0, scopes: ['profile:read', 'profile:write'] },
      config,
    );
    /** 请求前后读取原始状态，防止错误响应掩盖已签发会话或已修改凭据。 */
    const snapshot = () => structuredClone({ user, device, refreshTokens });
    return { app, prisma, records, failures, token, snapshot };
  } catch (cause) {
    throw new Error('密码验证故障测试准备失败', { cause });
  }
}

/** 普通密码错误与计算失败使用完全相同的真实接口及合法请求外壳。 */
function request(fixture: Awaited<ReturnType<typeof setup>>, endpoint: string, currentPassword: string) {
  if (endpoint === '/api/v1/auth/password') {
    return fixture.app.inject({
      method: 'PATCH',
      url: endpoint,
      headers: { authorization: `Bearer ${fixture.token}` },
      payload: { current_password: currentPassword, new_password: nextPassword },
    });
  }
  return fixture.app.inject({
    method: 'POST',
    url: endpoint,
    headers: endpoint.includes('/browser/') ? { origin } : {},
    payload: {
      country_code: '+86',
      phone: '13800138000',
      password: currentPassword,
      device: { installation_id: deviceId, name: '密码故障验证', platform: 'test' },
    },
  });
}

afterEach(async () => {
  cryptoFailure.error = undefined;
  cryptoFailure.password = '';
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it.each([
  { endpoint: '/api/v1/auth/login', code: 'LOGIN_FAILED' },
  { endpoint: '/api/v1/auth/browser/login', code: 'LOGIN_FAILED' },
  { endpoint: '/api/v1/auth/password', code: 'PASSWORD_CHANGE_FAILED' },
])('$endpoint 将密码计算故障报告为 500，保留根因且不更改账号或会话', async ({ endpoint, code }) => {
  try {
    const fixture = await setup();
    const before = fixture.snapshot();
    const cause = Object.assign(new Error('password derivation unavailable'), { code: 'CRYPTO_EXECUTION_FAILED' });
    cryptoFailure.password = password;
    cryptoFailure.error = cause;
    const response = await request(fixture, endpoint, password);

    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toMatchObject({ code, request_id: expect.any(String) });
    expect(response.cookies).toHaveLength(0);
    expect(response.body).not.toContain('access_token');
    expect(response.body).not.toContain(cause.message);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.prisma.user.update).not.toHaveBeenCalled();
    expect(fixture.prisma.device.upsert).not.toHaveBeenCalled();
    expect(fixture.prisma.refreshToken.create).not.toHaveBeenCalled();
    expect(fixture.prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(fixture.failures).toHaveLength(1);
    let root: unknown = fixture.failures[0];
    while (root instanceof Error && root.cause !== undefined) root = root.cause;
    expect(root).toBe(cause);
    const failures = fixture.records.map((record) => JSON.parse(record)).filter((record) => record.level >= 50);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code, request_id: response.json().request_id });
    expect(failures[0].err.message).toContain(cause.message);
    expect(fixture.records.join('')).not.toContain(password);
    expect(fixture.records.join('')).not.toContain(nextPassword);
  } catch (cause) {
    throw new Error(`密码计算失败的接口与状态验收失败：${endpoint}`, { cause });
  }
});

it.each([
  { endpoint: '/api/v1/auth/login', status: 401, code: 'INVALID_CREDENTIALS' },
  { endpoint: '/api/v1/auth/browser/login', status: 401, code: 'INVALID_CREDENTIALS' },
  { endpoint: '/api/v1/auth/password', status: 400, code: 'CURRENT_PASSWORD_INVALID' },
])('$endpoint 的正常密码不匹配保留业务拒绝语义', async ({ endpoint, status, code }) => {
  try {
    const fixture = await setup();
    const before = fixture.snapshot();
    const response = await request(fixture, endpoint, 'incorrect-password-fixture');
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(response.cookies).toHaveLength(0);
    expect(fixture.snapshot()).toEqual(before);
    expect(fixture.records.map((record) => JSON.parse(record)).filter((record) => record.level >= 50)).toHaveLength(0);
  } catch (cause) {
    throw new Error(`正常密码不匹配验收失败：${endpoint}`, { cause });
  }
});
