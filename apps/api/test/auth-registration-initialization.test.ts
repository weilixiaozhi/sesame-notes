import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import { Prisma, type PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { registerAuthRoutes } from '../src/modules/auth/index.js';
import { registerErrorHandler } from '../src/shared/errors.js';
import { acquireSyncTransactionLock, type SyncTransaction } from '../src/shared/sync-transaction.js';

const origin = 'http://localhost:5173';
const apps: ReturnType<typeof Fastify>[] = [];

/** 真实注册路由使用内存事务替身，验证初始化时机和异常传播，不连接数据库。 */
async function setup(browser = false) {
  try {
    const userId = randomUUID();
    const deviceId = randomUUID();
    const user = {
      id: userId,
      phoneE164: '+8613800138000',
      sesameNumber: '123456789',
      credentialVersion: 0,
      isEnabled: true,
      profile: null,
    };
    const operations: string[] = [];
    const prisma = {
      $executeRaw: vi.fn(async (query: TemplateStringsArray) => {
        operations.push(query[0]!.includes('1936028513') ? 'sync-lock' : 'phone-lock');
        return 1;
      }),
      user: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => {
          operations.push('user');
          return user;
        }),
      },
      productAnalyticsEvent: { updateMany: vi.fn(async () => ({ count: 1 })) },
      serverEpoch: { findUniqueOrThrow: vi.fn(async () => ({ authGeneration: randomUUID() })) },
      device: {
        upsert: vi.fn(async () => {
          operations.push('device');
          return { id: deviceId };
        }),
      },
      refreshToken: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async () => {
          operations.push('refresh-token');
          return {};
        }),
      },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(async (action: (tx: typeof prisma) => Promise<unknown>) => {
      const result = await action(prisma);
      operations.push('transaction-return');
      return result;
    });
    const initialize = vi.fn(async (_tx: SyncTransaction, _actor: { userId: string; deviceId: string }) => {
      operations.push('initialize');
    });
    const config = {
      ...loadConfig({
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
        JWT_SECRET: 'registration-initialization-secret-at-least-32-bytes',
        STORAGE_PATH: 'Temp/auth-registration-initialization',
      }),
      corsOrigins: [origin],
      authRateLimitMax: 1000,
    };
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(cookie);
    registerErrorHandler(app);
    registerAuthRoutes(app, prisma as unknown as PrismaClient, config, initialize);
    await app.ready();

    /** 浏览器与移动端发送相同注册资料，只区分真实 HTTP 入口和 Cookie 来源。 */
    function register(password = 'registration-test-password') {
      return app.inject({
        method: 'POST',
        url: `/api/v1/auth${browser ? '/browser' : ''}/register`,
        headers: browser ? { origin } : {},
        payload: {
          country_code: '+86',
          phone: '13800138000',
          password,
          device: { installation_id: randomUUID(), name: '注册初始化验证', platform: browser ? 'web' : 'flutter' },
        },
      });
    }

    return { app, prisma, operations, initialize, register, userId, deviceId };
  } catch (cause) {
    throw new Error('账号注册初始化测试准备失败', { cause });
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

for (const browser of [false, true]) {
  it(`${browser ? '浏览器' : '移动端'}注册拒绝无法原样编码的密码，并在事务开始前返回友好 400`, async () => {
    try {
      const fixture = await setup(browser);
      const response = await fixture.register('password\uD800');
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: 'PASSWORD_INVALID', message: '密码包含无效的字符编码' });
      expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
      expect(response.cookies).toHaveLength(0);
    } catch (cause) {
      throw new Error('注册密码编码输入错误分类验证失败', { cause });
    }
  });

  it(`${browser ? '浏览器' : '移动端'}注册在同一事务用真实设备初始化一次，完成后才返回会话`, async () => {
    const fixture = await setup(browser);
    const response = await fixture.register();
    expect(response.statusCode, response.body).toBe(201);
    expect(fixture.initialize).toHaveBeenCalledExactlyOnceWith(fixture.prisma, {
      userId: fixture.userId,
      deviceId: fixture.deviceId,
    });
    expect(fixture.operations).toEqual([
      'sync-lock',
      'phone-lock',
      'user',
      'device',
      'refresh-token',
      'initialize',
      'transaction-return',
    ]);
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 10_000,
    });
    expect(response.json()).toMatchObject({ device_id: fixture.deviceId, user: { user_id: fixture.userId } });
    expect(Boolean(response.cookies.length)).toBe(browser);
  });

  it(`${browser ? '浏览器' : '移动端'}初始化失败使注册事务失败，不返回令牌或会话 Cookie`, async () => {
    const fixture = await setup(browser);
    fixture.initialize.mockRejectedValueOnce(new Error('CATEGORY_INITIALIZATION_FAILED'));
    const log = vi.spyOn(fixture.app.log, 'error');
    const response = await fixture.register();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'REGISTER_FAILED', message: '注册失败，请稍后重试' });
    expect(response.cookies).toHaveLength(0);
    expect(response.body).not.toContain('access_token');
    expect(response.body).not.toContain('CATEGORY_INITIALIZATION_FAILED');
    expect(fixture.operations).not.toContain('transaction-return');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.any(String));
  });
}

it('芝麻号唯一冲突仍开启新事务重试，只为成功账号初始化一次', async () => {
  const fixture = await setup();
  fixture.prisma.user.create.mockRejectedValueOnce(
    new Prisma.PrismaClientKnownRequestError('unique sesame number', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['sesame_number'] },
    }),
  );
  const response = await fixture.register();
  expect(response.statusCode, response.body).toBe(201);
  expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
  expect(fixture.initialize).toHaveBeenCalledTimes(1);
});

it('事务未启动的排队超时保留原始类型并重试，失败尝试不初始化', async () => {
  const fixture = await setup();
  fixture.prisma.$transaction.mockRejectedValueOnce(
    new Prisma.PrismaClientKnownRequestError('Unable to start a transaction', {
      code: 'P2028',
      clientVersion: 'test',
    }),
  );
  const response = await fixture.register();
  expect(response.statusCode, response.body).toBe(201);
  expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
  expect(fixture.initialize).toHaveBeenCalledTimes(1);
});

it('共享同步锁失败保持原始 Prisma 错误对象，由注册和同步各自的事务边界处理', async () => {
  const failure = new Prisma.PrismaClientKnownRequestError('lock failure', { code: 'P2028', clientVersion: 'test' });
  const tx = { $executeRaw: vi.fn().mockRejectedValue(failure) } as unknown as Prisma.TransactionClient;
  await expect(acquireSyncTransactionLock(tx)).rejects.toBe(failure);
});
