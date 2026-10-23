import { randomInt, randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { testStoragePath } from './test-storage-path.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const origin = 'http://localhost:5173';

type Failure = {
  stage: 'children' | 'events';
  userId?: string;
  deviceId?: string;
  tokenId?: string;
  parentCount: number;
  childCount: number;
  eventCount: number;
  reached: boolean;
};
let failure: Failure | null = null;

// 扩展在真实写入返回后抛错，确保断言验证的是整笔事务回滚，而非写入前的校验拒绝。
const injectedPrisma = prisma.$extends({
  query: {
    user: {
      /** 保存实际创建的账号身份，后续核查不依赖已回滚的响应正文。 */
      async create({ args, query }) {
        const row = await query(args);
        if (failure) failure.userId = row.id;
        return row;
      },
    },
    device: {
      /** 记录先于默认分类创建的真实设备，验证设备与分类共同回滚。 */
      async upsert({ args, query }) {
        const row = await query(args);
        if (failure) failure.deviceId = row.id;
        return row;
      },
    },
    refreshToken: {
      /** 记录已写入的刷新令牌，故障响应不能留下可用会话。 */
      async create({ args, query }) {
        const row = await query(args);
        if (failure) failure.tokenId = row.id;
        return row;
      },
    },
    category: {
      /** 二级目录写入完成后注入失败，父分类和子分类都必须撤销。 */
      async createManyAndReturn({ args, query }) {
        const rows = await query(args);
        if (failure) {
          const data = Array.isArray(args.data) ? args.data : [args.data];
          const children = data.every((row) => row.level === 2);
          if (children) failure.childCount += rows.length;
          else failure.parentCount += rows.length;
          if (failure.stage === 'children' && children) {
            failure.reached = true;
            throw new Error('INJECTED_CATEGORY_CHILDREN_WRITE_FAILURE');
          }
        }
        return rows;
      },
    },
    syncChange: {
      /** 完整同步事件已获得游标后注入失败，事件和分类不得分开提交。 */
      async createManyAndReturn({ args, query }) {
        const rows = await query(args);
        if (failure?.stage === 'events') {
          failure.eventCount += rows.length;
          failure.reached = true;
          throw new Error('INJECTED_CATEGORY_EVENTS_WRITE_FAILURE');
        }
        return rows;
      },
    },
  },
});
const app = buildApp({
  logger: false,
  prisma: injectedPrisma as unknown as PrismaClient,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'registration-atomicity-test-secret-at-least-32-bytes',
      STORAGE_PATH: testStoragePath('auth-registration-atomicity'),
    }),
    corsOrigins: [origin],
    authRateLimitMax: 1000,
    rateLimitMax: 1000,
  },
});

beforeAll(() => app.ready());
afterAll(() => app.close());

/** 真实账号资料只用于当前隔离库，两个客户端入口共用相同注册正文。 */
function registrationBody(phone: string) {
  return {
    country_code: '+86',
    phone,
    password: 'registration-atomicity-password',
    device: { installation_id: randomUUID(), name: '注册分类原子性验证', platform: 'test' },
  };
}

/** 从隔离库挑选尚未占用的手机号，重跑测试保留其他夹具，不清空数据库。 */
async function unusedPhone() {
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const phone = `139${randomInt(100_000_000).toString().padStart(8, '0')}`;
      const existing = await prisma.user.findUnique({ where: { phoneE164: `+86${phone}` }, select: { id: true } });
      if (!existing) return phone;
    }
    throw new Error('测试手机号分配次数已达上限');
  } catch (cause) {
    throw new Error('注册原子性测试手机号准备失败', { cause });
  }
}

for (const browser of [false, true]) {
  it.each(['children', 'events'] as const)(
    `${browser ? '浏览器' : '移动端'}注册在 %s 写入后失败完整回滚，取消故障后相同手机号可创建完整目录`,
    async (stage) => {
      const phone = await unusedPhone();
      const body = registrationBody(phone);
      const request = {
        method: 'POST' as const,
        url: `/api/v1/auth${browser ? '/browser' : ''}/register`,
        headers: browser ? { origin } : {},
        payload: body,
      };
      const observed: Failure = { stage, parentCount: 0, childCount: 0, eventCount: 0, reached: false };
      failure = observed;
      try {
        const failed = await app.inject(request);
        expect(failed.statusCode, failed.body).toBe(500);
        expect(failed.json()).toMatchObject({ code: 'REGISTER_FAILED', message: '注册失败，请稍后重试' });
        expect(failed.cookies).toHaveLength(0);
        expect(failed.headers['set-cookie']).toBeUndefined();
        expect(failed.body).not.toContain('access_token');
        expect(failed.body).not.toContain('refresh_token');
        expect(failed.body).not.toContain('INJECTED_CATEGORY');
        expect(observed.reached).toBe(true);
        expect(observed.userId).toEqual(expect.any(String));
        expect(observed.deviceId).toEqual(expect.any(String));
        expect(observed.tokenId).toEqual(expect.any(String));
        expect(observed.parentCount).toBe(20);
        expect(observed.childCount).toBe(41);
        expect(observed.eventCount).toBe(stage === 'events' ? 61 : 0);

        // 先确认失败阶段实际执行，再从另一条数据库请求读取，不能被未提交事务快照掩盖残留。
        const counts = await Promise.all([
          prisma.user.count({ where: { phoneE164: `+86${phone}` } }),
          prisma.userProfile.count({ where: { userId: observed.userId! } }),
          prisma.device.count({ where: { userId: observed.userId! } }),
          prisma.refreshToken.count({ where: { userId: observed.userId! } }),
          prisma.category.count({ where: { ownerId: observed.userId! } }),
          prisma.syncChange.count({ where: { userId: observed.userId! } }),
          prisma.productAnalyticsEvent.count({ where: { eventId: observed.userId! } }),
        ]);
        expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0]);

        failure = null;
        const retried = await app.inject(request);
        expect(retried.statusCode, retried.body).toBe(201);
        const session = retried.json<{ access_token: string; device_id: string; user: { user_id: string } }>();
        expect(session.access_token).toEqual(expect.any(String));
        expect(Boolean(retried.cookies.length)).toBe(browser);
        const rows = await prisma.category.findMany({ where: { ownerId: session.user.user_id } });
        expect(rows).toHaveLength(61);
        expect(rows.filter((row) => row.level === 1)).toHaveLength(20);
        expect(rows.filter((row) => row.level === 2)).toHaveLength(41);
        const events = await prisma.syncChange.findMany({
          where: { userId: session.user.user_id, entityType: 'category' },
          orderBy: { changeId: 'asc' },
        });
        expect(events).toHaveLength(61);
        expect(events.every((event) => event.deviceId === session.device_id && event.action === 'upsert')).toBe(true);
        expect(await prisma.userProfile.count({ where: { userId: session.user.user_id } })).toBe(1);
        expect(await prisma.device.count({ where: { userId: session.user.user_id } })).toBe(1);
        expect(await prisma.refreshToken.count({ where: { userId: session.user.user_id } })).toBe(1);
      } catch (cause) {
        throw new Error(`${browser ? '浏览器' : '移动端'}注册默认分类 ${stage} 原子性验证失败`, { cause });
      } finally {
        failure = null;
      }
    },
  );
}
