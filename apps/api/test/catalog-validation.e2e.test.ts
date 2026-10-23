import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { exchangeRateOverrideId } from '../src/modules/accounting/index.js';
import type { SyncMutationEnvelope } from '../src/shared/sync-mutation.js';

const databaseUrl = testFixtureDatabaseUrl();
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type Fixture = { session: Session; ledgerId: string; syncId: string };
type Transport = 'REST' | 'PATCH' | 'import' | 'sync';
const transports: Transport[] = ['REST', 'PATCH', 'import', 'sync'];
const firstTime = '2026-09-20T00:00:00.000Z';
const secondTime = '2026-09-21T00:00:00.000Z';

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

/** 通过真实路由访问测试数据库，不直接替换校验或持久化实现。 */
async function api(method: 'POST' | 'PATCH', path: string, session?: Session, payload?: Record<string, unknown>) {
  try {
    return await app.inject({
      method,
      url: await accountingRequestFixturePath(
        app,
        method,
        `/api/v1${path}`,
        session ? { authorization: `Bearer ${session.access_token}` } : {},
      ),
      headers: session ? { authorization: `Bearer ${session.access_token}` } : {},
      payload,
    });
  } catch (cause) {
    throw new Error(`目录字段边界测试请求失败：${method} ${path}`, { cause });
  }
}

beforeAll(async () => {
  try {
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
    app = buildApp({
      prisma,
      logger: false,
      config: loadConfig({
        DATABASE_URL: databaseUrl,
        JWT_SECRET: 'catalog-validation-test-secret-at-least-32-bytes',
        STORAGE_PATH: resolve(import.meta.dirname, '../../../Temp/catalog-validation'),
        RATE_LIMIT_MAX: '10000',
        AUTH_RATE_LIMIT_MAX: '10000',
      }),
    });
    await app.ready();
  } catch (cause) {
    throw new Error('目录字段边界测试初始化失败', { cause });
  }
});

afterAll(async () => {
  try {
    if (app) await app.close();
    else if (prisma) await prisma.$disconnect();
  } catch (cause) {
    throw new Error('目录字段边界测试关闭失败', { cause });
  }
});

