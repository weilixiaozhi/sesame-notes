import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { exchangeRateOverrideId } from '../src/modules/accounting/index.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'accounting-web-tests-secret-at-least-32-bytes',
      STORAGE_PATH: testStoragePath('accounting-web'),
    }),
    authRateLimitMax: 1000,
    rateLimitMax: 1000,
  },
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 为每项集成用例创建全新账号，测试连接只来自显式隔离数据库变量。 */
async function register() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `139${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'accounting-web-test-password',
      device: { installation_id: randomUUID(), name: '记账测试', platform: 'test' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Session>();
}
/** 使用测试账号调用已注册路由。 */
function api(session: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${session.access_token}` },
    ...(payload ? { payload } : {}),
  });
}

it('数据库聚合覆盖全部有效支出与分页，精确区分本币、原币、分类和日期边界', async () => {
  const session = await register();
  const stranger = await register();
  const created = await api(session, 'POST', '/ledgers', { name: '统计测试', currency: 'CNY' });
  expect(created.statusCode).toBe(201);
  const ledger = created.json<{ id: string }>();
  const categoryResponse = await api(session, 'POST', `/ledgers/${ledger.id}/categories`, {
    name: '旅行',
    kind: 'expense',
    level: 1,
    sort_order: 0,
  });
  expect(categoryResponse.statusCode).toBe(201);
  const category = categoryResponse.json<{ id: string }>();
  const common = {
    ledgerId: ledger.id,
    ownerId: session.user.user_id,
    txType: 'expense',
    happenedAt: new Date('2026-09-01T00:00:00.000Z'),
    currencyCode: 'CNY',
    amount: '0.1',
    nativeAmount: '0.1',
  };
  await prisma.transaction.createMany({ data: Array.from({ length: 205 }, () => ({ ...common, id: randomUUID() })) });
  await prisma.transaction.createMany({
    data: [
      {
        ...common,
        currencyCode: 'USD',
        amount: '10',
        nativeAmount: '70',
        categoryId: category.id,
        categoryName: '旅行',
        categoryKind: 'expense',
      },
      { ...common, amount: '50', nativeAmount: '50' },
      { ...common, amount: '100', nativeAmount: '100', deletedAt: new Date() },
      { ...common, amount: '100', nativeAmount: '100', happenedAt: new Date('2026-08-31T23:59:59.999Z') },
      { ...common, amount: '100', nativeAmount: '100', happenedAt: new Date('2026-10-01T00:00:00.000Z') },
    ],
  });
  const query = 'start_at=2026-09-01T00%3A00%3A00.000Z&end_at=2026-10-01T00%3A00%3A00.000Z';
  const path = `/ledgers/${ledger.id}/transaction-stats?${query}`;
  const stats = await api(session, 'GET', path);
  expect(stats.statusCode, stats.body).toBe(200);
  expect(stats.json()).toMatchObject({
    ledger_currency: 'CNY',
    by_day: [{ date: '2026-09-01', native_total: '140.5', transaction_count: 207 }],
    expense_total: '140.5',
    transaction_count: 207,
    by_currency: [
      { currency_code: 'CNY', amount_total: '70.5', native_total: '70.5', transaction_count: 206 },
      { currency_code: 'USD', amount_total: '10', native_total: '70', transaction_count: 1 },
    ],
    by_category: [
      { category_id: null, native_total: '70.5', transaction_count: 206 },
      { category_id: category.id, category_name: '旅行', native_total: '70', transaction_count: 1 },
    ],
  });
  expect((await api(session, 'GET', `${path}&currency_code=USD`)).json()).toMatchObject({
    by_day: [{ date: '2026-09-01', native_total: '70', transaction_count: 1 }],
    expense_total: '70',
    transaction_count: 1,
  });
  expect((await api(session, 'GET', `${path}&category_id=uncategorized`)).json()).toMatchObject({
    expense_total: '70.5',
    transaction_count: 206,
  });
  expect((await api(session, 'GET', `${path}&time_zone=invalid/zone`)).statusCode).toBe(400);
  expect((await api(session, 'GET', `${path}&time_zone=America/Los_Angeles`)).json().by_day).toEqual([
    { date: '2026-08-31', native_total: '140.5', transaction_count: 207 },
  ]);
  expect((await api(stranger, 'GET', path)).statusCode).toBe(404);
  const first = await api(session, 'GET', `/ledgers/${ledger.id}/transactions?${query}&limit=200`);
  expect(first.json().items).toHaveLength(200);
  const next = await api(
    session,
    'GET',
    `/ledgers/${ledger.id}/transactions?${query}&limit=200&cursor=${encodeURIComponent(first.json().next_cursor)}`,
  );
  expect(next.json().items).toHaveLength(7);
  expect(next.json().next_cursor).toBeNull();
});

