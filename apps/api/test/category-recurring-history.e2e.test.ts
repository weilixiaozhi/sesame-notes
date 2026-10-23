import { testStoragePath } from './test-storage-path.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { registeredMemberId } from '../src/modules/accounting/index.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'category-history-only-test-secret-32-characters',
      STORAGE_PATH: process.env.STORAGE_PATH ?? testStoragePath('category-recurring-history'),
    }),
    authRateLimitMax: 10000,
    rateLimitMax: 10000,
  },
});
beforeAll(() => app.ready());
afterAll(() => app.close());

type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Ledger = { id: string; sync_id: string };

/** 只为隔离库构造真实登录会话与绑定账本。 */
async function account() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `135${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'history-test-only',
      device: { installation_id: randomUUID(), name: '分类历史测试', platform: 'test' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json<Session>();
  const ledger = await request(session, 'POST', '/api/v1/ledgers', { name: '历史账本', currency: 'CNY' });
  expect(ledger.statusCode, ledger.body).toBe(201);
  return { session, ledger: ledger.json<Ledger>() };
}

/** 走正式认证与协议入口，幂等键仅用于需要它的管理命令。 */
function request(session: Session, method: 'POST' | 'GET' | 'DELETE', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${session.access_token}`,
      'idempotency-key': randomUUID(),
    },
    ...(payload ? { payload } : {}),
  });
}