/** 每个场景使用独立账号和账本，避免同名实体、汇率身份或随机执行顺序互相影响。 */
async function fixture(): Promise<Fixture> {
  try {
    const registered = await api('POST', '/auth/register', undefined, {
      country_code: '+86',
      phone: `138${randomInt(100_000_000).toString().padStart(8, '0')}`,
      password: 'catalog-validation-password',
      device: { installation_id: randomUUID(), name: '目录边界测试', platform: 'test' },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const session = registered.json<Session>();
    const ledgerId = randomUUID();
    const ledger = await api('POST', '/ledgers', session, { id: ledgerId, name: '目录边界账本' });
    expect(ledger.statusCode, ledger.body).toBe(201);
    return { session, ledgerId, syncId: ledger.json<{ sync_id: string }>().sync_id };
  } catch (cause) {
    throw new Error('目录字段边界测试身份创建失败', { cause });
  }
}

/** 生成完整合法周期模板，覆盖字段只作为本用例需要验证的输入。 */
function recurringPayload(overrides: Record<string, unknown> = {}) {
  return {
    tx_type: 'expense',
    protocol_version: 1,
    time_zone: 'UTC',
    amount: '1',
    currency_code: 'CNY',
    category_id: null,
    note: null,
    frequency: 'monthly',
    interval: 1,
    day_of_month: 1,
    day_of_week: null,
    month_of_year: null,
    start_date: firstTime,
    end_date: null,
    last_generated_date: null,
    enabled: true,
    ...overrides,
  };
}

/** 分类完整输入与实际三个写入入口共用同一数据形状。 */
function categoryPayload(overrides: Record<string, unknown> = {}) {
  return { name: '边界分类', kind: 'expense', level: 1, parent_id: null, sort_order: 0, icon: null, ...overrides };
}

/** 构造协议外壳，用户级目录与账本级周期模板保留各自的作用域。 */
function mutation(
  context: Fixture,
  entityType: string,
  id: string,
  payload: Record<string, unknown>,
  time = firstTime,
): SyncMutationEnvelope {
  return {
    mutation_id: randomUUID(),
    entity_type: entityType,
    entity_id: id,
    ledger_id: entityType === 'recurring_transaction' ? context.ledgerId : null,
    ...(entityType === 'recurring_transaction' ? { sync_id: context.syncId } : {}),
    action: 'upsert',
    updated_at: time,
    payload,
  };
}

/** 确认逐项校验不会把整批请求改成数据库错误，也不会阻止后续合法项目提交。 */
async function push(context: Fixture, changes: SyncMutationEnvelope[], statuses: string[]) {
  try {
    const response = await api('POST', '/sync/push', context.session, {
      device_id: context.session.device_id,
      changes,
    });
    expect(response.statusCode, response.body).toBe(200);
    const outcomes = response.json<{ outcomes: Array<{ status: string; change_id: string | null }> }>().outcomes;
    expect(
      outcomes.map((item) => item.status),
      response.body,
    ).toEqual(statuses);
    for (const [index, status] of statuses.entries())
      if (status === 'invalid') expect(outcomes[index]!.change_id).toBeNull();
  } catch (cause) {
    throw new Error('目录字段边界同步结果验证失败', { cause });
  }
}

/** 外壳仍执行既定 Schema 校验，格式非法的批次在任何业务写入前整体拒绝。 */
async function rejectBatch(context: Fixture, changes: SyncMutationEnvelope[]) {
  try {
    const ownerId = context.session.user.user_id;
    /** 读取该账号的目录与事件全集，防止整批拒绝时仍偷偷提交某个合法项目。 */
    const snapshot = async () =>
      Promise.all([
        prisma.category.findMany({ where: { ownerId }, orderBy: { id: 'asc' } }),
        prisma.recurringTransaction.findMany({ where: { ownerId }, orderBy: { id: 'asc' } }),
        prisma.exchangeRateOverride.findMany({ where: { ownerId }, orderBy: { id: 'asc' } }),
        prisma.syncChange.findMany({ where: { userId: ownerId }, orderBy: { changeId: 'asc' } }),
      ]);
    const before = await snapshot();
    const response = await api('POST', '/sync/push', context.session, {
      device_id: context.session.device_id,
      changes,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await snapshot()).toEqual(before);
  } catch (cause) {
    throw new Error('目录字段 Schema 整批拒绝回归失败', { cause });
  }
}

/** 从指定入口写入分类；PATCH 只定位已有分类，其余入口按创建处理。 */
async function writeCategory(
  context: Fixture,
  transport: Transport,
  id: string,
  fields: Record<string, unknown>,
  invalid: boolean,
) {
  try {
    if (transport === 'sync') {
      const change = mutation(context, 'category', id, categoryPayload(fields));
      const followingId = randomUUID();
      await push(
        context,
        [change, mutation(context, 'category', followingId, categoryPayload({ name: `后续合法分类-${followingId}` }))],
        [invalid ? 'invalid' : 'accepted', 'accepted'],
      );
      expect(
        await prisma.category.findUnique({
          where: { id_ownerId: { id: followingId, ownerId: context.session.user.user_id } },
        }),
      ).not.toBeNull();
      return;
    }
    const payload = categoryPayload(fields);
    const response =
      transport === 'PATCH'
        ? await api('PATCH', `/ledgers/${context.ledgerId}/categories/${id}`, context.session, payload)
        : await api(
            'POST',
            `/ledgers/${context.ledgerId}/${transport === 'import' ? 'imports' : 'categories'}`,
            context.session,
            transport === 'import' ? { categories: [{ id, ...payload }] } : { id, ...payload },
          );
    expect(response.statusCode, response.body).toBe(invalid ? 400 : transport === 'PATCH' ? 200 : 201);
  } catch (cause) {
    throw new Error(`${transport} 分类存储边界验证失败`, { cause });
  }
}

describe('目录字段的 API 与数据库边界', () => {
  it('数值分类层级支持父子登记、引用交易及幂等重放，字符串层级拒绝且无写入', async () => {
    try {
      const context = await fixture();
      const ownerId = context.session.user.user_id;
      const rejectedParentId = randomUUID();
      const rejectedChildId = randomUUID();
      const rejected = [
        mutation(context, 'category', rejectedParentId, categoryPayload({ name: '字符串父分类', level: '1' })),
        mutation(
          context,
          'category',
          rejectedChildId,
          categoryPayload({ name: '字符串子分类', level: '2', parent_id: rejectedParentId }),
        ),
      ];
      // 重复发送相同非法请求仍必须明确拒绝，不能生成忽略成功或占用幂等身份。
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await api('POST', '/sync/push', context.session, {
          device_id: context.session.device_id,
          changes: rejected,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().outcomes, response.body).toEqual(
          rejected.map((change) =>
            expect.objectContaining({
              mutation_id: change.mutation_id,
              entity_id: change.entity_id,
              status: 'invalid',
              change_id: null,
              code: 'INVALID_CATEGORY_LEVEL',
            }),
          ),
        );
      }
      const rejectedMutationIds = rejected.map((change) => change.mutation_id);
      expect(await prisma.category.count({ where: { ownerId, id: { in: [rejectedParentId, rejectedChildId] } } })).toBe(
        0,
      );
      expect(
        await prisma.syncChange.count({ where: { userId: ownerId, mutationId: { in: rejectedMutationIds } } }),
      ).toBe(0);
      expect(
        await prisma.mutationReservation.count({ where: { userId: ownerId, mutationId: { in: rejectedMutationIds } } }),
      ).toBe(0);
      expect(
        await prisma.categoryConflict.count({ where: { ownerId, sourceMutationId: { in: rejectedMutationIds } } }),
      ).toBe(0);

      const parentId = randomUUID();
      const childId = randomUUID();
      const transactionId = randomUUID();
      const changes = [
        mutation(context, 'category', parentId, categoryPayload({ name: '服装', level: 1 })),
        mutation(context, 'category', childId, categoryPayload({ name: '衣服', level: 2, parent_id: parentId })),
        {
          ...mutation(context, 'transaction', transactionId, {
            tx_type: 'expense',
            amount: '100',
            happened_at: firstTime,
            note: '优衣库衣服',
            category_id: childId,
            currency_code: 'CNY',
            native_amount: '100',
            recurring_id: null,
            payer_member_id: null,
            aa_mode: null,
            splits: null,
            last_edited_at: null,
          }),
          ledger_id: context.ledgerId,
          sync_id: context.syncId,
        },
      ];
      await push(context, changes, ['accepted', 'accepted', 'accepted']);
      await push(context, changes, ['ignored', 'ignored', 'ignored']);
      expect(
        await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: parentId, ownerId } } }),
      ).toMatchObject({ level: 1, parentId: null });
      expect(
        await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: childId, ownerId } } }),
      ).toMatchObject({ level: 2, parentId });
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })).toMatchObject({
        categoryId: childId,
        categoryName: '衣服',
        revision: 1,
      });
      const events = await prisma.syncChange.findMany({
        where: { mutationId: { in: changes.map((change) => change.mutation_id) } },
        orderBy: { changeId: 'asc' },
      });
      expect(events).toHaveLength(3);
      expect(events[0]!.payload).toMatchObject({ level: 1 });
      expect(events[1]!.payload).toMatchObject({ level: 2, parent_id: parentId });
      expect(events[2]!.payload).toMatchObject({ category_id: childId, category_name: '衣服' });
    } catch (cause) {
      throw new Error('分类数值层级、字符串拒绝及交易依赖回归失败', { cause });
    }
  });

  it.each(['0x1', '0e1', '0,1'])('非规范 Decimal %s 由 Schema 整批拒绝，不提交同批合法项目', async (invalidDecimal) => {
    try {
      const context = await fixture();
      const recurringId = randomUUID();
      const goodRecurringId = randomUUID();
      const rateId = exchangeRateOverrideId(context.session.user.user_id, 'USD', 'CNY');
      const badAmount = mutation(
        context,
        'recurring_transaction',
        recurringId,
        recurringPayload({ amount: invalidDecimal }),
      );
      const badRate = mutation(context, 'exchange_rate_override', rateId, {
        base_currency: 'USD',
        quote_currency: 'CNY',
        rate: invalidDecimal,
      });
      await rejectBatch(context, [
        badAmount,
        badRate,
        mutation(context, 'recurring_transaction', goodRecurringId, recurringPayload({ amount: '0.0000000001' })),
        mutation(context, 'exchange_rate_override', rateId, {
          base_currency: 'USD',
          quote_currency: 'CNY',
          rate: '0.000000000000000001',
        }),
      ]);
      expect(await prisma.recurringTransaction.findUnique({ where: { id: recurringId } })).toBeNull();
      expect(
        await prisma.syncChange.count({
          where: { mutationId: { in: [badAmount.mutation_id, badRate.mutation_id] } },
        }),
      ).toBe(0);
      expect(await prisma.recurringTransaction.findUnique({ where: { id: goodRecurringId } })).toBeNull();
      expect(await prisma.exchangeRateOverride.findUnique({ where: { id: rateId } })).toBeNull();
    } catch (cause) {
      throw new Error('非规范 Decimal 隔离回归失败', { cause });
    }
  });

  it('目录字段保留原始类型，金额数字和分类强转值逐项拒绝，合法后续项目继续', async () => {
    try {
      const context = await fixture();
      const recurringId = randomUUID();
      const rateId = exchangeRateOverrideId(context.session.user.user_id, 'USD', 'CNY');
      const categoryIds = [randomUUID(), randomUUID(), randomUUID()];
      const invalid = [
        mutation(context, 'recurring_transaction', recurringId, recurringPayload({ amount: 1 })),
        mutation(context, 'exchange_rate_override', rateId, { base_currency: 'USD', quote_currency: 'CNY', rate: 0.5 }),
        mutation(context, 'category', categoryIds[0]!, categoryPayload({ sort_order: null })),
        mutation(context, 'category', categoryIds[1]!, categoryPayload({ sort_order: '1' })),
        mutation(context, 'category', categoryIds[2]!, categoryPayload({ icon: false })),
      ];
      const goodRecurringId = randomUUID();
      const goodCategoryId = randomUUID();
      await push(
        context,
        [
          ...invalid,
          mutation(context, 'recurring_transaction', goodRecurringId, recurringPayload({ amount: '0.0000000001' })),
          mutation(context, 'category', goodCategoryId, categoryPayload()),
        ],
        [...invalid.map(() => 'invalid'), 'accepted', 'accepted'],
      );
      expect(await prisma.recurringTransaction.findUnique({ where: { id: recurringId } })).toBeNull();
      expect(await prisma.exchangeRateOverride.findUnique({ where: { id: rateId } })).toBeNull();
      expect(
        await prisma.category.count({ where: { id: { in: categoryIds }, ownerId: context.session.user.user_id } }),
      ).toBe(0);
      expect(
        await prisma.syncChange.count({ where: { mutationId: { in: invalid.map((change) => change.mutation_id) } } }),
      ).toBe(0);
      expect(
        (await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: goodRecurringId } })).amount.equals(
          '0.0000000001',
        ),
      ).toBe(true);
      expect(
        await prisma.category.findUnique({
          where: { id_ownerId: { id: goodCategoryId, ownerId: context.session.user.user_id } },
        }),
      ).not.toBeNull();
    } catch (cause) {
      throw new Error('目录字段原始类型隔离回归失败', { cause });
    }
  });

  it('目录 mutation 指纹使用原始值，不能把字符串排序强转后当成同一请求重放', async () => {
    try {
      const context = await fixture();
      const id = randomUUID();
      const change = mutation(context, 'category', id, categoryPayload({ sort_order: 1 }));
      await push(context, [change], ['accepted']);
      const where = { id_ownerId: { id, ownerId: context.session.user.user_id } };
      const before = await prisma.category.findUniqueOrThrow({ where });
      const events = await prisma.syncChange.findMany({ where: { entityId: id }, orderBy: { changeId: 'asc' } });
      const response = await api('POST', '/sync/push', context.session, {
        device_id: context.session.device_id,
        changes: [{ ...change, payload: { ...change.payload, sort_order: '1' } }],
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: 'MUTATION_ID_REUSED' });
      expect(await prisma.category.findUniqueOrThrow({ where })).toEqual(before);
      expect(await prisma.syncChange.findMany({ where: { entityId: id }, orderBy: { changeId: 'asc' } })).toEqual(
        events,
      );
    } catch (cause) {
      throw new Error('目录 mutation 原始请求指纹回归失败', { cause });
    }
  });

  it.each([
    { name: '日期倒置', fields: { end_date: '2026-09-19T00:00:00.000Z' }, batchRejected: false },
    { name: '每月日超界', fields: { day_of_month: 32 }, batchRejected: true },
    { name: '每周日超界', fields: { day_of_week: 8 }, batchRejected: true },
    { name: '月份超界', fields: { month_of_year: 13 }, batchRejected: true },
    { name: '每月日为零', fields: { day_of_month: 0 }, batchRejected: false },
    { name: '每周日为零', fields: { day_of_week: 0 }, batchRejected: false },
    { name: '月份为零', fields: { month_of_year: 0 }, batchRejected: false },
    { name: '结束日期为零', fields: { end_date: 0 }, batchRejected: true },
  ])('周期模板$name 按输入边界拒绝，旧状态和事件不变', async ({ fields, batchRejected }) => {
    try {
      const context = await fixture();
      const id = randomUUID();
      await push(context, [mutation(context, 'recurring_transaction', id, recurringPayload())], ['accepted']);
      const before = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id } });
      const events = await prisma.syncChange.findMany({ where: { entityId: id }, orderBy: { changeId: 'asc' } });
      const followingId = randomUUID();
      const changes = [
        mutation(context, 'recurring_transaction', id, recurringPayload(fields), secondTime),
        mutation(context, 'recurring_transaction', followingId, recurringPayload()),
      ];
      if (batchRejected) await rejectBatch(context, changes);
      else await push(context, changes, ['invalid', 'accepted']);
      expect(await prisma.recurringTransaction.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect(await prisma.syncChange.findMany({ where: { entityId: id }, orderBy: { changeId: 'asc' } })).toEqual(
        events,
      );
      const following = await prisma.recurringTransaction.findUnique({ where: { id: followingId } });
      if (batchRejected) expect(following).toBeNull();
      else expect(following).not.toBeNull();
    } catch (cause) {
      throw new Error('周期模板数据库关联约束前置校验回归失败', { cause });
    }
  });

  it('周期日期相等、日月边界及金额汇率最大精度均可正常保存', async () => {
    try {
      const context = await fixture();
      const amount = '9999999999999999999999999999.9999999999';
      const rate = '99999999999999999999.999999999999999999';
      const recurringId = randomUUID();
      const rateId = exchangeRateOverrideId(context.session.user.user_id, 'USD', 'CNY');
      await push(
        context,
        [
          mutation(
            context,
            'recurring_transaction',
            recurringId,
            recurringPayload({ amount, day_of_month: 31, day_of_week: 7, month_of_year: 12, end_date: firstTime }),
          ),
          mutation(context, 'exchange_rate_override', rateId, { base_currency: 'USD', quote_currency: 'CNY', rate }),
        ],
        ['accepted', 'accepted'],
      );
      const recurring = await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: recurringId } });
      expect(recurring).toMatchObject({ dayOfMonth: 31, dayOfWeek: 7, monthOfYear: 12, endDate: recurring.startDate });
      expect(recurring.amount.equals(amount)).toBe(true);
      expect((await prisma.exchangeRateOverride.findUniqueOrThrow({ where: { id: rateId } })).rate.equals(rate)).toBe(
        true,
      );
    } catch (cause) {
      throw new Error('周期与 Decimal 合法边界回归失败', { cause });
    }
  });

  it.each(
    [
      { name: '超长 Unicode 图标', fields: { icon: '🧪'.repeat(256) } },
      { name: '图标包含空字符', fields: { icon: 'icon\u0000name' } },
      { name: '图标包含孤立代理项', fields: { icon: '\uD800' } },
      { name: '排序高于 int32', fields: { sort_order: 2147483648 } },
      { name: '排序低于 int32', fields: { sort_order: -2147483649 } },
    ].flatMap((testCase) => transports.map((transport) => ({ ...testCase, transport }))),
  )('分类$name 在 $transport 中拒绝且无副作用', async ({ fields, transport }) => {
    try {
      const context = await fixture();
      const id = randomUUID();
      if (transport === 'PATCH') await writeCategory(context, 'REST', id, {}, false);
      const where = { id_ownerId: { id, ownerId: context.session.user.user_id } };
      const before = await prisma.category.findUnique({ where });
      const events = await prisma.syncChange.findMany({ where: { entityId: id }, orderBy: { changeId: 'asc' } });
      await writeCategory(context, transport, id, fields, true);
      expect(await prisma.category.findUnique({ where })).toEqual(before);
      expect(await prisma.syncChange.findMany({ where: { entityId: id }, orderBy: { changeId: 'asc' } })).toEqual(
        events,
      );
    } catch (cause) {
      throw new Error('分类多入口非法存储字段回归失败', { cause });
    }
  });

  it.each([-2147483648, 2147483647])('分类 int32 边界 %s 与 255 个 Unicode 字符在各入口保持原值', async (sortOrder) => {
    try {
      const icon = '🧪'.repeat(255);
      for (const transport of transports) {
        const context = await fixture();
        const id = randomUUID();
        if (transport === 'PATCH') await writeCategory(context, 'REST', id, {}, false);
        await writeCategory(context, transport, id, { sort_order: sortOrder, icon }, false);
        expect(
          await prisma.category.findUniqueOrThrow({
            where: { id_ownerId: { id, ownerId: context.session.user.user_id } },
          }),
        ).toMatchObject({ sortOrder, icon });
      }
    } catch (cause) {
      throw new Error('分类多入口 Unicode 与整数合法边界回归失败', { cause });
    }
  });
});
