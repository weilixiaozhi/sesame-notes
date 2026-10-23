import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { registeredMemberId } from '../src/modules/accounting/index.js';
import { uuidV5 } from '../src/shared/uuid.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

type PullBody = {
  changes: Array<{
    ledger_id: string | null;
    entity_type: string;
    entity_id: string;
    payload: { status?: string; requires_full?: boolean };
  }>;
  server_cursor: string;
};

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('e2e-db'),
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
      // 任何带 body 的方法（POST/PATCH）都必须声明 JSON，否则 Fastify 不解析请求体
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

/** 注册真实账号，返回共享、同步及多设备登录用例消费的身份与会话。 */
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

/** 断言分类快照级联只生成账本失效事件，不逐笔复制交易变更。 */
async function expectCategoryInvalidations(afterChangeId: bigint, ledgerIds: string[]): Promise<void> {
  const changes = await prisma.syncChange.findMany({
    where: { changeId: { gt: afterChangeId }, entityType: 'ledger', entityId: { in: ledgerIds } },
  });
  expect(changes.map((change) => change.entityId).sort()).toEqual([...ledgerIds].sort());
  for (const change of changes) {
    expect(change.payload).toMatchObject({ requires_full: true });
  }
  expect(
    await prisma.syncChange.count({
      where: { changeId: { gt: afterChangeId }, ledgerId: { in: ledgerIds }, entityType: 'transaction' },
    }),
  ).toBe(0);
}

