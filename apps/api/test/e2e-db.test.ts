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
  it.each(['income'])('只允许支出：REST、导入和同步拒绝 %s，原有支出保持可读', async (invalidType) => {
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
});
