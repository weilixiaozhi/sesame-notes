import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

import {
  assertExclusiveTestLocksReleased,
  assertGuardedTestDatabase,
  guardedTestDatabaseUrl,
} from './existing-test-database.js';

const databaseUrl = guardedTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'web-authorization-race-test-secret-at-least-32-bytes',
      STORAGE_PATH: process.env.STORAGE_PATH ?? '.web-authorization-race-storage',
    }),
    authRateLimitMax: 1000,
    rateLimitMax: 1000,
  },
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Command = 'add-batch' | 'imports' | 'sync-push' | 'rest-transaction-create';
beforeAll(async () => {
  await assertGuardedTestDatabase(prisma, databaseUrl, process.env);
  await app.ready();
});
afterAll(async () => {
  try {
    await assertExclusiveTestLocksReleased(prisma, process.env);
  } finally {
    await app.close();
  }
});

/** 只注册当前隔离数据库中的随机账号，不读取任何现有登录信息。 */
async function fixture(command: Command) {
  try {
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        country_code: '+86',
        phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
        password: 'isolated-web-race-password',
        device: { installation_id: randomUUID(), name: 'Web 会话排队回归', platform: 'test' },
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const session = registered.json<Session>();
    const headers = { authorization: `Bearer ${session.access_token}`, 'idempotency-key': randomUUID() };
    const createdLedger = await app.inject({
      method: 'POST',
      url: '/api/v1/ledgers',
      headers,
      payload: { name: '排队会话专属账本', currency: 'CNY' },
    });
    expect(createdLedger.statusCode, createdLedger.body).toBe(201);
    const ledgerId = createdLedger.json<{ id: string }>().id;
    const createdCategory = await app.inject({
      method: 'POST',
      url: `/api/v1/ledgers/${ledgerId}/categories`,
      headers,
      payload: { name: '受保护的分类', kind: 'expense', level: 1, sort_order: 0 },
    });
    expect(createdCategory.statusCode, createdCategory.body).toBe(201);
    const category = createdCategory.json<{ id: string; updated_at: string }>();
    await prisma.transaction.create({
      data: {
        ledgerId,
        ownerId: session.user.user_id,
        categoryId: category.id,
        categoryName: '受保护的分类',
        categoryKind: 'expense',
        txType: 'expense',
        amount: '10',
        currencyCode: 'CNY',
        nativeAmount: '10',
        happenedAt: new Date('2026-09-30T00:00:00.000Z'),
      },
    });
    if (command === 'rest-transaction-create') {
      const method = 'POST' as const;
      const url = `/api/v1/ledgers/${ledgerId}/transactions`;
      const payload = {
        tx_type: 'expense',
        amount: '15',
        native_amount: '15',
        currency_code: 'CNY',
        happened_at: '2026-09-30T00:00:00.000Z',
        category_id: category.id,
      };
      return {
        session,
        ledgerId,
        headers,
        payload,
        method,
        url: await accountingRequestFixturePath(app, method, url, headers),
      };
    }
    let payload: object;
    if (command === 'imports')
      payload = {
        categories: [{ name: '排队后不得导入的分类', kind: 'expense', level: 1, sort_order: 1 }],
        transactions: [
          {
            id: randomUUID(),
            tx_type: 'expense',
            amount: '2',
            native_amount: '2',
            currency_code: 'CNY',
            happened_at: '2026-09-30T00:00:00.000Z',
            category_id: category.id,
          },
        ],
      };
    else if (command === 'sync-push')
      payload = {
        device_id: session.device_id,
        changes: [1, 2].map((index) => ({
          mutation_id: randomUUID(),
          entity_type: 'category',
          entity_id: randomUUID(),
          ledger_id: null,
          action: 'upsert',
          updated_at: new Date().toISOString(),
          payload: {
            name: `排队后不得同步的分类${index}`,
            kind: 'expense',
            level: 1,
            sort_order: index,
            icon: null,
            parent_id: null,
          },
        })),
      };
    else payload = { items: [{ name: '不得新增的分类', kind: 'expense', level: 1, sort_order: 1 }] };
    const path = command === 'imports' ? command : 'categories/add-batch';
    const url = command === 'sync-push' ? '/api/v1/sync/push' : `/api/v1/ledgers/${ledgerId}/${path}`;
    return {
      session,
      ledgerId,
      headers,
      payload,
      method: 'POST' as const,
      url: await accountingRequestFixturePath(app, 'POST', url, headers),
    };
  } catch (cause) {
    throw new Error('排队会话撤销夹具准备失败', { cause });
  }
}

