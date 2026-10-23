import { testStoragePath } from './test-storage-path.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { recurringOccurrenceId } from '../src/modules/accounting/index.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'recurring-test-only-secret-at-least-32-bytes',
      STORAGE_PATH: testStoragePath('recurring-protocol'),
    }),
    authRateLimitMax: 10000,
    rateLimitMax: 10000,
  },
});
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Fixture = { session: Session; ledger: { id: string; sync_id: string } };
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 通过正式认证入口创建独立测试身份，数据库地址由测试目标守卫确认。 */
async function fixture(): Promise<Fixture> {
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `139${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'recurring-test-only',
      device: { installation_id: randomUUID(), name: '周期协议测试', platform: 'test' },
    },
  });
  expect(registered.statusCode, registered.body).toBe(201);
  const session = registered.json<Session>();
  const ledger = await request(session, 'POST', '/ledgers', { name: '周期协议测试', currency: 'CNY' });
  expect(ledger.statusCode, ledger.body).toBe(201);
  return { session, ledger: ledger.json() };
}

/** 带真实用户会话调用业务路由，错误响应保留在断言信息内。 */
function request(session: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      authorization: `Bearer ${session.access_token}`,
      'idempotency-key': randomUUID(),
    },
    ...(payload ? { payload } : {}),
  });
}

/** 冻结可重放的周期变更信封。 */
function ruleChange(context: Fixture, id = randomUUID(), overrides: Record<string, unknown> = {}) {
  return {
    mutation_id: randomUUID(),
    entity_type: 'recurring_transaction',
    entity_id: id,
    ledger_id: context.ledger.id,
    sync_id: context.ledger.sync_id,
    action: 'upsert',
    updated_at: '2026-01-02T00:00:00.000Z',
    payload: {
      tx_type: 'expense',
      amount: '10',
      currency_code: 'CNY',
      category_id: null,
      note: null,
      frequency: 'daily',
      interval: 1,
      day_of_month: null,
      day_of_week: null,
      month_of_year: null,
      start_date: '2024-02-27T00:00:00.000Z',
      end_date: '2024-02-29T00:00:00.000Z',
      protocol_version: 1,
      time_zone: 'UTC',
      enabled: true,
      ...overrides,
    },
  };
}

/** 使用正式同步入口并返回单条业务回执。 */
async function push(context: Fixture, change: object) {
  const response = await request(context.session, 'POST', '/sync/push', {
    device_id: context.session.device_id,
    changes: [change],
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().outcomes[0];
}

/** 构造客户端可复用的幂等生成请求。 */
function generation(context: Fixture, extra: Record<string, unknown> = {}) {
  return { mutation_id: randomUUID(), expected_sync_id: context.ledger.sync_id, expected_currency: 'CNY', ...extra };
}

/** 原子生成发生，返回用于计数和游标断言的真实响应。 */
async function generate(context: Fixture, body = generation(context)) {
  const response = await request(
    context.session,
    'POST',
    `/ledgers/${context.ledger.id}/recurring-transactions/generate-due`,
    body,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

/** 历史与离线发生共用客户端 wire 载荷。 */
function occurrence(ruleId: string, date: string, amount = '10') {
  return {
    tx_type: 'expense',
    amount,
    native_amount: amount,
    currency_code: 'CNY',
    happened_at: `${date}T00:00:00.000Z`,
    note: '人工历史',
    category_id: null,
    recurring_id: ruleId,
    occurrence_date: date,
    payer_member_id: null,
    aa_mode: null,
    splits: null,
    last_edited_at: null,
  };
}

describe('真实 PostgreSQL 周期生成与迁入', () => {
  it('未发生且没有生成游标的云端规则可以更改时区并同步新元数据', async () => {
    const context = await fixture();
    const change = ruleChange(context, randomUUID(), {
      time_zone: 'Asia/Shanghai',
      start_date: '2030-01-01T00:00:00.000Z',
      end_date: '2030-01-01T00:00:00.000Z',
    });
    expect((await push(context, change)).status).toBe('accepted');
    const edited = {
      ...change,
      mutation_id: randomUUID(),
      updated_at: '2026-01-03T00:00:00.000Z',
      payload: { ...change.payload, time_zone: 'Asia/Tokyo' },
    };
    expect((await push(context, edited)).status).toBe('accepted');
    const stored = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: change.entity_id } });
    expect(stored).toMatchObject({ timeZone: 'Asia/Tokyo', lastGeneratedDate: null });
    expect(await prisma.transaction.count({ where: { recurringId: change.entity_id } })).toBe(0);
    const event = await prisma.syncChange.findFirstOrThrow({
      where: { deviceId: context.session.device_id, mutationId: edited.mutation_id },
    });
    expect(event.payload).toMatchObject({ time_zone: 'Asia/Tokyo', last_generated_date: null });
    expect((await push(context, edited)).status).toBe('ignored');
  });

  it.each(['active', 'tombstone'] as const)('已有%s发生时拒绝改变时区且保留规则、发生和同步回执', async (kind) => {
    const context = await fixture();
    const ruleId = randomUUID();
    const date = '2024-02-27';
    const change = ruleChange(context, ruleId, {
      end_date: `${date}T00:00:00.000Z`,
      ...(kind === 'tombstone'
        ? {
            initial_state: {
              last_generated_date: null,
              deleted_at: null,
              occurrences: [
                {
                  id: recurringOccurrenceId(context.ledger.id, ruleId, date),
                  deleted_at: '2025-01-01T03:00:00.000Z',
                  payload: occurrence(ruleId, date),
                },
              ],
            },
          }
        : {}),
    });
    expect((await push(context, change)).status).toBe('accepted');
    if (kind === 'active') await generate(context);
    const beforeRule = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: ruleId } });
    const beforeOccurrences = await prisma.transaction.findMany({
      where: { recurringId: ruleId },
      include: { splits: true },
      orderBy: { id: 'asc' },
    });
    const beforeEvents = await prisma.syncChange.findMany({
      where: { ledgerId: context.ledger.id },
      orderBy: { changeId: 'asc' },
    });
    expect(beforeOccurrences).toHaveLength(1);
    if (kind === 'tombstone') {
      expect(beforeRule.lastGeneratedDate).toBeNull();
      expect(beforeOccurrences[0]!.deletedAt).not.toBeNull();
    }
    const metadata: Record<string, unknown> = { ...change.payload };
    delete metadata.initial_state;
    const edited = {
      ...change,
      mutation_id: randomUUID(),
      updated_at: '2026-01-04T00:00:00.000Z',
      payload: { ...metadata, time_zone: 'Asia/Tokyo', amount: '33' },
    };
    const rejected = await push(context, edited);
    expect(rejected).toMatchObject({
      status: 'invalid',
      change_id: null,
      message: '已生成账单的规则不能修改时区，请新建规则',
    });
    expect(await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: ruleId } })).toEqual(beforeRule);
    expect(
      await prisma.transaction.findMany({
        where: { recurringId: ruleId },
        include: { splits: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(beforeOccurrences);
    expect(
      await prisma.syncChange.findMany({ where: { ledgerId: context.ledger.id }, orderBy: { changeId: 'asc' } }),
    ).toEqual(beforeEvents);
    expect(
      await prisma.syncChange.count({ where: { deviceId: context.session.device_id, mutationId: edited.mutation_id } }),
    ).toBe(0);
  });

  it.each(['protocol_version', 'time_zone'])('缺少 %s 的周期请求整批拒绝且没有写入', async (field) => {
    const context = await fixture();
    const change = ruleChange(context);
    const payload: Record<string, unknown> = { ...change.payload };
    delete payload[field];
    const response = await request(context.session, 'POST', '/sync/push', {
      device_id: context.session.device_id,
      changes: [{ ...change, payload }],
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(await prisma.recurringTransaction.findUnique({ where: { id: change.entity_id } })).toBeNull();
    expect(await prisma.syncChange.count({ where: { mutationId: change.mutation_id } })).toBe(0);
  });

  it.each([false, true])('普通周期请求可省略或保留进度字段，冻结重放保持指纹：携带=%s', async (withCursor) => {
    const context = await fixture();
    const change = ruleChange(
      context,
      randomUUID(),
      withCursor ? { last_generated_date: '2024-02-28T00:00:00.000Z' } : {},
    );
    expect(Object.hasOwn(change.payload, 'last_generated_date')).toBe(withCursor);
    const accepted = await push(context, change);
    expect(accepted.status).toBe('accepted');
    const receipt = await prisma.syncChange.findUniqueOrThrow({
      where: { deviceId_mutationId: { deviceId: context.session.device_id, mutationId: change.mutation_id } },
    });
    expect(receipt.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: change.entity_id } })).lastGeneratedDate,
    ).toBeNull();
    expect(await push(context, change)).toMatchObject({ status: 'ignored', change_id: accepted.change_id });
    expect((await prisma.syncChange.findUniqueOrThrow({ where: { changeId: receipt.changeId } })).requestHash).toBe(
      receipt.requestHash,
    );
    expect(await prisma.syncChange.count({ where: { mutationId: change.mutation_id } })).toBe(1);

    // 已冻结请求的字段集合也是请求身份；相同 mutation 不能改用另一种载荷重放。
    const changedPayload: Record<string, unknown> = { ...change.payload };
    if (withCursor) delete changedPayload.last_generated_date;
    else changedPayload.last_generated_date = null;
    const changed = await request(context.session, 'POST', '/sync/push', {
      device_id: context.session.device_id,
      changes: [{ ...change, payload: changedPayload }],
    });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().code).toBe('MUTATION_ID_REUSED');
    expect((await generate(context)).generated_count).toBe(3);
    const listed = await request(context.session, 'GET', `/ledgers/${context.ledger.id}/recurring-transactions`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items).toEqual([
      expect.objectContaining({ id: change.entity_id, last_generated_date: '2024-02-29T00:00:00.000Z' }),
    ]);
  });

  it('现代元数据不能推进客户端游标，存量生成进度完整保留', async () => {
    const context = await fixture();
    const change = ruleChange(context, randomUUID(), { last_generated_date: '2024-02-29T00:00:00.000Z' });
    expect((await push(context, change)).status).toBe('accepted');
    expect(
      (await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: change.entity_id } })).lastGeneratedDate,
    ).toBeNull();
    // 已确认的历史进度由夹具独立写入，验证规则编辑不会重解释或清空存量游标。
    await prisma.recurringTransaction.update({
      where: { id: change.entity_id },
      data: {
        lastGeneratedDate: new Date('2024-02-27T00:00:00.000Z'),
        updatedAt: new Date(change.updated_at),
      },
    });
    expect(
      (
        await push(context, {
          ...change,
          mutation_id: randomUUID(),
          updated_at: '2026-01-03T00:00:00.000Z',
          payload: { ...change.payload, last_generated_date: '2024-02-29T00:00:00.000Z' },
        })
      ).status,
    ).toBe('accepted');
    const stored = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: change.entity_id } });
    expect(stored.lastGeneratedDate?.toISOString()).toBe('2024-02-27T00:00:00.000Z');
    expect((await generate(context)).generated_count).toBe(2);
  });

  it('限额、并发与重放只生成一次，编辑规则不倒退游标', async () => {
    const context = await fixture();
    const change = ruleChange(context);
    expect((await push(context, change)).status).toBe('accepted');
    const firstRequest = generation(context, { limit: 1 });
    expect(await generate(context, firstRequest)).toMatchObject({
      generated_count: 1,
      has_more: true,
      replayed: false,
    });
    expect(await generate(context, firstRequest)).toMatchObject({ generated_count: 1, replayed: true });
    const results = await Promise.all([generate(context), generate(context)]);
    expect(results.reduce((sum, result) => sum + result.generated_count, 0)).toBe(2);
    const rows = await prisma.transaction.findMany({ where: { ledgerId: context.ledger.id } });
    expect(rows).toHaveLength(3);
    for (const row of rows)
      expect(row.id).toBe(recurringOccurrenceId(context.ledger.id, change.entity_id, row.occurrenceDate!));
    expect(
      (
        await push(context, {
          ...change,
          mutation_id: randomUUID(),
          updated_at: '2026-01-03T00:00:00.000Z',
          payload: { ...change.payload, amount: '11', last_generated_date: null },
        })
      ).status,
    ).toBe('accepted');
    expect(
      (
        await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: change.entity_id } })
      ).lastGeneratedDate?.toISOString(),
    ).toBe('2024-02-29T00:00:00.000Z');
    expect((await generate(context)).generated_count).toBe(0);
  });

  it('迟到的离线首次发生采用权威人工编辑，删除后也不会复活', async () => {
    const context = await fixture();
    const rule = ruleChange(context, randomUUID(), { end_date: '2024-02-27T00:00:00.000Z' });
    await push(context, rule);
    await generate(context);
    const id = recurringOccurrenceId(context.ledger.id, rule.entity_id, '2024-02-27');
    const edited = await request(context.session, 'PATCH', `/ledgers/${context.ledger.id}/transactions/${id}`, {
      base_revision: 1,
      amount: '22',
      native_amount: '22',
      note: '云端人工修改',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const offline = {
      mutation_id: randomUUID(),
      entity_type: 'transaction',
      entity_id: id,
      ledger_id: context.ledger.id,
      sync_id: context.ledger.sync_id,
      base_revision: 0,
      action: 'upsert',
      updated_at: '2026-01-03T00:00:00.000Z',
      payload: occurrence(rule.entity_id, '2024-02-27'),
    };
    expect(await push(context, offline)).toMatchObject({
      status: 'ignored',
      current_revision: 2,
      current_entity: { amount: '22', note: '云端人工修改' },
    });
    const removed = await request(context.session, 'DELETE', `/ledgers/${context.ledger.id}/transactions/${id}`, {
      base_revision: 2,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await push(context, { ...offline, mutation_id: randomUUID() })).toMatchObject({
      status: 'ignored',
      current_deleted: true,
    });
    expect((await generate(context)).generated_count).toBe(0);
  });

  it('迁入历史人工金额与原始墓碑，两个full协议均完整且跨账号不可见', async () => {
    const context = await fixture();
    const ruleId = randomUUID();
    const deletedAt = '2025-01-01T03:00:00.000Z';
    const history = ['2024-02-27', '2024-02-28'].map((date, index) => ({
      id: recurringOccurrenceId(context.ledger.id, ruleId, date),
      deleted_at: index === 0 ? deletedAt : null,
      payload: occurrence(ruleId, date, index === 0 ? '10' : '33'),
    }));
    const change = ruleChange(context, ruleId, {
      frequency: 'monthly',
      day_of_month: 31,
      enabled: false,
      initial_state: { last_generated_date: '2024-02-28T00:00:00.000Z', deleted_at: deletedAt, occurrences: history },
    });
    expect((await push(context, change)).status).toBe('accepted');
    expect((await push(context, change)).status).toBe('ignored');
    expect(await prisma.transaction.count({ where: { ledgerId: context.ledger.id } })).toBe(2);
    const tombstoneEvents = await prisma.syncChange.findMany({
      where: { entityId: history[0]!.id },
      orderBy: { changeId: 'asc' },
    });
    expect(
      tombstoneEvents.map((event) => ({
        action: event.action,
        revision: (event.payload as { revision: number }).revision,
      })),
    ).toEqual([
      { action: 'upsert', revision: 1 },
      { action: 'delete', revision: 2 },
    ]);
    for (const path of [
      `/sync/full?ledger_id=${context.ledger.id}&include_recurring_state=true`,
      '/sync/accounting/full?include_recurring_state=true',
    ]) {
      const response = await request(context.session, 'GET', path);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      const snapshot =
        body.ledger_snapshots?.find((item: { ledger: { id: string } }) => item.ledger.id === context.ledger.id) ?? body;
      expect(snapshot.recurring_state.rules).toEqual([
        expect.objectContaining({
          id: ruleId,
          deleted_at: deletedAt,
          last_generated_date: '2024-02-28T00:00:00.000Z',
        }),
      ]);
      expect(snapshot.recurring_state.occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: history[0]!.id, deleted_at: deletedAt }),
          expect.objectContaining({ id: history[1]!.id, amount: '33', deleted_at: null }),
        ]),
      );
    }
    const plain = await request(context.session, 'GET', `/sync/full?ledger_id=${context.ledger.id}`);
    expect(plain.json()).not.toHaveProperty('recurring_state');
    const foreign = await fixture();
    const forbidden = await request(
      foreign.session,
      'GET',
      `/sync/full?ledger_id=${context.ledger.id}&include_recurring_state=true`,
    );
    expect([403, 404]).toContain(forbidden.statusCode);
    const foreignAll = await request(foreign.session, 'GET', '/sync/accounting/full?include_recurring_state=true');
    expect(JSON.stringify(foreignAll.json())).not.toContain(ruleId);
    expect((await generate(context)).generated_count).toBe(0);
    const restored = await push(context, { ...ruleChange(context, ruleId), updated_at: '2026-01-04T00:00:00.000Z' });
    expect(restored).toMatchObject({ status: 'ignored', current_deleted: true });
  });

  it('历史缺少游标佐证或发生身份无效时规则与发生全部回滚', async () => {
    const context = await fixture();
    for (const wrong of ['cursor', 'identity', 'member']) {
      const id = randomUUID();
      const date = '2024-02-27';
      const change = ruleChange(context, id, {
        initial_state: {
          last_generated_date: `${wrong === 'cursor' ? '2024-02-28' : date}T00:00:00.000Z`,
          deleted_at: null,
          occurrences: [
            {
              id: wrong === 'identity' ? randomUUID() : recurringOccurrenceId(context.ledger.id, id, date),
              deleted_at: null,
              payload: { ...occurrence(id, date), payer_member_id: wrong === 'member' ? randomUUID() : null },
            },
          ],
        },
      });
      expect((await push(context, change)).status).toBe('invalid');
      expect(await prisma.recurringTransaction.count({ where: { id } })).toBe(0);
      expect(await prisma.transaction.count({ where: { recurringId: id } })).toBe(0);
    }
  });

  it('缺少汇率原子回滚，非法时区和身份变化明确拒绝', async () => {
    const context = await fixture();
    const change = ruleChange(context, randomUUID(), { currency_code: 'USD', end_date: '2024-02-27T00:00:00.000Z' });
    await push(context, change);
    const missing = await request(
      context.session,
      'POST',
      `/ledgers/${context.ledger.id}/recurring-transactions/generate-due`,
      generation(context),
    );
    expect(missing.statusCode, missing.body).toBe(400);
    expect(await prisma.transaction.count({ where: { ledgerId: context.ledger.id } })).toBe(0);
    expect((await generate(context, generation(context, { rates: { USD: '7.2' } }))).generated_count).toBe(1);
    expect(
      (await prisma.transaction.findFirstOrThrow({ where: { ledgerId: context.ledger.id } })).nativeAmount.toString(),
    ).toBe('72');
    expect((await push(context, ruleChange(context, randomUUID(), { time_zone: 'GMT+08:00' }))).status).toBe('invalid');
    expect(
      (
        await push(context, {
          ...change,
          mutation_id: randomUUID(),
          updated_at: '2026-01-04T00:00:00.000Z',
          payload: { ...change.payload, time_zone: 'Asia/Shanghai' },
        })
      ).status,
    ).toBe('invalid');
    const page = await request(context.session, 'GET', `/ledgers/${context.ledger.id}/recurring-transactions?limit=1`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().items[0]).toMatchObject({ protocol_version: 1, time_zone: 'UTC' });
  });
});