it.each(['rest', 'sync', 'batch'] as const)('分类删除 %s 先处理活交易并保留周期墓碑历史', async (entry) => {
  const { session, ledger } = await account();
  const foreign = await account();
  const categoryId = randomUUID();
  const old = new Date('2024-01-03T00:00:00.000Z');
  const deleted = new Date('2024-01-02T00:00:00.000Z');
  for (const ownerId of [session.user.user_id, foreign.session.user.user_id])
    await prisma.category.create({
      data: { id: categoryId, ownerId, name: '同ID不同账号分类', kind: 'expense', updatedAt: old },
    });
  const ruleIds = [randomUUID(), randomUUID()];
  for (const [index, id] of ruleIds.entries()) {
    await prisma.recurringTransaction.create({
      data: {
        id,
        ledgerId: ledger.id,
        ownerId: session.user.user_id,
        txType: 'expense',
        amount: '10',
        currencyCode: 'CNY',
        categoryId,
        frequency: 'daily',
        interval: 1,
        startDate: new Date('2024-01-01T00:00:00.000Z'),
        endDate: new Date('2024-01-01T00:00:00.000Z'),
        lastGeneratedDate: new Date('2024-01-01T00:00:00.000Z'),
        enabled: true,
        deletedAt: index ? deleted : null,
        updatedAt: old,
        updatedByDeviceId: session.device_id,
      },
    });
    await prisma.transaction.create({
      data: {
        id: randomUUID(),
        ledgerId: ledger.id,
        ownerId: session.user.user_id,
        txType: 'expense',
        amount: '17.1234567891',
        nativeAmount: '17.1234567891',
        currencyCode: 'CNY',
        categoryId,
        categoryName: '旧分类',
        categoryKind: 'expense',
        happenedAt: new Date('2024-01-01T12:00:00.000Z'),
        recurringId: id,
        revision: 7,
        note: null,
        deletedAt: deleted,
        updatedAt: old,
        updatedByDeviceId: session.device_id,
        payerMemberId: registeredMemberId(ledger.id, session.user.user_id),
      },
    });
  }
  await prisma.recurringTransaction.update({
    where: { id: ruleIds[0]! },
    data: {
      endDate: new Date('2024-01-02T00:00:00.000Z'),
      lastGeneratedDate: new Date('2024-01-02T00:00:00.000Z'),
      updatedAt: old,
    },
  });
  await prisma.transaction.create({
    data: {
      id: randomUUID(),
      ledgerId: ledger.id,
      ownerId: session.user.user_id,
      txType: 'expense',
      amount: '18.1234567891',
      nativeAmount: '18.1234567891',
      currencyCode: 'CNY',
      categoryId,
      categoryName: '旧分类',
      categoryKind: 'expense',
      happenedAt: new Date('2024-01-02T12:00:00.000Z'),
      recurringId: ruleIds[0]!,
      revision: 3,
      note: '仍在使用的历史',
      updatedAt: old,
      updatedByDeviceId: session.device_id,
      payerMemberId: registeredMemberId(ledger.id, session.user.user_id),
    },
  });
  const priorRows = await prisma.transaction.findMany({ where: { ledgerId: ledger.id }, orderBy: { id: 'asc' } });
  const priorLive = priorRows.find((row) => row.deletedAt === null)!;
  const priorDeadRule = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: ruleIds[1]! } });
  const priorLiveRule = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: ruleIds[0]! } });
  const priorCursor = (await prisma.syncChange.aggregate({ _max: { changeId: true } }))._max.changeId ?? 0n;
  if (entry !== 'batch') {
    // 活交易必须显式处理，分类删除不能把仍可见的账单变成未分类。
    const blocked = await request(session, 'DELETE', `/api/v1/ledgers/${ledger.id}/categories/${categoryId}`);
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'CATEGORY_HAS_TRANSACTIONS' });
    const deletedTransaction = await request(
      session,
      'DELETE',
      `/api/v1/ledgers/${ledger.id}/transactions/${priorLive.id}`,
      {
        base_revision: priorLive.revision,
      },
    );
    expect(deletedTransaction.statusCode, deletedTransaction.body).toBe(204);
  }
  if (entry === 'rest') {
    const response = await request(session, 'DELETE', `/api/v1/ledgers/${ledger.id}/categories/${categoryId}`);
    expect(response.statusCode, response.body).toBe(204);
  } else if (entry === 'sync') {
    const response = await request(session, 'POST', '/api/v1/sync/push', {
      device_id: session.device_id,
      changes: [
        {
          mutation_id: randomUUID(),
          entity_type: 'category',
          entity_id: categoryId,
          ledger_id: null,
          action: 'delete',
          updated_at: new Date().toISOString(),
          payload: {},
        },
      ],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().outcomes[0].status).toBe('accepted');
  } else {
    const preview = await request(session, 'POST', `/api/v1/ledgers/${ledger.id}/categories/removal-preview`, {
      category_ids: [categoryId],
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const response = await request(session, 'POST', `/api/v1/ledgers/${ledger.id}/categories/remove`, {
      category_ids: [categoryId],
      mode: 'delete',
      preview_token: preview.json().preview_token,
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  const afterRows = await prisma.transaction.findMany({ where: { ledgerId: ledger.id }, orderBy: { id: 'asc' } });
  expect(afterRows.filter((row) => priorRows.some((prior) => prior.id === row.id && prior.deletedAt))).toEqual(
    priorRows
      .filter((row) => row.deletedAt)
      .map((row) => ({ ...row, categoryId: null, categoryName: null, categoryKind: null })),
  );
  const afterLive = afterRows.find((row) => row.id === priorLive.id)!;
  expect(afterLive).toMatchObject({
    id: priorLive.id,
    ledgerId: priorLive.ledgerId,
    ownerId: priorLive.ownerId,
    txType: priorLive.txType,
    amount: priorLive.amount,
    nativeAmount: priorLive.nativeAmount,
    currencyCode: priorLive.currencyCode,
    happenedAt: priorLive.happenedAt,
    note: priorLive.note,
    recurringId: priorLive.recurringId,
    createdAt: priorLive.createdAt,
    payerMemberId: priorLive.payerMemberId,
    categoryId: null,
    categoryName: null,
    categoryKind: null,
    revision: priorLive.revision + 1,
  });
  expect(afterLive.deletedAt).not.toBeNull();
  const deadRule = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: ruleIds[1]! } });
  expect(deadRule).toEqual({ ...priorDeadRule, categoryId: null });
  const liveRule = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: ruleIds[0]! } });
  expect(liveRule).toEqual({
    ...priorLiveRule,
    categoryId: null,
    ...(entry === 'batch' ? { updatedAt: liveRule.updatedAt, updatedByDeviceId: session.device_id } : {}),
  });
  const otherCategory = await prisma.category.findUniqueOrThrow({
    where: { id_ownerId: { id: categoryId, ownerId: foreign.session.user.user_id } },
  });
  expect(otherCategory.deletedAt).toBeNull();
  expect(otherCategory.updatedAt).toEqual(old);
  const changes = await prisma.syncChange.findMany({ where: { ledgerId: ledger.id, changeId: { gt: priorCursor } } });
  expect(
    changes.some((row) => row.entityType === 'ledger' && (row.payload as { requires_full?: boolean }).requires_full),
  ).toBe(true);
  const fullResponse = await request(session, 'GET', `/api/v1/sync/full?ledger_id=${ledger.id}`);
  expect(fullResponse.statusCode, fullResponse.body).toBe(200);
  const full = fullResponse.json<{
    categories: Array<{ id: string }>;
    recurring_transactions: Array<{ id: string; category_id: string | null; last_generated_date: string | null }>;
    transactions: Array<{ id: string; recurring_id: string | null; category_id: string | null }>;
  }>();
  expect(full.categories.some((row) => row.id === categoryId)).toBe(false);
  expect(full.recurring_transactions).toEqual([
    expect.objectContaining({
      id: ruleIds[0],
      category_id: null,
      last_generated_date: priorLiveRule.lastGeneratedDate?.toISOString(),
    }),
  ]);
  expect(full.transactions).toEqual([]);
});