/** 保存完整业务与同步快照，拒绝请求不得悄悄改版本、墓碑或幂等回执。 */
async function businessSnapshot(userId: string, ledgerId: string) {
  const [ledger, ledgers, members, rules, categories, transactions, histories, changes, receipts] = await Promise.all([
    prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } }),
    prisma.ledger.findMany({ where: { ownerId: userId }, orderBy: { id: 'asc' } }),
    prisma.ledgerMember.findMany({ where: { ledgerId }, orderBy: { id: 'asc' } }),
    prisma.recurringTransaction.findMany({ where: { ownerId: userId }, orderBy: { id: 'asc' } }),
    prisma.category.findMany({ where: { ownerId: userId }, orderBy: { id: 'asc' } }),
    prisma.transaction.findMany({ where: { ledgerId }, include: { splits: true }, orderBy: { id: 'asc' } }),
    prisma.transactionEditHistory.findMany({ where: { ledgerId }, orderBy: { id: 'asc' } }),
    prisma.syncChange.findMany({ where: { userId }, orderBy: { changeId: 'asc' } }),
    prisma.idempotencyKey.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
  ]);
  return { ledger, ledgers, members, rules, categories, transactions, histories, changes, receipts };
}

/** 观察真正的 PostgreSQL 等锁状态，证明请求已通过前置鉴权而非依赖固定睡眠时序。 */
async function waitForQueuedWrite() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_locks lock
        JOIN pg_stat_activity activity ON activity.pid = lock.pid
        WHERE activity.datname = current_database() AND lock.locktype = 'advisory'
          AND lock.classid = 1936028513 AND lock.objid = 1 AND lock.objsubid = 2
          AND NOT lock.granted
      ) AS waiting
    `;
    if (state?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('请求没有进入同步写锁队列，无法证明排队期间会话撤销');
}

describe('Web 原子命令等待写锁后的会话撤销边界', () => {
  const cases = [
    { command: 'add-batch', revocation: '撤销设备' },
    { command: 'imports', revocation: '停用账号' },
    { command: 'sync-push', revocation: '撤销设备' },
    { command: 'rest-transaction-create', revocation: '停用账号' },
  ] as const;
  it.each(cases)(
    '$command 排队期间$revocation，返回401并且业务、SyncChange和幂等回执均不改变',
    async ({ command, revocation }) => {
      const data = await fixture(command);
      const before = await businessSnapshot(data.session.user.user_id, data.ledgerId);
      let release!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const locked = new Promise<void>((resolve) => (ready = resolve));
      const blocker = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1936028513, 1)`;
          ready();
          await gate;
        },
        { timeout: 15000 },
      );
      await Promise.race([locked, blocker]);
      const pending = app
        .inject({
          method: data.method,
          url: data.url,
          headers: data.headers,
          payload: data.payload,
        })
        .then((response) => response);
      try {
        await waitForQueuedWrite();
        if (revocation === '撤销设备')
          await prisma.device.update({ where: { id: data.session.device_id }, data: { revokedAt: new Date() } });
        else await prisma.user.update({ where: { id: data.session.user.user_id }, data: { isEnabled: false } });
      } finally {
        release();
        try {
          await blocker;
        } finally {
          // 等锁或撤销断言失败时仍等待请求结束，避免夹具在后台继续访问数据库。
          await pending.catch(() => undefined);
        }
      }
      const response = await pending;
      // 完整状态比较优先于状态码断言，直接暴露任何被错误接受的写入。
      expect(await businessSnapshot(data.session.user.user_id, data.ledgerId)).toEqual(before);
      expect(response.statusCode, response.body).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    },
    15000,
  );
});