it('记账和同步无需统计标记，创建、编辑、增量和全量读回保持一致且全部计入统计', async () => {
  try {
    const session = await register();
    const ledgerResponse = await api(session, 'POST', '/ledgers', { name: '统一统计', currency: 'CNY' });
    expect(ledgerResponse.statusCode, ledgerResponse.body).toBe(201);
    const ledger = ledgerResponse.json<{ id: string; sync_id: string }>();
    const transactionPath = `/ledgers/${ledger.id}/transactions`;
    const input = {
      tx_type: 'expense',
      amount: '10',
      native_amount: '10',
      currency_code: 'CNY',
      happened_at: '2026-09-01T00:00:00.000Z',
    };
    const created = await api(session, 'POST', transactionPath, input);
    expect(created.statusCode, created.body).toBe(201);
    const transaction = created.json<{ id: string; revision: number }>();
    expect(created.json()).not.toHaveProperty('exclude_from_stats');
    const edited = await api(session, 'PATCH', `${transactionPath}/${transaction.id}`, {
      base_revision: transaction.revision,
      amount: '12',
      native_amount: '12',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ id: transaction.id, amount: '12', revision: transaction.revision + 1 });
    expect(edited.json()).not.toHaveProperty('exclude_from_stats');

    const offlineId = randomUUID();
    const mutation = {
      mutation_id: randomUUID(),
      entity_type: 'transaction',
      entity_id: offlineId,
      ledger_id: ledger.id,
      sync_id: ledger.sync_id,
      base_revision: 0,
      action: 'upsert',
      updated_at: '2026-09-01T00:00:00.000Z',
      payload: {
        ...input,
        amount: '3',
        native_amount: '3',
        note: null,
        category_id: null,
        recurring_id: null,
        aa_mode: null,
        splits: null,
        last_edited_at: null,
      },
    };
    const pushed = await api(session, 'POST', '/sync/push', { device_id: session.device_id, changes: [mutation] });
    expect(pushed.statusCode, pushed.body).toBe(200);
    expect(pushed.json().outcomes).toEqual([
      expect.objectContaining({ mutation_id: mutation.mutation_id, status: 'accepted', revision: 1 }),
    ]);
    const replay = await api(session, 'POST', '/sync/push', { device_id: session.device_id, changes: [mutation] });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().outcomes).toEqual([
      expect.objectContaining({ mutation_id: mutation.mutation_id, status: 'ignored', revision: 1 }),
    ]);

    const listed = await api(session, 'GET', transactionPath);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: transaction.id, amount: '12', revision: 2 }),
        expect.objectContaining({ id: offlineId, amount: '3', revision: 1 }),
      ]),
    );
    expect(listed.json().items).toHaveLength(2);
    for (const row of listed.json().items) expect(row).not.toHaveProperty('exclude_from_stats');

    const pulled = await api(session, 'GET', '/sync/pull?since=0&limit=1000');
    expect(pulled.statusCode, pulled.body).toBe(200);
    const changes = pulled
      .json()
      .changes.filter((change: { entity_type: string }) => change.entity_type === 'transaction');
    expect(changes).toHaveLength(3);
    for (const change of changes) expect(change.payload).not.toHaveProperty('exclude_from_stats');
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity_id: transaction.id,
          payload: expect.objectContaining({ amount: '12', revision: 2 }),
        }),
        expect.objectContaining({
          entity_id: offlineId,
          payload: expect.objectContaining({ amount: '3', revision: 1 }),
        }),
      ]),
    );
    const snapshot = await api(session, 'GET', `/sync/full?ledger_id=${ledger.id}&sync_id=${ledger.sync_id}`);
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(snapshot.json().transactions).toEqual(expect.arrayContaining(listed.json().items));
    expect(snapshot.json().transactions).toHaveLength(2);
    for (const row of snapshot.json().transactions) expect(row).not.toHaveProperty('exclude_from_stats');
    const stats = await api(session, 'GET', `/ledgers/${ledger.id}/transaction-stats`);
    expect(stats.statusCode, stats.body).toBe(200);
    expect(stats.json()).toMatchObject({ expense_total: '15', transaction_count: 2 });
  } catch (cause) {
    console.error('统一记账统计与同步闭环验证失败', { cause });
    throw new Error('记账与同步应使用完整交易资料并统计全部有效支出', { cause });
  }
});

