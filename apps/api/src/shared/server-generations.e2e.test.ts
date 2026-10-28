import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import Fastify from 'fastify';
import { afterAll, expect, it } from 'vitest';
import { testFixtureDatabaseUrl } from '../../test/existing-test-database.js';
import { loadTestApiConfig } from '../../test/test-api-config.js';
import { buildApp } from '../app.js';
import { currentAuthGeneration, currentIdempotencyGeneration } from './server-generations.js';
import { findIdempotentReplay, storeIdempotentResult } from './idempotency.js';

const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });

/** 所有缺失状态和合成数据只存在于本次回滚事务，不能改变其他测试的服务器代际。 */
async function inRollbackTransaction(operation: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  const rollback = new Error('结束代际单例验收事务');
  try {
    await prisma.$transaction(async (tx) => {
      // 与维护和同步水位写入互斥，正常请求仍可读取已提交的权威单例。
      await tx.$queryRaw`SELECT id FROM server_epochs WHERE id = 0 FOR UPDATE`;
      await operation(tx);
      throw rollback;
    });
  } catch (cause) {
    if (cause !== rollback) throw new Error('代际单例数据库验收失败', { cause });
  }
}

afterAll(async () => {
  await prisma.$disconnect();
});

it('正常代际读取返回迁移建立的原值，不改动认证、幂等和同步持久事实', async () => {
  await inRollbackTransaction(async (tx) => {
    const before = await tx.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
    expect(await currentAuthGeneration(tx)).toBe(before.authGeneration);
    expect(await currentIdempotencyGeneration(tx)).toBe(before.idempotencyGeneration);
    expect(await tx.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toEqual(before);
  });
});

it.each(['认证读取', '幂等读取', '幂等重放', '幂等保存'] as const)(
  '%s 遇到单例缺失明确失败，不建立替代代际或改变已成功的幂等回执',
  async (operation) => {
    await inRollbackTransaction(async (tx) => {
      const state = await tx.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      const user = await tx.user.create({
        data: {
          phoneE164: `+86138${randomInt(100_000_000).toString().padStart(8, '0')}`,
          sesameNumber: randomInt(100_000_000, 1_000_000_000).toString(),
          passwordHash: 'generation-test-never-used-for-authentication',
        },
      });
      const now = new Date();
      const key = `generation-invariant:${randomUUID()}`;
      const requestHash = 'a'.repeat(64);
      const cached = await tx.idempotencyKey.create({
        data: {
          userId: user.id,
          key,
          requestHash,
          response: { confirmed: true },
          expiresAt: new Date(now.getTime() + 60_000),
          generation: state.idempotencyGeneration,
        },
      });
      await tx.serverEpoch.delete({ where: { id: 0 } });
      let failure: unknown;
      try {
        if (operation === '认证读取') await currentAuthGeneration(tx);
        else if (operation === '幂等读取') await currentIdempotencyGeneration(tx);
        else if (operation === '幂等重放') await findIdempotentReplay(tx, user.id, key, requestHash, now);
        else await storeIdempotentResult(tx, user.id, `${key}:new`, requestHash, { confirmed: true }, now);
      } catch (cause) {
        failure = cause;
      }
      expect(failure).toMatchObject({ message: '服务端 generation 读取失败', cause: { code: 'P2025' } });
      expect(await tx.serverEpoch.findUnique({ where: { id: 0 } })).toBeNull();
      expect(await tx.idempotencyKey.findMany({ where: { userId: user.id } })).toEqual([cached]);
    });
  },
);

it.each([false, true])('注册读取代际失败时回滚账号与会话，恢复后可正常注册：browser=%s', async (browser) => {
  const phone = `138${randomInt(100_000_000).toString().padStart(8, '0')}`;
  const origin = 'https://generation-registration.example.test';
  const cause = new Prisma.PrismaClientKnownRequestError('server epoch singleton is missing', {
    code: 'P2025',
    clientVersion: Prisma.prismaVersion.client,
  });
  let failing = true;
  let createdUserId = '';
  const routedPrisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() }).$extends({
    query: {
      serverEpoch: {
        /** 只在本次注册事务的代际读取处模拟缺失，业务写入与回滚仍由真实数据库执行。 */
        async findUniqueOrThrow({ args, query }) {
          if (failing) throw cause;
          return query(args);
        },
      },
      user: {
        /** 记录已执行 INSERT 的本轮账号身份，用于核查失败后所有关联数据是否回滚。 */
        async create({ args, query }) {
          const user = await query(args);
          if (typeof user.id !== 'string') throw new Error('注册创建结果缺少账号身份，无法核对事务回滚');
          createdUserId = user.id;
          return user;
        },
      },
    },
  });
  const records: string[] = [];
  const failures: Error[] = [];
  const loggerHost = Fastify({ logger: { stream: { write: (record) => records.push(record) } } });
  const config = { ...loadTestApiConfig(), corsOrigins: [origin], authRateLimitMax: 1000 };
  const app = buildApp({ logger: loggerHost.log, config, prisma: routedPrisma as unknown as PrismaClient });
  app.addHook('onError', async (_request, _reply, error) => {
    failures.push(error);
  });
  const request = {
    method: 'POST' as const,
    url: `/api/v1/auth/${browser ? 'browser/' : ''}register`,
    headers: browser ? { origin } : {},
    payload: {
      country_code: '+86',
      phone,
      password: 'generation-registration-fixture-password',
      device: { installation_id: randomUUID(), name: '代际注册验收', platform: 'test' },
    },
  };
  try {
    const before = await prisma.serverEpoch.findUniqueOrThrow({
      where: { id: 0 },
      select: { authGeneration: true, idempotencyGeneration: true },
    });
    const response = await app.inject(request);
    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toMatchObject({ code: 'REGISTER_FAILED' });
    expect(response.cookies).toHaveLength(0);
    expect(response.body).not.toContain('access_token');
    expect(response.body).not.toContain(cause.message);
    expect(createdUserId).not.toBe('');
    expect(await prisma.user.findUnique({ where: { phoneE164: `+86${phone}` } })).toBeNull();
    expect(await prisma.device.count({ where: { userId: createdUserId } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: createdUserId } })).toBe(0);
    expect(await prisma.productAnalyticsEvent.count({ where: { eventId: createdUserId } })).toBe(0);
    expect(failures).toHaveLength(1);
    let root: unknown = failures[0];
    while (root instanceof Error && root.cause !== undefined) root = root.cause;
    expect(root).toBe(cause);
    const errors = records.map((record) => JSON.parse(record)).filter((record) => record.level >= 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'REGISTER_FAILED', request_id: response.json().request_id });
    expect(records.join('')).not.toContain(request.payload.password);

    failing = false;
    const retried = await app.inject(request);
    expect(retried.statusCode, retried.body).toBe(201);
    expect(retried.json().user.user_id).toBe(createdUserId);
    const tokens = await prisma.refreshToken.findMany({ where: { userId: createdUserId } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.authGeneration).toBe(before.authGeneration);
    expect(
      await prisma.serverEpoch.findUniqueOrThrow({
        where: { id: 0 },
        select: { authGeneration: true, idempotencyGeneration: true },
      }),
    ).toEqual(before);
  } catch (error) {
    throw new Error('注册代际失败的真实事务回滚验收失败', { cause: error });
  } finally {
    await app.close();
    await loggerHost.close();
    if (createdUserId) await prisma.user.deleteMany({ where: { id: createdUserId } });
  }
});