/** 构造周期账单同步载荷，仅让分类归属成为测试变量。 */
function recurringPayload(categoryId: string | null): Record<string, unknown> {
  return {
    tx_type: 'expense',
    amount: '1',
    currency_code: 'CNY',
    category_id: categoryId,
    note: null,
    frequency: 'monthly',
    protocol_version: 1,
    time_zone: 'UTC',
    interval: 1,
    day_of_month: 1,
    day_of_week: null,
    month_of_year: null,
    start_date: new Date().toISOString(),
    end_date: null,
    last_generated_date: null,
    enabled: true,
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

describe('真实 PostgreSQL E2E', () => {
  it.each([29, 30, 31])('每月起始日 %i 可经 REST 创建、更新及同步保存', async (day) => {
    const { token, deviceId } = await registerUser();
    const created = await api('post', '/ledgers', { name: '月末周期', month_start_day: day }, token);
    expect(created.status).toBe(201);
    const ledger = created.json() as { id: string; month_start_day: number };
    expect(ledger.month_start_day).toBe(day);
    expect((await api('patch', `/ledgers/${ledger.id}`, { month_start_day: 1 }, token)).status).toBe(200);
    const updated = await api('patch', `/ledgers/${ledger.id}`, { month_start_day: day }, token);
    expect(updated.status).toBe(200);
    expect(updated.json()).toMatchObject({ month_start_day: day });
    expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })).monthStartDay).toBe(day);

    const syncedId = uuid();
    const pushed = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'ledger',
            entity_id: syncedId,
            ledger_id: syncedId,
            action: 'upsert',
            updated_at: new Date().toISOString(),
            payload: { name: '同步月末周期', currency: 'CNY', month_start_day: day, aa_enabled: false },
          },
        ],
      },
      token,
    );
    expect(pushed.status).toBe(200);
    expect(pushed.json()).toMatchObject({ outcomes: [{ status: 'accepted' }] });
    expect((await prisma.ledger.findUniqueOrThrow({ where: { id: syncedId } })).monthStartDay).toBe(day);
    const snapshot = await api('get', `/sync/full?ledger_id=${syncedId}`, undefined, token);
    expect(snapshot.status).toBe(200);
    expect(snapshot.json()).toMatchObject({ ledger: { month_start_day: day } });
  });

  it.each([0, 32])('每月起始日 %i 被 REST 和同步拒绝，账本原值保留', async (day) => {
    const { token, deviceId } = await registerUser();
    expect((await api('post', '/ledgers', { name: '非法周期', month_start_day: day }, token)).status).toBe(400);
    const created = await api('post', '/ledgers', { name: '正常周期', month_start_day: 1 }, token);
    expect(created.status).toBe(201);
    const ledger = created.json() as { id: string };
    expect((await api('patch', `/ledgers/${ledger.id}`, { month_start_day: day }, token)).status).toBe(400);
    expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })).monthStartDay).toBe(1);
    const syncedId = uuid();
    const pushed = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'ledger',
            entity_id: syncedId,
            ledger_id: syncedId,
            action: 'upsert',
            updated_at: new Date().toISOString(),
            payload: { name: '非法同步周期', currency: 'CNY', month_start_day: day, aa_enabled: false },
          },
        ],
      },
      token,
    );
    expect(pushed.status).toBe(400);
    expect(await prisma.ledger.findUnique({ where: { id: syncedId } })).toBeNull();
  });

  it.each(['income', 'transfer'])('只允许支出：REST、导入和同步拒绝 %s，原有支出保持可读', async (invalidType) => {
    const { token, deviceId } = await registerUser();
    const ledgerId = uuid();
    const ledger = await api('post', '/ledgers', { id: ledgerId, name: '支出账本' }, token);
    expect(ledger.status).toBe(201);
    const { sync_id: syncId } = ledger.json() as { sync_id: string };
    const transactionId = uuid();
    const transaction = {
      tx_type: 'expense',
      amount: '12.5',
      happened_at: '2026-09-01T00:00:00.000Z',
      currency_code: 'CNY',
      native_amount: '12.5',
    };
    expect(
      (await api('post', `/ledgers/${ledgerId}/transactions`, { id: transactionId, ...transaction }, token)).status,
    ).toBe(201);
    const categoryId = uuid();
    const category = { name: '支出类型验收分类', kind: 'expense', level: 1, sort_order: 0 };
    expect((await api('post', `/ledgers/${ledgerId}/categories`, { id: categoryId, ...category }, token)).status).toBe(
      201,
    );

    expect
      .soft(
        (await api('post', `/ledgers/${ledgerId}/transactions`, { ...transaction, tx_type: invalidType }, token))
          .status,
      )
      .toBe(400);
    expect
      .soft(
        (
          await api(
            'patch',
            `/ledgers/${ledgerId}/transactions/${transactionId}`,
            { tx_type: invalidType, base_revision: 1 },
            token,
          )
        ).status,
      )
      .toBe(400);
    expect
      .soft((await api('post', `/ledgers/${ledgerId}/categories`, { ...category, kind: invalidType }, token)).status)
      .toBe(400);
    expect
      .soft((await api('patch', `/ledgers/${ledgerId}/categories/${categoryId}`, { kind: invalidType }, token)).status)
      .toBe(400);
    expect
      .soft(
        (
          await api(
            'post',
            `/ledgers/${ledgerId}/imports`,
            { transactions: [{ ...transaction, tx_type: invalidType }] },
            token,
          )
        ).status,
      )
      .toBe(400);
    expect
      .soft(
        (await api('post', `/ledgers/${ledgerId}/imports`, { categories: [{ ...category, kind: invalidType }] }, token))
          .status,
      )
      .toBe(400);

    // 分别验证三个同步实体的信任边界，非法载荷不能写入数据库。
    for (const [entityType, payload] of [
      [
        'transaction',
        {
          ...transaction,
          tx_type: invalidType,
          note: null,
          category_id: null,
          recurring_id: null,
          aa_mode: null,
          splits: [],
          last_edited_at: null,
        },
      ],
      ['category', { ...category, kind: invalidType, icon: null, parent_id: null }],
      ['recurring_transaction', { ...recurringPayload(null), tx_type: invalidType }],
    ] as const) {
      const pushed = await api(
        'post',
        '/sync/push',
        {
          device_id: deviceId,
          changes: [
            {
              mutation_id: uuid(),
              entity_id: uuid(),
              entity_type: entityType,
              ledger_id: entityType === 'category' ? null : ledgerId,
              ...(entityType === 'category' ? {} : { sync_id: syncId }),
              action: 'upsert',
              updated_at: new Date().toISOString(),
              payload,
            },
          ],
        },
        token,
      );
      expect.soft(pushed.status, entityType).toBe(400);
    }

    const stats = await api('get', `/ledgers/${ledgerId}/member-stats?scope=all`, undefined, token);
    expect(stats.status).toBe(200);
    const { items } = stats.json() as { items: Array<Record<string, unknown>> };
    expect.soft(items).toHaveLength(1);
    expect.soft(items[0]).toMatchObject({ expense_total: '12.5', tx_count: 1 });
    expect.soft(items[0]).not.toHaveProperty('income_total');
    expect.soft(await prisma.transaction.count({ where: { ledgerId } })).toBe(1);
    expect.soft(await prisma.recurringTransaction.count({ where: { ledgerId } })).toBe(0);
  });

  it('readiness：数据库可用时返回 200 与请求编号', async () => {
    const response = await app.inject({ method: 'GET', url: `${API_BASE}/health/ready` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', request_id: response.headers['x-request-id'] });
  });

  it('注册 → 登录 → 个人资料', async () => {
    const { deviceId, userId, phone } = await registerUser();
    expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const login = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password: 'password-123456',
      device: { installation_id: uuid(), name: 'e2e-device', platform: 'e2e' },
    });
    expect(login.status).toBe(200);
    const loginSession = login.json() as { access_token: string; device_id: string; user: { user_id: string } };
    expect(loginSession.user.user_id).toBe(userId);

    const me = await api('get', '/profile/me', undefined, loginSession.access_token);
    expect(me.status).toBe(200);
    const profile = me.json() as { user_id: string; sesame_number: string; phone: string };
    // 本人资料返回完整手机号，不含 account 或 phone_masked 字段。
    expect(JSON.stringify(profile)).not.toContain('account');
    expect(profile.sesame_number).toMatch(/^[1-9]\d{8}$/);
    expect(profile.phone).toMatch(/^\+86\d{11}$/);
    expect(profile).not.toHaveProperty('phone_masked');
    expect(profile.user_id).toBe(userId);
  });

  it('创建账本（客户端 UUID）→ 交易（Decimal 精确往返）', async () => {
    const { token, userId } = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/ledgers', { id: ledgerId, name: 'E2E 账本', currency: 'CNY' }, token);
    expect(create.status).toBe(201);
    const ledger = create.json() as { id: string; name: string; role: string; member_count: number };
    expect(ledger.id).toBe(ledgerId);
    expect(ledger.role).toBe('owner');
    expect(ledger.member_count).toBe(1);
    // 创建账本即创建 owner Member（一等成员），id 按 golden 派生公式计算
    const ownerMember = await prisma.ledgerMember.findUnique({
      where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: userId } },
    });
    expect(ownerMember).not.toBeNull();
    expect(ownerMember!.role).toBe('owner');
    expect(ownerMember!.memberType).toBe('REGISTERED');
    expect(ownerMember!.status).toBe('ACTIVE');
    expect(ownerMember!.id).toBe(registeredMemberId(ledgerId, userId));
    // 只检查本用例真实创建的账本，确保 owner 不变量有明确的数据前置。
    expect(await prisma.ledgerMember.count({ where: { ledgerId, role: 'owner', status: 'ACTIVE' } })).toBe(1);

    const listLedgers = await api('get', '/ledgers', undefined, token);
    expect(listLedgers.status).toBe(200);
    expect(listLedgers.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ledgerId, role: 'owner' })]),
    );

    const txnId = uuid();
    const bigAmount = '1234567890.0123456789';
    const tx = await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: txnId,
        tx_type: 'expense',
        amount: bigAmount,
        happened_at: '2026-08-19T10:00:00.000Z',
        note: 'decimal 精度验证',
        currency_code: 'CNY',
        native_amount: bigAmount,
      },
      token,
    );
    expect(tx.status).toBe(201);
    const created = tx.json() as { id: string; amount: string; native_amount: string };
    expect(created.id).toBe(txnId);
    expect(created.amount).toBe(bigAmount);

    const list = await api('get', `/ledgers/${ledgerId}/transactions`, undefined, token);
    expect(list.status).toBe(200);
    const page = list.json() as { items: Array<{ id: string; amount: string }> };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.amount).toBe(bigAmount);
  });

  it('同步 push → pull → full 与删除标记', async () => {
    const { token, deviceId, userId } = await registerUser();
    const ledgerId = uuid();
    const txnId = uuid();
    const updatedAt = '2026-08-19T11:00:00.000Z';

    // 先 push 账本创建建立绑定（无 sync_id，服务端生成并随 outcome 返回）
    const push = await api(
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
            updated_at: updatedAt,
            payload: { name: '同步账本', currency: 'CNY', month_start_day: 1, aa_enabled: false },
          },
        ],
      },
      token,
    );
    expect(push.status).toBe(200);
    const pushResult = push.json() as {
      outcomes: Array<{ entity_id: string; status: string; sync_id?: string }>;
      server_cursor: string;
    };
    expect(pushResult.outcomes).toHaveLength(1);
    expect(pushResult.outcomes[0]!.status).toBe('accepted');
    const syncId = pushResult.outcomes[0]!.sync_id!;
    expect(syncId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // 绑定建立后，账本级变更必须携带 sync_id
    const push2 = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'transaction',
            entity_id: txnId,
            ledger_id: ledgerId,
            sync_id: syncId,
            action: 'upsert',
            updated_at: updatedAt,
            payload: {
              tx_type: 'expense',
              amount: '88.88',
              happened_at: '2026-08-19T11:00:00.000Z',
              note: '同步交易',
              category_id: null,
              currency_code: 'CNY',
              native_amount: '88.88',
              recurring_id: null,
              aa_mode: null,
              splits: [],
              version: 1,
              last_edited_at: updatedAt,
            },
          },
        ],
      },
      token,
    );
    expect(push2.status).toBe(200);
    const push2Result = push2.json() as {
      outcomes: Array<{ entity_id: string; status: string }>;
      server_cursor: string;
    };
    expect(push2Result.outcomes).toHaveLength(1);
    expect(push2Result.outcomes[0]!.status).toBe('accepted');
    expect(Number(push2Result.server_cursor)).toBeGreaterThan(0);

    const pull = await api('get', '/sync/pull?since=0', undefined, token);
    expect(pull.status).toBe(200);
    const pulled = pull.json() as {
      changes: Array<{
        entity_type: string;
        entity_id: string;
        action: string;
        payload: { amount?: string; owner_id?: string };
      }>;
      server_cursor: string;
    };
    // 初始目录与本例账本、交易使用同一同步时间线，分别核对各自的完整事件集合。
    const categoryEvents = pulled.changes.filter((change) => change.entity_type === 'category');
    expect(categoryEvents).toHaveLength(61);
    expect(new Set(categoryEvents.map((change) => change.entity_id)).size).toBe(61);
    expect(categoryEvents.every((change) => change.action === 'upsert' && change.payload.owner_id === userId)).toBe(
      true,
    );
    const businessEvents = pulled.changes.filter((change) => ['ledger', 'transaction'].includes(change.entity_type));
    expect(businessEvents).toHaveLength(2);
    expect(businessEvents.map((change) => [change.entity_type, change.entity_id, change.action])).toEqual([
      ['ledger', ledgerId, 'upsert'],
      ['transaction', txnId, 'upsert'],
    ]);
    expect(pulled.changes.some((c) => c.entity_type === 'transaction' && c.payload.amount === '88.88')).toBe(true);
    expect(pulled.changes.some((c) => c.entity_type === 'ledger')).toBe(true);

    const full = await api('get', `/sync/full?ledger_id=${ledgerId}`, undefined, token);
    expect(full.status).toBe(200);
    const snapshot = full.json() as {
      ledger: { id: string };
      transactions: Array<{ id: string; amount: string }>;
      categories: unknown[];
    };
    expect(snapshot.ledger.id).toBe(ledgerId);
    expect(snapshot.transactions).toHaveLength(1);
    expect(snapshot.transactions[0]!.amount).toBe('88.88');

    // 删除标记（软删除）→ pull 出现 delete action
    const del = await api('delete', `/ledgers/${ledgerId}/transactions/${txnId}`, { base_revision: 1 }, token);
    expect(del.status).toBe(204);
    const pullAfterDelete = await api('get', '/sync/pull?since=0', undefined, token);
    const afterDelete = pullAfterDelete.json() as { changes: Array<{ entity_id: string; action: string }> };
    expect(afterDelete.changes.filter((c) => c.entity_id === txnId && c.action === 'delete')).toHaveLength(1);

    // 服务端数据层：事务写入 sync_changes 与 transactions 同事务
    const dbTxn = await prisma.transaction.findUnique({ where: { id: txnId } });
    expect(dbTxn).not.toBeNull();
    expect(dbTxn!.deletedAt).not.toBeNull();
    // 推送创建时 revision=1，REST 删除会递增 revision
    expect(dbTxn!.revision).toBe(2);
    const changes = await prisma.syncChange.findMany({ where: { userId, entityId: txnId } });
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it('共享：邀请 → 接受 → 成员 → 共享资源 → 成员统计', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/ledgers', { id: ledgerId, name: '共享账本' }, owner.token);
    expect(create.status).toBe(201);

    const invite = await api('post', `/ledgers/${ledgerId}/invites`, { role: 'editor' }, owner.token);
    expect(invite.status).toBe(201);
    const inviteBody = invite.json() as { code: string; expires_at: string };

    // 预览邀请要求传入完整邀请码
    const preview = await api('get', `/invites/${inviteBody.code}`, undefined, member.token);
    expect(preview.status).toBe(200);
    const previewBody = preview.json() as { ledger_id: string; ledger_name: string };
    expect(previewBody.ledger_id).toBe(ledgerId);

    // 接受邀请要求传入完整邀请码
    const accept = await api('post', `/invites/${inviteBody.code}/accept`, {}, member.token);
    expect(accept.status).toBe(200);

    // 成员列表
    const members = await api('get', `/ledgers/${ledgerId}/members`, undefined, owner.token);
    expect(members.status).toBe(200);
    const memberList = members.json() as Array<{ user_id: string; role: string }>;
    expect(memberList).toHaveLength(2);
    expect(memberList.some((m) => m.user_id === owner.userId && m.role === 'owner')).toBe(true);
    expect(memberList.some((m) => m.user_id === member.userId && m.role === 'editor')).toBe(true);
    expect(await prisma.ledgerMember.findMany({ where: { ledgerId } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ linkedAccountId: owner.userId, role: 'owner' }),
        expect.objectContaining({ linkedAccountId: member.userId, role: 'editor' }),
      ]),
    );

    // 共享资源：分类属于 Owner
    const category = await api(
      'post',
      `/ledgers/${ledgerId}/categories`,
      { name: '共享验收分类', kind: 'expense', level: 1, sort_order: 1 },
      owner.token,
    );
    expect(category.status).toBe(201);
    const shared = await api('get', `/ledgers/${ledgerId}/shared-resources`, undefined, member.token);
    expect(shared.status).toBe(200);
    const sharedBody = shared.json() as { owner_user_id: string; categories: Array<{ name: string }> };
    expect(sharedBody.owner_user_id).toBe(owner.userId);
    expect(sharedBody.categories.some((c) => c.name === '共享验收分类')).toBe(true);

    // 成员统计
    const stats = await api('get', `/ledgers/${ledgerId}/member-stats`, undefined, owner.token);
    expect(stats.status).toBe(200);

    // 共享成员能拉取 Owner 的同步事件（分类）
    const memberPull = await api('get', '/sync/pull?since=0', undefined, member.token);
    expect(memberPull.status).toBe(200);
  });

  it('新邀请码原子替换本账本未使用邀请，并发创建仅保留最后一个', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ledgerId = uuid();
    const otherId = uuid();
    for (const id of [ledgerId, otherId]) {
      expect((await api('post', '/ledgers', { id, name: '邀请码替换' }, owner.token)).status).toBe(201);
    }
    const createInvite = async (id: string) => {
      const response = await api('post', `/ledgers/${id}/invites`, {}, owner.token);
      expect(response.status).toBe(201);
      return response.json() as { id: string; code: string };
    };
    const used = await createInvite(ledgerId);
    expect((await api('post', `/invites/${used.code}/accept`, {}, member.token)).status).toBe(200);
    const old = await createInvite(ledgerId);
    const other = await createInvite(otherId);
    // 未授权和非法请求不得提前撤销已有邀请。
    expect((await api('post', `/ledgers/${ledgerId}/invites`, {}, member.token)).status).toBe(403);
    expect((await api('post', `/ledgers/${ledgerId}/invites`, { expires_in_hours: 0 }, owner.token)).status).toBe(400);
    expect((await api('get', `/invites/${old.code}`, undefined, owner.token)).status).toBe(200);
    const fresh = await Promise.all([createInvite(ledgerId), createInvite(ledgerId)]);
    expect((await api('get', `/invites/${old.code}`, undefined, owner.token)).status).toBe(404);
    expect((await api('post', `/invites/${old.code}/accept`, {}, member.token)).status).toBe(404);
    const previews = await Promise.all(
      fresh.map((invite) => api('get', `/invites/${invite.code}`, undefined, owner.token)),
    );
    expect(previews.map((result) => result.status).sort()).toEqual([200, 404]);
    expect(await prisma.ledgerInvite.count({ where: { ledgerId, usedAt: null, revokedAt: null } })).toBe(1);
    expect((await prisma.ledgerInvite.findUniqueOrThrow({ where: { id: used.id } })).revokedAt).toBeNull();
    expect((await api('get', `/invites/${other.code}`, undefined, owner.token)).status).toBe(200);
    expect((await api('get', `/ledgers/${ledgerId}/invites`, undefined, owner.token)).status).toBe(404);
    expect((await api('delete', `/ledgers/${ledgerId}/invites/${old.id}`, undefined, owner.token)).status).toBe(404);
    expect((await api('post', `/ledgers/${ledgerId}/members/${uuid()}/claim`, {}, owner.token)).status).toBe(404);
  });

  it('同步条件删本保护快照后的新增内容，确认后共用邀请撤销且不复活墓碑', async () => {
    const owner = await registerUser();
    const ledgerId = uuid();
    expect((await api('post', '/ledgers', { id: ledgerId, name: '全局删除规则' }, owner.token)).status).toBe(201);
    const inviteResponse = await api('post', `/ledgers/${ledgerId}/invites`, {}, owner.token);
    expect(inviteResponse.status).toBe(201);
    const invite = inviteResponse.json() as { id: string; code: string };
    const snapshot = async () => {
      const full = await api('get', `/sync/full?ledger_id=${ledgerId}`, undefined, owner.token);
      expect(full.status).toBe(200);
      return full.json() as { server_cursor: string; ledger: { sync_id: string } };
    };
    const original = await snapshot();
    const renamed = await api('patch', `/ledgers/${ledgerId}`, { name: '另一设备更新' }, owner.token);
    expect(renamed.status).toBe(200);
    const remove = (cursor: string) =>
      api(
        'post',
        '/sync/push',
        {
          device_id: owner.deviceId,
          changes: [
            {
              mutation_id: uuid(),
              entity_type: 'ledger',
              entity_id: ledgerId,
              ledger_id: ledgerId,
              sync_id: original.ledger.sync_id,
              action: 'delete',
              updated_at: '2001-01-01T00:00:00.000Z',
              payload: { expected_full_cursor: cursor },
            },
          ],
        },
        owner.token,
      );
    const rejected = await remove(original.server_cursor);
    expect(rejected.status).toBe(200);
    expect((rejected.json() as { outcomes: Array<{ status: string }> }).outcomes[0]!.status).toBe('invalid');
    expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } })).deletedAt).toBeNull();
    expect((await prisma.ledgerInvite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).toBeNull();
    const confirmed = await remove((await snapshot()).server_cursor);
    expect(confirmed.status).toBe(200);
    expect((confirmed.json() as { outcomes: Array<{ status: string }> }).outcomes[0]!.status).toBe('accepted');
    expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } })).deletedAt).not.toBeNull();
    expect((await prisma.ledgerInvite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).not.toBeNull();
    const resurrected = await api(
      'post',
      '/sync/push',
      {
        device_id: owner.deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'ledger',
            entity_id: ledgerId,
            ledger_id: ledgerId,
            sync_id: original.ledger.sync_id,
            action: 'upsert',
            updated_at: new Date().toISOString(),
            payload: { name: '不可复活', currency: 'CNY', month_start_day: 1, aa_enabled: false },
          },
        ],
      },
      owner.token,
    );
    expect(resurrected.status).toBe(200);
    expect(
      (resurrected.json() as { outcomes: Array<{ status: string; current_deleted: boolean }> }).outcomes[0],
    ).toMatchObject({ status: 'conflict', current_deleted: true });
  });

  it('账本删除后撤销未消费邀请，预览和接受均返回 404', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ledgerId = uuid();
    expect((await api('post', '/ledgers', { id: ledgerId, name: '待删除邀请账本' }, owner.token)).status).toBe(201);

    const inviteResponse = await api('post', `/ledgers/${ledgerId}/invites`, {}, owner.token);
    expect(inviteResponse.status).toBe(201);
    const invite = inviteResponse.json() as { id: string; code: string };

    expect((await api('delete', `/ledgers/${ledgerId}`, undefined, owner.token)).status).toBe(204);
    expect((await api('get', `/invites/${invite.code}`)).status).toBe(404);
    expect((await api('post', `/invites/${invite.code}/accept`, {}, member.token)).status).toBe(404);

    const storedInvite = await prisma.ledgerInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(storedInvite.revokedAt).not.toBeNull();
    expect(storedInvite.usedAt).toBeNull();
    expect(
      await prisma.ledgerMember.findUnique({
        where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: member.userId } },
      }),
    ).toBeNull();
  });

  it('Decimal 精度：numeric(38,10) 完整往返不失真', async () => {
    const { token } = await registerUser();
    const ledgerId = uuid();
    await api('post', '/ledgers', { id: ledgerId, name: '精度账本' }, token);

    const values = ['0.01', '99999999999999999999.9999999999', '12345.6789012345'];
    for (const value of values) {
      const tx = await api(
        'post',
        `/ledgers/${ledgerId}/transactions`,
        {
          id: uuid(),
          tx_type: 'expense',
          amount: value,
          happened_at: '2026-08-19T12:00:00.000Z',
          note: null,
          currency_code: 'CNY',
          native_amount: value,
        },
        token,
      );
      expect(tx.status).toBe(201);
      const created = tx.json() as { amount: string };
      expect(created.amount).toBe(value);
    }

    // 直接查库确认 numeric 存储值
    const rows = await prisma.transaction.findMany({ where: { ledgerId }, orderBy: { amount: 'asc' } });
    expect(rows.map((r) => r.amount.toString())).toEqual([...values].sort((a, b) => Number(a) - Number(b)));
  });
  it('交易幂等键忽略 JSON 字段顺序，重放不重复创建交易', async () => {
    const { token } = await registerUser();
    // 幂等键创建交易：首次 201，同键重放 200，且数据库只有一条
    const ledgerId = uuid();
    const create = await api('post', '/ledgers', { id: ledgerId, name: '幂等账本' }, token);
    expect(create.status).toBe(201);
    const txBody = {
      id: uuid(),
      tx_type: 'expense' as const,
      amount: '9.99',
      happened_at: '2026-08-19T13:00:00.000Z',
      currency_code: 'CNY',
      native_amount: '9.99',
    };
    const first = await app.inject({
      method: 'post',
      url: `${API_BASE}/ledgers/${ledgerId}/transactions`,
      payload: txBody,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'e2e-idem-key-0001',
      },
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: 'post',
      url: `${API_BASE}/ledgers/${ledgerId}/transactions`,
      // 同一 JSON 语义即使命名字段顺序不同，也必须命中同一个稳定请求指纹。
      payload: {
        native_amount: '9.99',
        currency_code: 'CNY',
        happened_at: '2026-08-19T13:00:00.000Z',
        amount: '9.99',
        tx_type: 'expense',
        id: txBody.id,
      },
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'e2e-idem-key-0001',
      },
    });
    expect(replay.statusCode).toBe(200);
    const list = await api('get', `/ledgers/${ledgerId}/transactions`, undefined, token);
    const page = list.json() as { items: unknown[] };
    expect(page.items).toHaveLength(1);
  });
  it('批量导入：合法整批写入，含非法条目整批回滚', async () => {
    const { token } = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/ledgers', { id: ledgerId, name: '导入账本' }, token);
    expect(create.status).toBe(201);

    // 合法导入：分类 + 交易
    const categoryId = uuid();
    const txnId = uuid();
    const ok = await api(
      'post',
      `/ledgers/${ledgerId}/imports`,
      {
        categories: [{ id: categoryId, name: '批量导入验收分类', kind: 'expense', level: 1, sort_order: 1 }],
        transactions: [
          {
            id: txnId,
            tx_type: 'expense',
            amount: '66.66',
            happened_at: '2026-08-19T14:00:00.000Z',
            category_id: categoryId,
            currency_code: 'CNY',
            native_amount: '66.66',
          },
        ],
      },
      token,
    );
    expect(ok.status).toBe(201);
    const imported = ok.json() as { imported_categories: number; imported_transactions: number };
    expect(imported).toEqual({ imported_categories: 1, imported_transactions: 1 });

    // 交易引用了导入的分类
    const list = await api('get', `/ledgers/${ledgerId}/transactions`, undefined, token);
    const page = list.json() as { items: Array<{ id: string; category_id: string | null; amount: string }> };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.category_id).toBe(categoryId);
    expect(page.items[0]!.amount).toBe('66.66');

    // 非法导入：金额与本位币快照不一致 → 400 且整批回滚（账本中仍只有 1 条）
    const bad = await api(
      'post',
      `/ledgers/${ledgerId}/imports`,
      {
        transactions: [
          {
            id: uuid(),
            tx_type: 'expense',
            amount: '10',
            happened_at: '2026-08-19T14:00:00.000Z',
            currency_code: 'CNY',
            native_amount: '9',
          },
          {
            id: uuid(),
            tx_type: 'expense',
            amount: '5',
            happened_at: '2026-08-19T14:00:00.000Z',
            currency_code: 'CNY',
            native_amount: '5',
          },
        ],
      },
      token,
    );
    expect(bad.status).toBe(400);
    const badBody = bad.json() as { code: string; details: Array<{ index: number; entity: string }> };
    expect(badBody.code).toBe('IMPORT_VALIDATION_FAILED');
    expect(badBody.details).toHaveLength(1);
    expect(badBody.details[0]!.index).toBe(0);

    const after = await api('get', `/ledgers/${ledgerId}/transactions`, undefined, token);
    const afterPage = after.json() as { items: unknown[] };
    expect(afterPage.items).toHaveLength(1);
  });
  it('批量导入：未知数据库异常返回友好 500，不回显内部错误', async () => {
    const { token } = await registerUser();
    const ledgerId = uuid();
    const categoryId = uuid();
    expect((await api('post', '/ledgers', { id: ledgerId, name: '导入异常账本' }, token)).status).toBe(201);
    expect(
      (
        await api(
          'post',
          `/ledgers/${ledgerId}/categories`,
          { id: categoryId, name: '已有分类', kind: 'expense', level: 1 },
          token,
        )
      ).status,
    ).toBe(201);

    const response = await api(
      'post',
      `/ledgers/${ledgerId}/imports`,
      { categories: [{ id: categoryId, name: '重复分类', kind: 'expense', level: 1 }] },
      token,
    );
    expect(response.status).toBe(500);
    expect(response.json()).toMatchObject({
      code: 'DATABASE_OPERATION_FAILED',
      message: '批量导入失败，请稍后重试',
    });
    expect(response.body).not.toContain('Unique constraint');
    expect(response.body).not.toContain('Prisma');
  });
  it('批量导入幂等：同键同载荷重放返回缓存计数且不重复写入，同键异载荷 409', async () => {
    const { token } = await registerUser();
    const ledgerId = uuid();
    expect((await api('post', '/ledgers', { id: ledgerId, name: '导入幂等账本' }, token)).status).toBe(201);

    const categoryId = uuid();
    const txnId = uuid();
    const importBody = {
      categories: [{ id: categoryId, name: '幂等导入验收分类', kind: 'expense', level: 1, sort_order: 1 }],
      transactions: [
        {
          id: txnId,
          tx_type: 'expense',
          amount: '66.66',
          happened_at: '2026-08-19T14:00:00.000Z',
          category_id: categoryId,
          currency_code: 'CNY',
          native_amount: '66.66',
        },
      ],
    };
    const idemHeaders = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': 'import-idem-key-0001',
    };

    // 首次导入：201 写入
    const first = await app.inject({
      method: 'post',
      url: await accountingRequestFixturePath(app, 'POST', `${API_BASE}/ledgers/${ledgerId}/imports`, bearer(token)),
      payload: importBody,
      headers: idemHeaders,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ imported_categories: 1, imported_transactions: 1 });

    // 同键同语义载荷重放（字段顺序不同，验证稳定请求指纹）：200 返回缓存计数
    const replay = await app.inject({
      method: 'post',
      url: await accountingRequestFixturePath(app, 'POST', `${API_BASE}/ledgers/${ledgerId}/imports`, bearer(token)),
      payload: {
        transactions: [
          {
            native_amount: '66.66',
            currency_code: 'CNY',
            category_id: categoryId,
            happened_at: '2026-08-19T14:00:00.000Z',
            amount: '66.66',
            tx_type: 'expense',
            id: txnId,
          },
        ],
        categories: [{ sort_order: 1, level: 1, kind: 'expense', name: '幂等导入验收分类', id: categoryId }],
      },
      headers: idemHeaders,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ imported_categories: 1, imported_transactions: 1 });

    // 重放不产生重复数据，也不重复写同步变更日志（离线客户端重试不会扩散到多端）
    const list = await api('get', `/ledgers/${ledgerId}/transactions`, undefined, token);
    expect((list.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(await prisma.syncChange.count({ where: { entityId: txnId } })).toBe(1);
    expect(await prisma.syncChange.count({ where: { entityId: categoryId } })).toBe(1);

    // 同键异载荷：409 拒绝幂等键错误复用
    const conflict = await app.inject({
      method: 'post',
      url: await accountingRequestFixturePath(app, 'POST', `${API_BASE}/ledgers/${ledgerId}/imports`, bearer(token)),
      payload: {
        transactions: [
          {
            id: uuid(),
            tx_type: 'expense',
            amount: '1',
            happened_at: '2026-08-19T14:00:00.000Z',
            currency_code: 'CNY',
            native_amount: '1',
          },
        ],
      },
      headers: idemHeaders,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it('分类更新生成账本级失效事件，单删仍有关联交易的分类被拒绝且不产生变更', async () => {
    const { token, deviceId } = await registerUser();
    const ledgerIds = [uuid(), uuid()];
    const categoryId = uuid();
    for (const [index, ledgerId] of ledgerIds.entries()) {
      expect((await api('post', '/ledgers', { id: ledgerId, name: `分类级联账本 ${index}` }, token)).status).toBe(201);
    }
    expect(
      (
        await api(
          'post',
          `/ledgers/${ledgerIds[0]}/categories`,
          { id: categoryId, name: '旧分类', kind: 'expense', level: 1 },
          token,
        )
      ).status,
    ).toBe(201);
    for (const ledgerId of ledgerIds) {
      expect(
        (
          await api(
            'post',
            `/ledgers/${ledgerId}/transactions`,
            {
              id: uuid(),
              tx_type: 'expense',
              amount: '1',
              happened_at: new Date().toISOString(),
              category_id: categoryId,
              currency_code: 'CNY',
              native_amount: '1',
            },
            token,
          )
        ).status,
      ).toBe(201);
    }

    const beforePush =
      (await prisma.syncChange.findFirst({ orderBy: { changeId: 'desc' }, select: { changeId: true } }))?.changeId ??
      0n;
    const pushed = await api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: categoryId,
            ledger_id: null,
            action: 'upsert',
            updated_at: new Date(Date.now() + 60_000).toISOString(),
            payload: {
              name: '新分类',
              kind: 'expense',
              level: 1,
              sort_order: 0,
              icon: null,
              parent_id: null,
            },
          },
        ],
      },
      token,
    );
    expect(pushed.status).toBe(200);
    await expectCategoryInvalidations(beforePush, ledgerIds);

    const beforeDelete =
      (await prisma.syncChange.findFirst({ orderBy: { changeId: 'desc' }, select: { changeId: true } }))?.changeId ??
      0n;
    const beforeTransactions = await prisma.transaction.findMany({
      where: { ledgerId: { in: ledgerIds } },
      orderBy: { id: 'asc' },
    });
    const deleted = await api('delete', `/ledgers/${ledgerIds[0]}/categories/${categoryId}`, undefined, token);
    expect(deleted.status, deleted.body).toBe(409);
    expect(deleted.json()).toMatchObject({ code: 'CATEGORY_HAS_TRANSACTIONS' });
    expect(await prisma.syncChange.count({ where: { changeId: { gt: beforeDelete } } })).toBe(0);
    expect(
      await prisma.transaction.findMany({ where: { ledgerId: { in: ledgerIds } }, orderBy: { id: 'asc' } }),
    ).toEqual(beforeTransactions);
  });
  it('跨域关系：交易拒绝其他账本周期模板，周期模板拒绝其他 Owner 分类', async () => {
    const first = await registerUser();
    const second = await registerUser();
    const firstLedgerId = uuid();
    const secondLedgerId = uuid();
    const firstLedger = await api('post', '/ledgers', { id: firstLedgerId, name: '第一账本' }, first.token);
    const secondLedger = await api('post', '/ledgers', { id: secondLedgerId, name: '第二账本' }, second.token);
    expect(firstLedger.status).toBe(201);
    expect(secondLedger.status).toBe(201);
    const firstSyncId = (firstLedger.json() as { sync_id: string }).sync_id;
    const secondSyncId = (secondLedger.json() as { sync_id: string }).sync_id;
    const secondCategoryId = uuid();
    expect(
      (
        await api(
          'post',
          `/ledgers/${secondLedgerId}/categories`,
          { id: secondCategoryId, name: '第二用户分类', kind: 'expense', level: 1 },
          second.token,
        )
      ).status,
    ).toBe(201);

    const secondRecurringId = uuid();
    const recurringCreated = await api(
      'post',
      '/sync/push',
      {
        device_id: second.deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'recurring_transaction',
            entity_id: secondRecurringId,
            ledger_id: secondLedgerId,
            sync_id: secondSyncId,
            action: 'upsert',
            updated_at: new Date().toISOString(),
            payload: recurringPayload(secondCategoryId),
          },
        ],
      },
      second.token,
    );
    expect(recurringCreated.status).toBe(200);
    expect(recurringCreated.json()).toMatchObject({ outcomes: [{ status: 'accepted' }] });

    const crossRecurringTransactionId = uuid();
    const crossRecurring = await api(
      'post',
      `/ledgers/${firstLedgerId}/transactions`,
      {
        id: crossRecurringTransactionId,
        tx_type: 'expense',
        amount: '1',
        happened_at: new Date().toISOString(),
        category_id: null,
        currency_code: 'CNY',
        native_amount: '1',
        recurring_id: secondRecurringId,
      },
      first.token,
    );
    if (crossRecurring.status === 201) {
      await prisma.transaction.delete({ where: { id: crossRecurringTransactionId } });
    }
    expect(crossRecurring.status).toBe(400);
    expect(crossRecurring.json()).toMatchObject({ code: 'INVALID_RECURRING' });

    const validTransactionId = uuid();
    expect(
      (
        await api(
          'post',
          `/ledgers/${firstLedgerId}/transactions`,
          {
            id: validTransactionId,
            tx_type: 'expense',
            amount: '1',
            happened_at: new Date().toISOString(),
            category_id: null,
            currency_code: 'CNY',
            native_amount: '1',
          },
          first.token,
        )
      ).status,
    ).toBe(201);
    const crossRecurringPatch = await api(
      'patch',
      `/ledgers/${firstLedgerId}/transactions/${validTransactionId}`,
      { base_revision: 1, recurring_id: secondRecurringId },
      first.token,
    );
    expect(crossRecurringPatch.status).toBe(409);
    expect(crossRecurringPatch.json()).toMatchObject({ code: 'RECURRING_SOURCE_IMMUTABLE' });

    const crossRecurringImport = await api(
      'post',
      `/ledgers/${firstLedgerId}/imports`,
      {
        transactions: [
          {
            id: uuid(),
            tx_type: 'expense',
            amount: '1',
            happened_at: new Date().toISOString(),
            category_id: null,
            currency_code: 'CNY',
            native_amount: '1',
            recurring_id: secondRecurringId,
          },
        ],
      },
      first.token,
    );
    expect(crossRecurringImport.status).toBe(400);
    expect(crossRecurringImport.json()).toMatchObject({
      code: 'IMPORT_VALIDATION_FAILED',
      details: [{ entity: 'transaction', index: 0, reason: '周期账单不存在或不属于当前账本' }],
    });

    const crossRecurringPush = await api(
      'post',
      '/sync/push',
      {
        device_id: first.deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'transaction',
            entity_id: uuid(),
            ledger_id: firstLedgerId,
            sync_id: firstSyncId,
            base_revision: 0,
            action: 'upsert',
            updated_at: new Date().toISOString(),
            payload: {
              tx_type: 'expense',
              amount: '1',
              happened_at: new Date().toISOString(),
              note: null,
              category_id: null,
              currency_code: 'CNY',
              native_amount: '1',
              recurring_id: secondRecurringId,
              aa_mode: null,
              splits: [],
              last_edited_at: null,
            },
          },
        ],
      },
      first.token,
    );
    expect(crossRecurringPush.json()).toMatchObject({
      outcomes: [{ status: 'invalid', message: '交易周期账单不存在或不属于当前账本' }],
    });

    const crossCategoryRecurringId = uuid();
    const crossCategory = await api(
      'post',
      '/sync/push',
      {
        device_id: first.deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'recurring_transaction',
            entity_id: crossCategoryRecurringId,
            ledger_id: firstLedgerId,
            sync_id: firstSyncId,
            action: 'upsert',
            updated_at: new Date().toISOString(),
            payload: recurringPayload(secondCategoryId),
          },
        ],
      },
      first.token,
    );
    const crossCategoryBody = crossCategory.json() as { outcomes: Array<{ status: string; message?: string }> };
    if (crossCategoryBody.outcomes[0]?.status === 'accepted') {
      await prisma.recurringTransaction.delete({ where: { id: crossCategoryRecurringId } });
    }
    expect(crossCategory.status).toBe(200);
    expect(crossCategoryBody.outcomes[0]).toMatchObject({
      status: 'invalid',
      message: '周期账单分类不存在或不属于账本 Owner',
    });
  });
  it('mutation 幂等：同一 mutation_id 重试只应用一次，同毫秒不同 mutation 正常应用', async () => {
    const { token, deviceId } = await registerUser();
    const ledgerId = uuid();
    const txnId = uuid();
    const mutationId = uuid();
    const updatedAt = '2026-08-19T15:00:00.000Z';
    const change = {
      mutation_id: mutationId,
      entity_type: 'transaction' as const,
      entity_id: txnId,
      ledger_id: ledgerId,
      action: 'upsert' as const,
      updated_at: updatedAt,
      payload: {
        tx_type: 'expense' as const,
        amount: '11.11',
        happened_at: '2026-08-19T15:00:00.000Z',
        note: '幂等验证',
        category_id: null,
        currency_code: 'CNY',
        native_amount: '11.11',
        recurring_id: null,
        aa_mode: null,
        splits: [],
        version: 1,
        last_edited_at: updatedAt,
      },
    };
    // 先 push 账本创建建立绑定，后续账本级变更必须携带 sync_id
    const ledgerCreate = {
      mutation_id: uuid(),
      entity_type: 'ledger' as const,
      entity_id: ledgerId,
      ledger_id: ledgerId,
      action: 'upsert' as const,
      updated_at: updatedAt,
      payload: { name: '幂等账本', currency: 'CNY', month_start_day: 1, aa_enabled: false },
    };
    const createResp = await api('post', '/sync/push', { device_id: deviceId, changes: [ledgerCreate] }, token);
    expect(createResp.status).toBe(200);
    const createBody = createResp.json() as { outcomes: Array<{ sync_id?: string }> };
    const syncId = createBody.outcomes[0]!.sync_id!;
    // 更新变更必须使用新 mutation_id（创建已用掉旧的，重复即幂等命中）
    // 且时间必须晚于创建（同时间戳会被 LWW 判定为同版本回放而 ignored）
    const ledgerChange = {
      ...ledgerCreate,
      mutation_id: uuid(),
      sync_id: syncId,
      updated_at: '2026-08-19T15:01:00.000Z',
    };
    const batch = { device_id: deviceId, changes: [ledgerChange, { ...change, sync_id: syncId }] };
    // 第一次：accepted
    const first = await api('post', '/sync/push', batch, token);
    expect(first.status).toBe(200);
    const firstBody = first.json() as { outcomes: Array<{ status: string }> };
    expect(firstBody.outcomes[0]!.status).toBe('accepted');
    expect(firstBody.outcomes[1]!.status).toBe('accepted');
    // 同一 mutation 重试：全部 ignored
    const retry = await api('post', '/sync/push', batch, token);
    const retryBody = retry.json() as { outcomes: Array<{ status: string }> };
    expect(retryBody.outcomes[0]!.status).toBe('ignored');
    expect(retryBody.outcomes[1]!.status).toBe('ignored');
    // 数据库只有一条交易、一条同 mutation 的 syncChange
    const rows = await prisma.transaction.findMany({ where: { ledgerId } });
    expect(rows).toHaveLength(1);
    const dup = await prisma.syncChange.findMany({ where: { deviceId, mutationId } });
    expect(dup).toHaveLength(1);
  });
  it('AA 指定分摊：splits 关系表写入与总和校验', async () => {
    const { token, deviceId, userId } = await registerUser();
    const ledgerId = uuid();
    const ledgerResp = await api('post', '/ledgers', { id: ledgerId, name: 'AA 账本', aa_enabled: true }, token);
    expect(ledgerResp.status).toBe(201);
    // REST 创建账本响应即返回同步身份，后续账本级 push 必须携带
    const syncId = (ledgerResp.json() as { sync_id: string }).sync_id;

    // 先创建账本占位成员（member 实体）
    const vUser = uuid();
    const selfMember = registeredMemberId(ledgerId, userId);
    const pushMember = await api(
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
            updated_at: '2026-08-19T16:00:00.000Z',
            payload: { display_name: '占位成员' },
          },
        ],
      },
      token,
    );
    expect(pushMember.status).toBe(200);
    const memberOutcome = (pushMember.json() as { outcomes: Array<{ status: string }> }).outcomes[0]!;
    expect(memberOutcome.status).toBe('accepted');

    // 指定分摊：真实成员 60 + 虚拟成员 40
    const transactionId = uuid();
    const created = await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: transactionId,
        tx_type: 'expense',
        amount: '100',
        happened_at: '2026-08-19T16:00:00.000Z',
        currency_code: 'CNY',
        native_amount: '100',
        aa_mode: '2',
        splits: [
          { member_id: selfMember, amount: '60' },
          { member_id: vUser, amount: '40' },
        ],
      },
      token,
    );
    expect(created.status).toBe(201);
    const body = created.json() as {
      aa_mode: string;
      splits: Array<{ member_id: string | null; amount: string }>;
    };
    // 契约 wire 格式：aa_mode 恒为字符串枚举，数值会被 Dart 生成客户端拒绝反序列化
    expect(body.aa_mode).toBe('2');
    expect(body.splits).toHaveLength(2);
    expect(body.splits.map((s) => s.amount).sort()).toEqual(['40', '60']);

    const list = await api('get', `/ledgers/${ledgerId}/transactions`, undefined, token);
    const listed = list.json() as { items: Array<{ id: string; splits: unknown[] }> };
    expect(listed.items.find((item) => item.id === transactionId)?.splits).toHaveLength(2);

    const patched = await api(
      'patch',
      `/ledgers/${ledgerId}/transactions/${transactionId}`,
      { note: '仅修改备注', base_revision: 1 },
      token,
    );
    expect(patched.status).toBe(200);
    expect((patched.json() as { splits: unknown[] }).splits).toHaveLength(2);

    const full = await api('get', `/sync/full?ledger_id=${ledgerId}`, undefined, token);
    expect(full.status).toBe(200);
    const fullBody = full.json() as { transactions: Array<{ id: string; aa_mode: string; splits: unknown[] }> };
    const fullTransaction = fullBody.transactions.find((item) => item.id === transactionId);
    expect(fullTransaction?.splits).toHaveLength(2);
    expect(fullTransaction?.aa_mode).toBe('2');

    // 总和与 native_amount 不符 → 400
    const bad = await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: uuid(),
        tx_type: 'expense',
        amount: '100',
        happened_at: '2026-08-19T16:00:00.000Z',
        currency_code: 'CNY',
        native_amount: '100',
        aa_mode: '2',
        splits: [{ member_id: selfMember, amount: '99' }],
      },
      token,
    );
    expect(bad.status).toBe(400);

    // 参与人缺失 → 400
    const badParticipant = await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: uuid(),
        tx_type: 'expense',
        amount: '100',
        happened_at: '2026-08-19T16:00:00.000Z',
        currency_code: 'CNY',
        native_amount: '100',
        aa_mode: '2',
        splits: [{ amount: '100' }],
      },
      token,
    );
    expect(badParticipant.status).toBe(400);

    const nonMember = await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: uuid(),
        tx_type: 'expense',
        amount: '100',
        happened_at: '2026-08-19T16:00:00.000Z',
        currency_code: 'CNY',
        native_amount: '100',
        aa_mode: '2',
        splits: [{ member_id: uuid(), amount: '100' }],
      },
      token,
    );
    expect(nonMember.status).toBe(400);
  });
  it('同步游标过期：since 早于保留下限返回 410 SYNC_CURSOR_EXPIRED', async () => {
    // 独立实例：保留下限=5，验证过期游标被拒、新游标正常
    const strictConfig: ApiConfig = { ...config, syncRetentionMinCursor: 5 };
    const strictApp = buildApp({ logger: false, config: strictConfig, prisma });
    await strictApp.ready();
    const { token } = await registerUser();
    const expired = await strictApp.inject({
      method: 'get',
      url: `${API_BASE}/sync/pull?since=3`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expired.statusCode).toBe(410);
    const expiredBody = JSON.parse(expired.body) as { code: string };
    expect(expiredBody.code).toBe('SYNC_CURSOR_EXPIRED');
    const fresh = await strictApp.inject({
      method: 'get',
      url: `${API_BASE}/sync/pull?since=6`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(fresh.statusCode).toBe(200);
    await strictApp.close();
  });
  it('交易列表不透明游标：UUIDv4/v5 混合交易翻页无重复无遗漏（含同时间戳）', async () => {
    const { token } = await registerUser();
    const ledgerId = uuid();
    await api('post', '/ledgers', { id: ledgerId, name: '分页账本' }, token);
    // 最新两条的末条使用导入交易的 UUIDv5，确保首个分页游标必须支持该身份。
    const transactionIds = [uuid(), uuid(), uuid(), uuidV5(ledgerId, 'pagination-imported-transaction'), uuid()];
    // 最早两条同时间戳且跨页，继续核对时间与 ID 组成的复合排序键。
    for (let i = 0; i < 5; i++) {
      const res = await api(
        'post',
        `/ledgers/${ledgerId}/transactions`,
        {
          id: transactionIds[i],
          tx_type: 'expense',
          amount: String(i + 1),
          happened_at: i < 2 ? '2026-08-19T17:00:00.000Z' : `2026-08-19T17:0${i}:00.000Z`,
          currency_code: 'CNY',
          native_amount: String(i + 1),
        },
        token,
      );
      expect(res.status).toBe(201);
    }
    const seen = new Set<string>();
    const receivedIds: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url = `/ledgers/${ledgerId}/transactions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await api('get', url, undefined, token);
      expect(res.status).toBe(200);
      const body = res.json() as { items: Array<{ id: string }>; next_cursor: string | null };
      // limit=2 必须真正生效：第一页恰好 2 条且存在后续游标，否则全量返回的假实现也会通过
      expect(body.items.length).toBeLessThanOrEqual(2);
      if (page === 0) {
        expect(body.items.length).toBe(2);
        expect(body.items.at(-1)!.id).toBe(transactionIds[3]);
        expect(body.next_cursor).not.toBeNull();
      }
      for (const item of body.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
        receivedIds.push(item.id);
      }
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(5);
    expect(receivedIds).toEqual([
      transactionIds[4],
      transactionIds[3],
      transactionIds[2],
      ...transactionIds.slice(0, 2).sort().reverse(),
    ]);
  });
  it('共享生命周期：移除→REMOVED 且作废未消费邀请，退出→LEFT，新邀请重新激活', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const secondDevice = await api('post', '/auth/login', {
      country_code: '+86',
      phone: member.phone,
      password: 'password-123456',
      device: { installation_id: uuid(), name: 'e2e-second-device', platform: 'e2e' },
    });
    expect(secondDevice.status).toBe(200);
    const secondDeviceToken = (secondDevice.json() as { access_token: string }).access_token;
    const ledgerId = uuid();
    const create = await api('post', '/ledgers', { id: ledgerId, name: '生命周期账本' }, owner.token);
    expect(create.status).toBe(201);
    const ownerBeforeAccept = (await api('get', '/sync/pull?since=0', undefined, owner.token)).json() as PullBody;
    // 把受邀账号的 cursor 推进到目标账本初始事件之后，证明 accept 必须产生新的账本事件，
    // 不能偶然依赖历史 ledger 事件在成员关系建立后重新变得可见。
    const cursorLedger = await api('post', '/ledgers', { id: uuid(), name: '游标推进账本' }, member.token);
    expect(cursorLedger.status).toBe(201);
    const memberBeforeAccept = (
      await api('get', '/sync/pull?since=0', undefined, secondDeviceToken)
    ).json() as PullBody;

    // 邀请 → 接受 → 成员加入（ACTIVE）
    const invite = await api('post', `/ledgers/${ledgerId}/invites`, { role: 'editor' }, owner.token);
    expect(invite.status).toBe(201);
    const inviteCode = (invite.json() as { code: string }).code;
    const memberId = registeredMemberId(ledgerId, member.userId);
    const accept = await api('post', `/invites/${inviteCode}/accept`, {}, member.token);
    expect(accept.status).toBe(200);
    const ownerAfterAccept = (
      await api('get', `/sync/pull?since=${ownerBeforeAccept.server_cursor}`, undefined, owner.token)
    ).json() as PullBody;
    const memberAfterAccept = (
      await api('get', `/sync/pull?since=${memberBeforeAccept.server_cursor}`, undefined, secondDeviceToken)
    ).json() as PullBody;
    const acceptedLedger = memberAfterAccept.changes.find(
      (change) => change.entity_type === 'ledger' && change.entity_id === ledgerId,
    );
    expect(acceptedLedger?.ledger_id).toBeNull();
    expect(acceptedLedger?.payload.requires_full).toBe(true);
    expect(
      ownerAfterAccept.changes.some((change) => change.entity_type === 'ledger' && change.entity_id === ledgerId),
    ).toBe(false);
    for (const pull of [ownerAfterAccept, memberAfterAccept]) {
      expect(
        pull.changes.find((change) => change.entity_type === 'member' && change.entity_id === memberId)?.payload.status,
      ).toBe('ACTIVE');
    }
    const joined = await prisma.ledgerMember.findUnique({
      where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: member.userId } },
    });
    expect(joined!.status).toBe('ACTIVE');

    // 1) owner 移除成员：行保留、status=REMOVED（生命周期状态，非硬删）
    const removed = await api('delete', `/ledgers/${ledgerId}/members/${memberId}`, undefined, owner.token);
    expect(removed.status).toBe(204);
    const ownerAfterRemove = (
      await api('get', `/sync/pull?since=${ownerAfterAccept.server_cursor}`, undefined, owner.token)
    ).json() as PullBody;
    const memberAfterRemove = (
      await api('get', `/sync/pull?since=${memberAfterAccept.server_cursor}`, undefined, secondDeviceToken)
    ).json() as PullBody;
    for (const pull of [ownerAfterRemove, memberAfterRemove]) {
      expect(
        pull.changes.find((change) => change.entity_type === 'member' && change.entity_id === memberId)?.payload.status,
      ).toBe('REMOVED');
    }
    const revokedDeviceFromOldCursor = (
      await api('get', `/sync/pull?since=${memberBeforeAccept.server_cursor}`, undefined, secondDeviceToken)
    ).json() as PullBody;
    const acceptedLedgerIndex = revokedDeviceFromOldCursor.changes.findIndex(
      (change) => change.entity_type === 'ledger' && change.entity_id === ledgerId,
    );
    const activeMemberIndex = revokedDeviceFromOldCursor.changes.findIndex(
      (change) =>
        change.entity_type === 'member' && change.entity_id === memberId && change.payload.status === 'ACTIVE',
    );
    const removedMemberIndex = revokedDeviceFromOldCursor.changes.findIndex(
      (change) =>
        change.entity_type === 'member' && change.entity_id === memberId && change.payload.status === 'REMOVED',
    );
    expect(acceptedLedgerIndex).toBeGreaterThanOrEqual(0);
    expect(activeMemberIndex).toBeGreaterThan(acceptedLedgerIndex);
    expect(removedMemberIndex).toBeGreaterThan(activeMemberIndex);
    const rows = await prisma.ledgerMember.findMany({ where: { ledgerId } });
    expect(rows).toHaveLength(2); // owner 行 + REMOVED 行都保留
    const removedRow = rows.find((r) => r.linkedAccountId === member.userId);
    expect(removedRow!.status).toBe('REMOVED');
    expect(removedRow!.role).toBe('editor'); // 历史角色保留
    // 重复移除已 REMOVED 成员：无生效变更 → 404
    const removeAgain = await api('delete', `/ledgers/${ledgerId}/members/${memberId}`, undefined, owner.token);
    expect(removeAgain.status).toBe(404);

    // 2) 被移除成员失去云访问权限（权限只看 status==ACTIVE）
    const removedAccess = await api('get', `/ledgers/${ledgerId}`, undefined, member.token);
    expect(removedAccess.status).toBe(404);
    const removedList = await api('get', '/ledgers', undefined, member.token);
    const listed = removedList.json() as Array<{ id: string }>;
    expect(listed.some((l) => l.id === ledgerId)).toBe(false);

    // 3) 移除时作废该账本全部未消费邀请（旧邀请失效，预览/接受均 404）
    const revokedPreview = await api('get', `/invites/${inviteCode}`, undefined, member.token);
    expect(revokedPreview.status).toBe(404);
    const revokedAccept = await api('post', `/invites/${inviteCode}/accept`, {}, member.token);
    expect(revokedAccept.status).toBe(404);

    // 4) 新邀请（新 id/createdAt）才能把 REMOVED → ACTIVE
    const newInvite = await api('post', `/ledgers/${ledgerId}/invites`, {}, owner.token);
    expect(newInvite.status).toBe(201);
    const newCode = (newInvite.json() as { code: string }).code;
    const reaccept = await api('post', `/invites/${newCode}/accept`, {}, member.token);
    expect(reaccept.status).toBe(200);
    const ownerAfterReaccept = (
      await api('get', `/sync/pull?since=${ownerAfterRemove.server_cursor}`, undefined, owner.token)
    ).json() as PullBody;
    const memberAfterReaccept = (
      await api('get', `/sync/pull?since=${memberAfterRemove.server_cursor}`, undefined, secondDeviceToken)
    ).json() as PullBody;
    for (const pull of [ownerAfterReaccept, memberAfterReaccept]) {
      expect(
        pull.changes.find((change) => change.entity_type === 'member' && change.entity_id === memberId)?.payload.status,
      ).toBe('ACTIVE');
    }
    const reactivated = await prisma.ledgerMember.findUnique({
      where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: member.userId } },
    });
    expect(reactivated!.status).toBe('ACTIVE');
    expect(reactivated!.role).toBe('editor');

    // 5) leave → status=LEFT（行保留）；LEFT 成员失去云访问权限
    const left = await api('post', `/ledgers/${ledgerId}/leave`, {}, member.token);
    expect(left.status).toBe(204);
    const ownerAfterLeave = (
      await api('get', `/sync/pull?since=${ownerAfterReaccept.server_cursor}`, undefined, owner.token)
    ).json() as PullBody;
    const memberAfterLeave = (
      await api('get', `/sync/pull?since=${memberAfterReaccept.server_cursor}`, undefined, secondDeviceToken)
    ).json() as PullBody;
    for (const pull of [ownerAfterLeave, memberAfterLeave]) {
      expect(
        pull.changes.find((change) => change.entity_type === 'member' && change.entity_id === memberId)?.payload.status,
      ).toBe('LEFT');
    }
    const leftRow = await prisma.ledgerMember.findUnique({
      where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: member.userId } },
    });
    expect(leftRow!.status).toBe('LEFT');
    const leftAccess = await api('get', `/ledgers/${ledgerId}`, undefined, member.token);
    expect(leftAccess.status).toBe(404);
    // 已 LEFT 再次 leave：无访问权限即 404（权限只看 ACTIVE）
    const leftAgain = await api('post', `/ledgers/${ledgerId}/leave`, {}, member.token);
    expect(leftAgain.status).toBe(404);

    // 6) LEFT 成员可由新邀请按产品策略重新加入 → ACTIVE
    const reInvite = await api('post', `/ledgers/${ledgerId}/invites`, { role: 'editor' }, owner.token);
    expect(reInvite.status).toBe(201);
    const reCode = (reInvite.json() as { code: string }).code;
    const rejoined = await api('post', `/invites/${reCode}/accept`, {}, member.token);
    expect(rejoined.status).toBe(200);
    const joinedRow = await prisma.ledgerMember.findUnique({
      where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: member.userId } },
    });
    expect(joinedRow!.status).toBe('ACTIVE');
    expect(joinedRow!.role).toBe('editor');
  });

  it('邀请撤销与接受并发时，撤销提交后接受必须失败且不能激活成员', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ledgerId = uuid();
    expect((await api('post', '/ledgers', { id: ledgerId, name: '并发邀请账本' }, owner.token)).status).toBe(201);
    const inviteResponse = await api('post', `/ledgers/${ledgerId}/invites`, {}, owner.token);
    expect(inviteResponse.status).toBe(201);
    const invite = inviteResponse.json() as { id: string; code: string };
    let markRevoked!: () => void;
    const revoked = new Promise<void>((resolve) => {
      markRevoked = resolve;
    });
    let releaseRevocation!: () => void;
    const revocationGate = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    const revocation = prisma.$transaction(async (tx) => {
      await tx.ledgerInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
      markRevoked();
      await revocationGate;
    });
    await revoked;
    const acceptance = api('post', `/invites/${invite.code}/accept`, {}, member.token);
    try {
      await expect
        .poll(
          async () => {
            const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
              SELECT EXISTS (
                SELECT 1
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock'
                  AND query ILIKE '%ledger_invites%'
              ) AS "waiting"
            `;
            return state?.waiting ?? false;
          },
          { timeout: 2_000, interval: 20 },
        )
        .toBe(true);
    } finally {
      releaseRevocation();
      await revocation;
    }
    const accepted = await acceptance;
    expect(accepted.status).toBe(404);
    const storedInvite = await prisma.ledgerInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(storedInvite.revokedAt).not.toBeNull();
    expect(storedInvite.usedAt).toBeNull();
    expect(
      await prisma.ledgerMember.findUnique({
        where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: member.userId } },
      }),
    ).toBeNull();
  });

  it('member-stats：LEFT/REMOVED 成员显示 removed 且历史统计保留；非 ACTIVE 不可改角色/读统计', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/ledgers', { id: ledgerId, name: '统计账本' }, owner.token);
    expect(create.status).toBe(201);
    const invite = await api('post', `/ledgers/${ledgerId}/invites`, { role: 'editor' }, owner.token);
    expect(invite.status).toBe(201);
    const code = (invite.json() as { code: string }).code;
    const accept = await api('post', `/invites/${code}/accept`, {}, member.token);
    expect(accept.status).toBe(200);

    // member 用自己身份记一笔支出（服务端强制 created_by_member_id = 记账人）
    const tx = await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: uuid(),
        tx_type: 'expense',
        amount: '50',
        happened_at: '2026-08-19T10:00:00.000Z',
        currency_code: 'CNY',
        native_amount: '50',
      },
      member.token,
    );
    expect(tx.status).toBe(201);

    // ACTIVE 成员：显示真实角色，统计正常归因
    const before = await api('get', `/ledgers/${ledgerId}/member-stats?scope=all`, undefined, owner.token);
    expect(before.status).toBe(200);
    const beforeItems = (
      before.json() as { items: Array<{ user_id: string | null; role: string; expense_total: string }> }
    ).items;
    const beforeMember = beforeItems.find((i) => i.user_id === member.userId);
    expect(beforeMember!.role).toBe('editor');
    expect(beforeMember!.expense_total).toBe('50');

    // 移除后：role=removed（生命周期状态），历史统计保留（身份保留）
    const removedMemberId = registeredMemberId(ledgerId, member.userId);
    const removed = await api('delete', `/ledgers/${ledgerId}/members/${removedMemberId}`, undefined, owner.token);
    expect(removed.status).toBe(204);
    const after = await api('get', `/ledgers/${ledgerId}/member-stats?scope=all`, undefined, owner.token);
    const afterItems = (
      after.json() as { items: Array<{ user_id: string | null; role: string; expense_total: string }> }
    ).items;
    const afterMember = afterItems.find((i) => i.user_id === member.userId);
    expect(afterMember!.role).toBe('removed');
    expect(afterMember!.expense_total).toBe('50');

    // 成员协作角色不可变更：角色变更接口不存在
    const patchRemoved = await api('patch', `/ledgers/${ledgerId}/members/${removedMemberId}`, {}, owner.token);
    expect(patchRemoved.status).toBe(404);

    // LEFT/REMOVED 成员无权读取 member-stats（权限只看 ACTIVE）
    const denied = await api('get', `/ledgers/${ledgerId}/member-stats?scope=all`, undefined, member.token);
    expect(denied.status).toBe(404);
  });
  it('成员 API：DELETE 按 member_id 定位，成员列表与统计均返回成员身份', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ledgerId = uuid();
    const create = await api('post', '/ledgers', { id: ledgerId, name: 'canonical 账本' }, owner.token);
    expect(create.status).toBe(201);
    const invite = await api('post', `/ledgers/${ledgerId}/invites`, { role: 'editor' }, owner.token);
    expect(invite.status).toBe(201);
    const code = (invite.json() as { code: string }).code;
    await api('post', `/invites/${code}/accept`, {}, member.token);

    // GET /members：响应包含 member_id/status/linked_account_id 与芝麻号，不含 account 字段
    const members = await api('get', `/ledgers/${ledgerId}/members`, undefined, owner.token);
    expect(members.status).toBe(200);
    const list = members.json() as Array<{
      user_id: string;
      member_id: string;
      status: string;
      linked_account_id: string | null;
      sesame_number: string;
      role: string;
    }>;
    const editor = list.find((m) => m.user_id === member.userId)!;
    expect(editor.member_id).toBe(registeredMemberId(ledgerId, member.userId));
    expect(editor.status).toBe('ACTIVE');
    expect(editor.linked_account_id).toBe(member.userId);
    expect(editor.sesame_number).toMatch(/^[1-9]\d{8}$/);
    expect(Object.keys(editor)).not.toContain('account');
    const ownerEntry = list.find((m) => m.role === 'owner')!;
    expect(ownerEntry.member_id).toBe(registeredMemberId(ledgerId, owner.userId));

    // DELETE by member_id → REMOVED（生命周期语义）
    const del = await api('delete', `/ledgers/${ledgerId}/members/${editor.member_id}`, undefined, owner.token);
    expect(del.status).toBe(204);
    const row = await prisma.ledgerMember.findUnique({
      where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: member.userId } },
    });
    expect(row!.status).toBe('REMOVED');

    // 不存在的 member_id → 404
    const missing = await api('delete', `/ledgers/${ledgerId}/members/${uuid()}`, undefined, owner.token);
    expect(missing.status).toBe(404);

    // 成员统计条目使用 member_id 标识账本中的成员。
    const stats = await api('get', `/ledgers/${ledgerId}/member-stats?scope=all`, undefined, owner.token);
    expect(stats.status).toBe(200);
    const items = (stats.json() as { items: Array<{ member_id: string | null }> }).items;
    expect(items.some((i) => i.member_id === ownerEntry.member_id)).toBe(true);
    expect(items.some((i) => i.member_id === editor.member_id)).toBe(true);
  });
});