it('参与者包含历史与占位成员', async () => {
  const session = await register();
  const stranger = await register();
  const created = await api(session, 'POST', '/ledgers', { name: '历史成员测试' });
  const ledger = created.json<{ id: string; sync_id: string }>();
  const member = await prisma.ledgerMember.create({
    data: {
      ledgerId: ledger.id,
      id: randomUUID(),
      displayName: '历史占位成员',
      memberType: 'PLACEHOLDER',
      role: 'editor',
      status: 'REMOVED',
    },
  });
  const participants = await api(session, 'GET', `/ledgers/${ledger.id}/participants`);
  expect(participants.statusCode, participants.body).toBe(200);
  expect(participants.json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: member.id, member_type: 'PLACEHOLDER', status: 'REMOVED' })]),
  );
  expect((await api(stranger, 'GET', `/ledgers/${ledger.id}/participants`)).statusCode).toBe(404);
});

it('账本换币原子重算且幂等，缺率与过期币种使现有数据不变', async () => {
  const session = await register();
  const ledgerResponse = await api(session, 'POST', '/ledgers', { name: '换币测试', currency: 'CNY' });
  const ledger = ledgerResponse.json<{ id: string }>();
  const created = await api(session, 'POST', `/ledgers/${ledger.id}/transactions`, {
    tx_type: 'expense',
    amount: '10',
    currency_code: 'USD',
    native_amount: '70',
    happened_at: '2026-09-01T00:00:00.000Z',
  });
  expect(created.statusCode, created.body).toBe(201);
  const transaction = created.json<{ id: string; revision: number }>();
  const key = randomUUID();
  const change = (payload: object, idempotencyKey = key) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/ledgers/${ledger.id}/change-currency`,
      headers: { authorization: `Bearer ${session.access_token}`, 'idempotency-key': idempotencyKey },
      payload,
    });
  const missing = await change({ currency: 'EUR', expected_currency: 'CNY', rates: {} });
  expect(missing.statusCode).toBe(400);
  expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })).currency).toBe('CNY');
  expect((await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).nativeAmount.toString()).toBe(
    '70',
  );
  const payload = { currency: 'EUR', expected_currency: 'CNY', rates: { USD: '0.9' } };
  const result = await change(payload);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({ ledger: { currency: 'EUR' }, updated_transactions: 1 });
  const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
  expect(updated.nativeAmount.toString()).toBe('9');
  expect(updated.amount.toString()).toBe('10');
  expect(updated.revision).toBe(transaction.revision + 1);
  const replay = await change(payload);
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toEqual(result.json());
  expect((await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).revision).toBe(
    updated.revision,
  );
  const stale = await change({ ...payload, currency: 'USD' }, randomUUID());
  expect(stale.statusCode).toBe(409);
  expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })).currency).toBe('EUR');
});

it('完整 AA 结算包含历史移除成员并单列不分摊交易，支持付款人与分摊模式分页筛选', async () => {
  const session = await register();
  const stranger = await register();
  const created = await api(session, 'POST', '/ledgers', { name: 'AA统计', currency: 'CNY', aa_enabled: true });
  expect(created.statusCode, created.body).toBe(201);
  const ledger = created.json();
  const owner = await prisma.ledgerMember.findFirstOrThrow({
    where: { ledgerId: ledger.id, linkedAccountId: session.user.user_id },
  });
  const second = await prisma.ledgerMember.create({
    data: {
      id: randomUUID(),
      ledgerId: ledger.id,
      displayName: '同伴',
      memberType: 'PLACEHOLDER',
      role: 'editor',
      status: 'ACTIVE',
    },
  });
  await prisma.ledgerMember.create({
    data: {
      id: randomUUID(),
      ledgerId: ledger.id,
      displayName: '历史同伴',
      memberType: 'PLACEHOLDER',
      role: 'editor',
      status: 'REMOVED',
    },
  });
  const common = {
    ledgerId: ledger.id,
    ownerId: session.user.user_id,
    createdByMemberId: owner.id,
    payerMemberId: owner.id,
    happenedAt: new Date(),
    currencyCode: 'CNY',
    amount: '10.005',
    nativeAmount: '10.005',
    txType: 'expense',
    aaMode: null,
  };
  await prisma.transaction.create({ data: common });
  await prisma.transaction.create({ data: { ...common, aaMode: 1, amount: '2', nativeAmount: '2' } });
  await prisma.transaction.create({ data: { ...common, payerMemberId: null, amount: '1', nativeAmount: '1' } });
  await prisma.transaction.create({
    data: {
      ...common,
      amount: '9',
      nativeAmount: '9',
      payerMemberId: second.id,
      aaMode: 2,
      splits: {
        create: [
          { memberId: owner.id, amount: '4' },
          { memberId: second.id, amount: '5' },
        ],
      },
    },
  });
  const response = await api(session, 'GET', `/ledgers/${ledger.id}/aa-stats`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    aa_enabled: true,
    transaction_count: 2,
    excluded_count: 1,
    skipped_count: 1,
  });
  expect(response.json().participants.find((row: { member_id: string }) => row.member_id === owner.id)).toMatchObject({
    total_paid: '10.005',
    total_should_pay: '7.345',
    net: '2.66',
    non_split_paid: '2',
  });
  const list = await api(
    session,
    'GET',
    `/ledgers/${ledger.id}/transactions?payer_member_id=${owner.id}&aa_mode=0&limit=1`,
  );
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().items).toHaveLength(1);
  expect(list.json().next_cursor).toBeNull();
  expect((await api(session, 'GET', `/ledgers/${ledger.id}/transactions?aa_mode=1`)).json().items).toHaveLength(1);
  expect((await api(stranger, 'GET', `/ledgers/${ledger.id}/aa-stats`)).statusCode).toBe(404);
});
it('导入必须携带完整预览参数，账本代次、币种和归档状态在写事务内核对', async () => {
  const session = await register();
  const created = await api(session, 'POST', '/ledgers', { name: '导入预览', currency: 'CNY' });
  const ledger = created.json();
  const path = `/ledgers/${ledger.id}/imports`;
  const guard = new URLSearchParams({
    expected_sync_id: ledger.sync_id,
    expected_currency: 'CNY',
    require_unarchived: 'true',
  });
  for (const field of ['expected_sync_id', 'expected_currency', 'require_unarchived']) {
    const incomplete = new URLSearchParams(guard);
    incomplete.delete(field);
    expect((await api(session, 'POST', `${path}?${incomplete}`, {})).statusCode).toBe(400);
  }
  expect((await api(session, 'POST', path, {})).statusCode).toBe(400);
  const wrongId = new URLSearchParams(guard);
  wrongId.set('expected_sync_id', randomUUID());
  expect((await api(session, 'POST', `${path}?${wrongId}`, {})).statusCode).toBe(409);
  const wrongCurrency = new URLSearchParams(guard);
  wrongCurrency.set('expected_currency', 'USD');
  expect((await api(session, 'POST', `${path}?${wrongCurrency}`, {})).statusCode).toBe(409);
  expect((await api(session, 'POST', `${path}?${guard}`, {})).statusCode).toBe(201);
  await prisma.ledgerMember.update({
    where: { ledgerId_linkedAccountId: { ledgerId: ledger.id, linkedAccountId: session.user.user_id } },
    data: { archivedAt: new Date(), archiveUpdatedAt: new Date(), archiveUpdatedByDeviceId: session.device_id },
  });
  expect(
    (
      await api(
        session,
        'POST',
        `${path}?expected_sync_id=${ledger.sync_id}&expected_currency=CNY&require_unarchived=true`,
        {},
      )
    ).statusCode,
  ).toBe(409);
  expect((await api(session, 'POST', path, {})).statusCode).toBe(400);
  expect(await prisma.transaction.count({ where: { ledgerId: ledger.id } })).toBe(0);
});

it('个人汇率覆盖只返回本人未删除数据，保持十八位精度并支持本币筛选', async () => {
  const actor = await register();
  const other = await register();
  for (const [ownerId, base, quote, deleted] of [
    [actor.user.user_id, 'CNY', 'USD', false],
    [actor.user.user_id, 'EUR', 'USD', false],
    [actor.user.user_id, 'CNY', 'EUR', true],
    [other.user.user_id, 'CNY', 'JPY', false],
  ] as const) {
    await prisma.exchangeRateOverride.create({
      data: {
        id: exchangeRateOverrideId(ownerId, base, quote),
        ownerId,
        baseCurrency: base,
        quoteCurrency: quote,
        rate: '1.123456789012345678',
        deletedAt: deleted ? new Date() : null,
      },
    });
  }
  const response = await api(actor, 'GET', '/exchange-rate-overrides?base=CNY');
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toHaveLength(1);
  expect(response.json()[0]).toMatchObject({
    base_currency: 'CNY',
    quote_currency: 'USD',
    rate: '1.123456789012345678',
  });
  expect((await api(actor, 'GET', '/exchange-rate-overrides')).json()).toHaveLength(2);
});

it('账本删除在同一事务核对代次和预览指纹，拒绝预览后的新增交易', async () => {
  const session = await register();
  const stranger = await register();
  const created = await api(session, 'POST', '/ledgers', { name: '删除保护测试', currency: 'CNY' });
  const ledger = created.json<{ id: string; sync_id: string }>();
  const path = `/ledgers/${ledger.id}`;
  const preview = (await api(session, 'GET', `${path}/action-preview`)).json<{
    sync_id: string;
    fingerprint: string;
  }>();
  expect(preview.sync_id).toBe(ledger.sync_id);
  expect((await api(stranger, 'GET', `${path}/action-preview`)).statusCode).toBe(404);
  expect((await api(session, 'DELETE', path)).statusCode).toBe(400);
  expect((await api(session, 'DELETE', `${path}?expected_sync_id=${preview.sync_id}`)).statusCode).toBe(400);
  expect((await api(session, 'DELETE', `${path}?expected_fingerprint=${preview.fingerprint}`)).statusCode).toBe(400);
  expect(
    (
      await api(
        session,
        'DELETE',
        `${path}?expected_sync_id=${randomUUID()}&expected_fingerprint=${preview.fingerprint}`,
      )
    ).statusCode,
  ).toBe(409);
  const row = await prisma.transaction.create({
    data: {
      id: randomUUID(),
      ledgerId: ledger.id,
      ownerId: session.user.user_id,
      txType: 'expense',
      amount: '3',
      nativeAmount: '3',
      currencyCode: 'CNY',
      happenedAt: new Date(),
    },
  });
  expect(
    (
      await api(
        session,
        'DELETE',
        `${path}?expected_sync_id=${preview.sync_id}&expected_fingerprint=${preview.fingerprint}`,
      )
    ).statusCode,
  ).toBe(409);
  expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).deletedAt).toBeNull();
  const fresh = (await api(session, 'GET', `${path}/action-preview`)).json<{
    sync_id: string;
    fingerprint: string;
    transaction_count: number;
  }>();
  expect(fresh.transaction_count).toBe(1);
  expect(
    (
      await api(
        session,
        'DELETE',
        `${path}?expected_sync_id=${fresh.sync_id}&expected_fingerprint=${fresh.fingerprint}`,
      )
    ).statusCode,
  ).toBe(204);
  expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })).deletedAt).not.toBeNull();
});
