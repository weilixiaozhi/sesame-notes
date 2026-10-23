import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { recurringOccurrenceId } from '../src/modules/accounting/index.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { loadTestApiConfig } from './test-api-config.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const date = '2026-01-10';
let app: ReturnType<typeof buildApp>;
let token: string;
let userId: string;
let deviceId: string;

/** 使用真实认证和 REST 校验链，失败时保留请求路径及异常上下文。 */
async function request(method: 'POST' | 'PATCH', path: string, payload: Record<string, unknown>) {
  try {
    return await app.inject({
      method,
      url: await accountingRequestFixturePath(app, method, `/api/v1${path}`, {
        authorization: `Bearer ${token}`,
      }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  } catch (error) {
    console.error('周期发生 REST 回归请求失败', { method, path, error });
    throw error;
  }
}

beforeAll(async () => {
  try {
    app = buildApp({
      logger: false,
      prisma,
      config: {
        ...loadTestApiConfig(),
        databaseUrl,
        storagePath: resolve(import.meta.dirname, '../../../Temp/recurring-rest-source'),
        rateLimitMax: 1000,
        authRateLimitMax: 1000,
      },
    });
    await app.ready();
    const response = await request('POST', '/auth/register', {
      country_code: '+86',
      phone: `139${randomInt(0, 100_000_000).toString().padStart(8, '0')}`,
      password: 'recurring-rest-fixture',
      device: { installation_id: randomUUID(), name: '周期历史编辑回归', platform: 'test' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json<{ access_token: string; device_id: string; user: { user_id: string } }>();
    token = session.access_token;
    userId = session.user.user_id;
    deviceId = session.device_id;
  } catch (error) {
    console.error('周期发生 REST 回归初始化失败', error);
    throw error;
  }
});

afterAll(async () => {
  try {
    if (app) await app.close();
    else await prisma.$disconnect();
  } catch (error) {
    console.error('周期发生 REST 回归连接清理失败', error);
    throw error;
  }
});

/** 每个用例独立保存一条已发生记录；直接建夹具以独立验证编辑入口的来源边界。 */
async function fixture() {
  try {
    const ledgerId = randomUUID();
    const created = await request('POST', '/ledgers', { id: ledgerId, name: '周期来源回归', currency: 'CNY' });
    expect(created.statusCode, created.body).toBe(201);
    const rule = await prisma.recurringTransaction.create({
      data: {
        ledgerId,
        ownerId: userId,
        txType: 'expense',
        amount: '10',
        currencyCode: 'CNY',
        frequency: 'daily',
        startDate: new Date(`${date}T00:00:00.000Z`),
        lastGeneratedDate: new Date(`${date}T00:00:00.000Z`),
      },
    });
    const member = await prisma.ledgerMember.findFirstOrThrow({ where: { ledgerId, role: 'owner' } });
    const transaction = await prisma.transaction.create({
      data: {
        id: recurringOccurrenceId(ledgerId, rule.id, date),
        ledgerId,
        ownerId: userId,
        txType: 'expense',
        amount: '10',
        nativeAmount: '10',
        currencyCode: 'CNY',
        happenedAt: new Date(`${date}T00:00:00.000Z`),
        recurringId: rule.id,
        occurrenceDate: date,
        payerMemberId: member.id,
        createdByMemberId: member.id,
        lastEditedByMemberId: member.id,
      },
    });
    return { ledgerId, syncId: created.json<{ sync_id: string }>().sync_id, rule, transaction };
  } catch (error) {
    console.error('周期发生 REST 夹具创建失败', error);
    throw error;
  }
}

/** 校验拒绝请求后交易、编辑历史和同步事件没有部分写入。 */
async function snapshot(value: Awaited<ReturnType<typeof fixture>>) {
  try {
    const [transaction, changes] = await Promise.all([
      prisma.transaction.findUniqueOrThrow({
        where: { id: value.transaction.id },
        include: { editHistory: { orderBy: { version: 'asc' } } },
      }),
      prisma.syncChange.findMany({ where: { ledgerId: value.ledgerId }, orderBy: { changeId: 'asc' } }),
    ]);
    return { transaction, changes };
  } catch (error) {
    console.error('周期发生 REST 持久化快照读取失败', error);
    throw error;
  }
}

describe('周期发生 REST 来源与历史编辑', () => {
  it.each([false, true])('规则删除后保留来源编辑金额和备注，显式来源=%s', async (explicit) => {
    const value = await fixture();
    await prisma.recurringTransaction.update({ where: { id: value.rule.id }, data: { deletedAt: new Date() } });
    const response = await request('PATCH', `/ledgers/${value.ledgerId}/transactions/${value.transaction.id}`, {
      base_revision: value.transaction.revision,
      amount: '12',
      native_amount: '12',
      note: '保留人工历史修改',
      ...(explicit ? { recurring_id: value.rule.id, occurrence_date: date } : {}),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      amount: '12',
      note: '保留人工历史修改',
      recurring_id: value.rule.id,
      occurrence_date: date,
      revision: value.transaction.revision + 1,
    });
    expect(
      (await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: value.rule.id } })).deletedAt,
    ).not.toBeNull();
  });

  it.each([
    { recurring_id: null },
    { recurring_id: randomUUID() },
    { occurrence_date: null },
    { occurrence_date: '2026-01-11' },
  ])('改挂或清空来源被完整拒绝：%j', async (patch) => {
    const value = await fixture();
    const before = await snapshot(value);
    const response = await request('PATCH', `/ledgers/${value.ledgerId}/transactions/${value.transaction.id}`, {
      base_revision: value.transaction.revision,
      ...patch,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe('RECURRING_SOURCE_IMMUTABLE');
    expect(await snapshot(value)).toEqual(before);
  });

  it.each(['transactions', 'imports'])('普通 %s 入口不能伪造现代周期发生', async (entry) => {
    const value = await fixture();
    const transactionId = randomUUID();
    const ordinaryId = randomUUID();
    const payload = {
      id: transactionId,
      tx_type: 'expense',
      amount: '10',
      native_amount: '10',
      currency_code: 'CNY',
      happened_at: '2026-01-11T00:00:00.000Z',
      recurring_id: value.rule.id,
      occurrence_date: '2026-01-11',
    };
    const before = await snapshot(value);
    const ordinary = { ...payload, id: ordinaryId, recurring_id: null, occurrence_date: null };
    const response = await request(
      'POST',
      `/ledgers/${value.ledgerId}/${entry}`,
      entry === 'imports' ? { transactions: [ordinary, payload] } : payload,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe(
      entry === 'imports' ? 'IMPORT_VALIDATION_FAILED' : 'RECURRING_GENERATION_REQUIRED',
    );
    expect(await prisma.transaction.findUnique({ where: { id: transactionId } })).toBeNull();
    expect(await prisma.transaction.findUnique({ where: { id: ordinaryId } })).toBeNull();
    expect(await snapshot(value)).toEqual(before);
  });

  it('仅携带规则引用的新交易拒绝，跨账本规则引用同样拒绝', async () => {
    const value = await fixture();
    const other = await fixture();
    const payload = {
      tx_type: 'expense',
      amount: '10',
      native_amount: '10',
      currency_code: 'CNY',
      happened_at: '2026-01-11T00:00:00.000Z',
      recurring_id: value.rule.id,
    };
    const rejectedSource = await request('POST', `/ledgers/${value.ledgerId}/transactions`, payload);
    expect(rejectedSource.statusCode, rejectedSource.body).toBe(400);
    expect(rejectedSource.json().code).toBe('RECURRING_GENERATION_REQUIRED');
    const rejected = await request('POST', `/ledgers/${other.ledgerId}/transactions`, payload);
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect(rejected.json().code).toBe('INVALID_RECURRING');
  });

  it('同步新建只有规则引用的交易被拒绝，原有交易和同步事件保持完整', async () => {
    const value = await fixture();
    const id = randomUUID();
    const before = await snapshot(value);
    const response = await request('POST', '/sync/push', {
      device_id: deviceId,
      changes: [
        {
          mutation_id: randomUUID(),
          entity_type: 'transaction',
          entity_id: id,
          ledger_id: value.ledgerId,
          sync_id: value.syncId,
          base_revision: 0,
          action: 'upsert',
          updated_at: new Date().toISOString(),
          payload: {
            tx_type: 'expense',
            amount: '10',
            native_amount: '10',
            currency_code: 'CNY',
            happened_at: '2026-01-11T00:00:00.000Z',
            note: null,
            category_id: null,
            recurring_id: value.rule.id,
            occurrence_date: null,
            payer_member_id: null,
            aa_mode: null,
            splits: null,
            last_edited_at: null,
          },
        },
      ],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ outcomes: [{ status: 'invalid' }] });
    expect(await prisma.transaction.findUnique({ where: { id } })).toBeNull();
    expect(await snapshot(value)).toEqual(before);
  });

  it.each(['REST', 'sync'])('%s 仍可编辑规则已删除的存量无发生日交易并保留来源', async (transport) => {
    const value = await fixture();
    const stored = await prisma.transaction.create({
      data: {
        ...value.transaction,
        id: randomUUID(),
        occurrenceDate: null,
        note: '存量来源',
      },
    });
    await prisma.recurringTransaction.update({ where: { id: value.rule.id }, data: { deletedAt: new Date() } });
    const note = '保留存量来源的人工修改';
    const response =
      transport === 'REST'
        ? await request('PATCH', `/ledgers/${value.ledgerId}/transactions/${stored.id}`, {
            base_revision: stored.revision,
            note,
          })
        : await request('POST', '/sync/push', {
            device_id: deviceId,
            changes: [
              {
                mutation_id: randomUUID(),
                entity_type: 'transaction',
                entity_id: stored.id,
                ledger_id: value.ledgerId,
                sync_id: value.syncId,
                base_revision: stored.revision,
                action: 'upsert',
                updated_at: new Date().toISOString(),
                payload: {
                  tx_type: 'expense',
                  amount: '10',
                  native_amount: '10',
                  currency_code: 'CNY',
                  happened_at: stored.happenedAt.toISOString(),
                  note,
                  category_id: null,
                  recurring_id: value.rule.id,
                  occurrence_date: null,
                  payer_member_id: stored.payerMemberId,
                  aa_mode: null,
                  splits: null,
                  last_edited_at: null,
                },
              },
            ],
          });
    expect(response.statusCode, response.body).toBe(200);
    if (transport === 'sync') expect(response.json()).toMatchObject({ outcomes: [{ status: 'accepted' }] });
    const edited = await prisma.transaction.findUniqueOrThrow({ where: { id: stored.id } });
    expect(edited).toMatchObject({
      recurringId: value.rule.id,
      occurrenceDate: null,
      note,
      revision: stored.revision + 1,
    });
  });
});
