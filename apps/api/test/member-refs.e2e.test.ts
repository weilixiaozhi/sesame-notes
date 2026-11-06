import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { registeredMemberId } from '../src/modules/accounting/index.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('member-refs'),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

function uuid(): string {
  return randomUUID();
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function api(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
  token?: string,
) {
  const response = await app.inject({
    method,
    url: await accountingRequestFixturePath(
      app,
      method,
      `${API_BASE}${path}`,
      token ? { authorization: `Bearer ${token}` } : {},
    ),
    payload: body,
    headers: {
      ...(token ? bearer(token) : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return {
    status: response.statusCode,
    json: (): unknown => (response.body ? JSON.parse(response.body) : null),
    body: response.body,
  };
}

/** 生成每次调用唯一且可登录的手机号（+86 区号，11 位） */
function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

/** 注册真实账号，并返回同账号其他设备登录所需的手机号。 */
async function registerUser(): Promise<{ token: string; deviceId: string; userId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone,
    password: 'password-123456',
    device: { installation_id: uuid(), name: 'e2e-device', platform: 'e2e' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as { access_token: string; device_id: string; user: { user_id: string } };
  return { token: session.access_token, deviceId: session.device_id, userId: session.user.user_id, phone };
}

/** 建账本 + 同步身份 + 占位成员（member 实体），返回绑定上下文。 */
async function setupLedgerWithPlaceholderMember(): Promise<{
  token: string;
  deviceId: string;
  userId: string;
  ledgerId: string;
  syncId: string;
  vUser: string;
}> {
  const { token, deviceId, userId } = await registerUser();
  const ledgerId = uuid();
  const ledgerPush = await api(
    'post',
    '/sync/push',
    {
      device_id: deviceId,
      changes: [
        {
          mutation_id: uuid(),
          entity_type: 'ledger',
          entity_id: ledgerId,
          ledger_id: ledgerId,
          action: 'upsert',
          updated_at: '2026-08-22T12:00:00.000Z',
          payload: { name: '成员引用账本', currency: 'CNY', month_start_day: 1, aa_enabled: true },
        },
      ],
    },
    token,
  );
  expect(ledgerPush.status).toBe(200);
  const syncId = (ledgerPush.json() as { outcomes: Array<{ sync_id?: string }> }).outcomes[0]!.sync_id!;
  const vUser = uuid();
  const memberPush = await api(
    'post',
    '/sync/push',
    {
      device_id: deviceId,
      changes: [
        {
          mutation_id: uuid(),
          entity_type: 'member',
          entity_id: vUser,
          ledger_id: ledgerId,
          sync_id: syncId,
          action: 'upsert',
          updated_at: '2026-08-22T12:00:00.000Z',
          payload: { display_name: '老婆' },
        },
      ],
    },
    token,
  );
  expect(memberPush.status).toBe(200);
  const outcome = (memberPush.json() as { outcomes: Array<{ status: string }> }).outcomes[0]!;
  expect(outcome.status).toBe('accepted');
  return { token, deviceId, userId, ledgerId, syncId, vUser };
}

/** 构造指定付款人与分摊成员的交易变更，其他交易字段使用有效固定值。 */
function txChange(
  deviceId: string,
  ledgerId: string,
  syncId: string,
  txnId: string,
  opts: { payerMemberId?: string; splits?: Array<Record<string, unknown>> } = {},
) {
  return {
    device_id: deviceId,
    changes: [
      {
        mutation_id: uuid(),
        entity_type: 'transaction',
        entity_id: txnId,
        ledger_id: ledgerId,
        sync_id: syncId,
        action: 'upsert',
        updated_at: '2026-08-22T12:00:00.000Z',
        payload: {
          tx_type: 'expense',
          amount: '100',
          happened_at: '2026-08-22T12:00:00.000Z',
          note: '成员引用',
          category_id: null,
          currency_code: 'CNY',
          native_amount: '100',
          recurring_id: null,
          payer_member_id: opts.payerMemberId ?? null,
          aa_mode: opts.splits ? '2' : null,
          splits: opts.splits ?? [],
          last_edited_at: null,
        },
      },
    ],
  };
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Transaction/AA member 引用', () => {
  it.each([
    ['空值', null],
    ['非法 UUID', 'not-a-uuid'],
  ])('分摊成员%s：REST 和导入拒绝写入，push 仅拒绝对应变更', async (_label, memberId) => {
    const { token, deviceId, userId, ledgerId, syncId } = await setupLedgerWithPlaceholderMember();
    const selfMember = registeredMemberId(ledgerId, userId);
    const invalidId = uuid();
    const validId = uuid();
    const invalid = txChange(deviceId, ledgerId, syncId, invalidId, {
      splits: [
        { member_id: selfMember, amount: '60' },
        { ...(memberId === undefined ? {} : { member_id: memberId }), amount: '40' },
      ],
    });
    const payload = invalid.changes[0]!.payload;
    const rest = await api('post', `/ledgers/${ledgerId}/transactions`, { ...payload, id: invalidId }, token);
    expect(rest.status).toBe(400);
    const imported = await api(
      'post',
      `/ledgers/${ledgerId}/imports`,
      {
        transactions: [
          { ...payload, id: validId, splits: [{ member_id: selfMember, amount: '100' }] },
          { ...payload, id: invalidId },
        ],
      },
      token,
    );
    expect(imported.status).toBe(400);
    expect(await prisma.transaction.count({ where: { id: { in: [validId, invalidId] } } })).toBe(0);

    const pushed = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          ...invalid.changes,
          ...txChange(deviceId, ledgerId, syncId, validId, {
            splits: [{ member_id: selfMember, amount: '100' }],
          }).changes,
        ],
      },
      token,
    );
    expect(pushed.status).toBe(200);
    expect(
      (pushed.json() as { outcomes: Array<{ status: string }> }).outcomes.map((outcome) => outcome.status),
    ).toEqual(['invalid', 'accepted']);
    expect(await prisma.transaction.findUnique({ where: { id: invalidId } })).toBeNull();
    expect(await prisma.transactionSplit.count({ where: { transactionId: invalidId } })).toBe(0);
    expect(await prisma.syncChange.count({ where: { entityId: invalidId } })).toBe(0);

    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: validId }, include: { splits: true } });
    const patch = await api(
      'patch',
      `/ledgers/${ledgerId}/transactions/${validId}`,
      {
        base_revision: 1,
        note: '不得写入',
        splits: payload.splits,
      },
      token,
    );
    expect(patch.status).toBe(400);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: validId }, include: { splits: true } })).toEqual(
      before,
    );
  });

  it.each(['REMOVED'] as const)('成员 %s 后历史分摊在 REST、full 和事件中保留原身份与金额', async (status) => {
    const { token, deviceId, ledgerId, syncId, vUser } = await setupLedgerWithPlaceholderMember();
    const editor = await registerUser();
    const memberId = registeredMemberId(ledgerId, editor.userId);
    await prisma.ledgerMember.create({
      data: {
        id: memberId,
        ledgerId,
        memberType: 'REGISTERED',
        status: 'ACTIVE',
        role: 'editor',
        linkedAccountId: editor.userId,
        displayName: '历史成员',
      },
    });
    const txnId = uuid();
    const splits = [
      { member_id: memberId, amount: '60' },
      { member_id: vUser, amount: '40' },
    ];
    const created = await api('post', '/sync/push', txChange(deviceId, ledgerId, syncId, txnId, { splits }), token);
    expect(created.status).toBe(200);
    const transition = await api('delete', `/ledgers/${ledgerId}/members/${memberId}`, undefined, token);
    expect(transition.status).toBe(204);
    const removedPlaceholder = await api('delete', `/ledgers/${ledgerId}/members/${vUser}`, undefined, token);
    expect(removedPlaceholder.status).toBe(204);
    const read = await api('get', `/ledgers/${ledgerId}/transactions`, undefined, token);
    expect(read.status).toBe(200);
    const historical = (read.json() as { items: Array<{ id: string; splits: unknown[] }> }).items.find(
      (item) => item.id === txnId,
    );
    expect(historical).toMatchObject({ splits: expect.arrayContaining(splits) });
    expect(historical!.splits).toHaveLength(2);
    const full = await api('get', `/sync/full?ledger_id=${ledgerId}`, undefined, token);
    expect(full.status).toBe(200);
    expect(full.json()).toMatchObject({
      members: expect.arrayContaining([expect.objectContaining({ id: memberId, status })]),
      transactions: expect.arrayContaining([
        expect.objectContaining({ id: txnId, splits: expect.arrayContaining(splits) }),
      ]),
    });
    const event = await prisma.syncChange.findFirstOrThrow({ where: { entityId: txnId, action: 'upsert' } });
    expect(event.payload).toMatchObject({ splits: expect.arrayContaining(splits) });
  });

  it('同账本 FK 约束：跨账本 split 参与人拒绝（invalid）', async () => {
    const a = await setupLedgerWithPlaceholderMember();
    const b = await setupLedgerWithPlaceholderMember();
    const txnId = uuid();
    const push = await api(
      'post',
      '/sync/push',
      txChange(a.deviceId, a.ledgerId, a.syncId, txnId, {
        payerMemberId: registeredMemberId(a.ledgerId, a.userId),
        splits: [{ member_id: registeredMemberId(b.ledgerId, b.userId), amount: '100' }],
      }),
      a.token,
    );
    expect(push.status).toBe(200);
    const outcome = (push.json() as { outcomes: Array<{ status: string }> }).outcomes[0]!;
    expect(outcome.status).toBe('invalid');
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn).toBeNull();
  });

  it('REST 默认付款人为记账人，混合 REGISTERED/PLACEHOLDER 分摊成员正确落库并返回', async () => {
    const { token, userId, ledgerId, vUser } = await setupLedgerWithPlaceholderMember();
    const txnId = uuid();
    const created = await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: txnId,
        tx_type: 'expense',
        amount: '100',
        happened_at: '2026-08-22T12:00:00.000Z',
        currency_code: 'CNY',
        native_amount: '100',
        aa_mode: '2',
        splits: [
          { member_id: registeredMemberId(ledgerId, userId), amount: '60' },
          { member_id: vUser, amount: '40' },
        ],
      },
      token,
    );
    expect(created.status).toBe(201);
    const body = created.json() as {
      created_by_member_id: string | null;
      payer_member_id: string | null;
      splits: Array<{ member_id: string | null; amount: string }>;
    };
    expect(body.created_by_member_id).toBe(registeredMemberId(ledgerId, userId));
    expect(body.payer_member_id).toBe(registeredMemberId(ledgerId, userId));
    expect(body.splits.map((s) => s.member_id)).toContain(vUser);
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn?.createdByMemberId).toBe(registeredMemberId(ledgerId, userId));
    const splitUser = await prisma.transactionSplit.findFirst({
      where: { transactionId: txnId, memberId: registeredMemberId(ledgerId, userId) },
    });
    expect(splitUser?.amount.toString()).toBe('60');
    const splitVu = await prisma.transactionSplit.findFirst({ where: { transactionId: txnId, memberId: vUser } });
    expect(splitVu?.amount.toString()).toBe('40');
  });
});
