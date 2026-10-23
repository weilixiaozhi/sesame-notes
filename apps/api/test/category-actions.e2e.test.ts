import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'category-actions-test-secret-at-least-32-bytes',
      STORAGE_PATH: '.category-actions-test-storage',
    }),
    authRateLimitMax: 1000,
    rateLimitMax: 1000,
  },
});
beforeAll(() => app.ready());
afterAll(() => app.close());

/** 每项用例创建不同账号；此客户端只访问测试应用，不读取用户凭证。 */
async function account() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'category-test',
      device: { installation_id: randomUUID(), name: '分类测试', platform: 'test' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const session = response.json<{ access_token: string; user: { user_id: string } }>();
  const call = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object, key?: string) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${session.access_token}`, ...(key ? { 'idempotency-key': key } : {}) },
      ...(payload ? { payload } : {}),
    });
  const ledgerResponse = await call('POST', '/ledgers', { name: '分类测试本', currency: 'CNY' });
  expect(ledgerResponse.statusCode, ledgerResponse.body).toBe(201);
  const ledger = ledgerResponse.json<{ id: string }>();
  const category = async (name: string, parent?: string, id: string = randomUUID()) => {
    const response = await call('POST', `/ledgers/${ledger.id}/categories`, {
      id,
      name,
      kind: 'expense',
      level: parent ? 2 : 1,
      parent_id: parent ?? null,
      sort_order: 0,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string; updated_at: string; sort_order: number }>();
  };
  const transaction = async (categoryId: string, ledgerId = ledger.id) => {
    const response = await call('POST', `/ledgers/${ledgerId}/transactions`, {
      id: randomUUID(),
      tx_type: 'expense',
      amount: '10',
      native_amount: '10',
      currency_code: 'CNY',
      category_id: categoryId,
      happened_at: '2026-09-30T08:00:00.000Z',
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string; revision: number }>();
  };
  const preview = async (categoryIds: string[]) => {
    const response = await call('POST', `/ledgers/${ledger.id}/categories/removal-preview`, {
      category_ids: categoryIds,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ preview_token: string; transaction_count: number }>();
  };
  return { ...session, call, ledger, category, transaction, preview };
}

describe('分类批量命令', () => {
  it.each(['missing', 'rename', 'reparent'] as const)(
    '迁移目标%s时拒绝旧确认，源分类和交易保持原样',
    async (change) => {
      const user = await account();
      const source = await user.category('目标版本源');
      const target = await user.category('确认过的目标');
      const parent = await user.category('新的目标父分类');
      const transaction = await user.transaction(source.id);
      const scope = await user.preview([source.id]);
      if (change !== 'missing') {
        const changed = await user.call(
          'PATCH',
          `/ledgers/${user.ledger.id}/categories/${target.id}`,
          change === 'rename' ? { name: '另一设备改名后的目标' } : { level: 2, parent_id: parent.id },
        );
        expect(changed.statusCode, changed.body).toBe(200);
        expect(changed.json<{ updated_at: string }>().updated_at).not.toBe(target.updated_at);
      }
      expect((await user.preview([source.id])).preview_token).toBe(scope.preview_token);
      const response = await user.call(
        'POST',
        `/ledgers/${user.ledger.id}/categories/remove`,
        {
          category_ids: [source.id],
          mode: 'migrate',
          target_category_id: target.id,
          ...(change === 'missing' ? {} : { expected_target_updated_at: target.updated_at }),
          preview_token: scope.preview_token,
        },
        randomUUID(),
      );
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: 'CATEGORY_TARGET_CHANGED' });
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).toMatchObject({
        categoryId: source.id,
        revision: 1,
        deletedAt: null,
      });
      expect(
        (
          await prisma.category.findUniqueOrThrow({
            where: { id_ownerId: { id: source.id, ownerId: user.user.user_id } },
          })
        ).deletedAt,
      ).toBeNull();
    },
  );

  it('批量查重与落库使用相同名称规范，U0085空白不能绕过同名检查', async () => {
    const user = await account();
    const defaults = await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } });
    expect(defaults).toHaveLength(61);
    const custom = await user.category('已存在餐饮');
    const before = await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } });
    expect(before).toHaveLength(62);
    expect(before.filter((category) => category.id !== custom.id)).toEqual(defaults);
    const count = await prisma.syncChange.count({ where: { userId: user.user.user_id } });
    const response = await user.call(
      'POST',
      `/ledgers/${user.ledger.id}/categories/add-batch`,
      { items: [{ id: randomUUID(), name: '\u0085已存在餐饮\u0085', kind: 'expense', level: 1 }] },
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CATEGORY_NAME_CONFLICT' });
    expect(await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id } })).toBe(count);
  });

  it.each([
    ['delete', true],
    ['delete', false],
    ['migrate', true],
    ['migrate', false],
    ['promote', true],
    ['promote', false],
  ] as const)('分类%s清空周期分类并保留原排期与启用状态%s', async (mode, enabled) => {
    const user = await account();
    const source = await user.category('周期源');
    const target = await user.category('周期目标');
    const rule = await prisma.recurringTransaction.create({
      data: {
        id: randomUUID(),
        ledgerId: user.ledger.id,
        ownerId: user.user.user_id,
        txType: 'expense',
        amount: '10',
        currencyCode: 'CNY',
        categoryId: source.id,
        frequency: 'monthly',
        dayOfMonth: 15,
        startDate: new Date('2026-10-01T00:00:00Z'),
        enabled,
      },
    });
    const scope = await user.preview([source.id]);
    const response = await user.call(
      'POST',
      `/ledgers/${user.ledger.id}/categories/remove`,
      {
        category_ids: [source.id],
        mode,
        preview_token: scope.preview_token,
        ...(mode === 'migrate' ? { target_category_id: target.id, expected_target_updated_at: target.updated_at } : {}),
      },
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ affected_recurring_rules: 1 });
    expect(await prisma.recurringTransaction.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({
      enabled,
      categoryId: null,
      lastGeneratedDate: null,
    });
    const notifications = await prisma.syncChange.findMany({
      where: {
        userId: user.user.user_id,
        entityType: 'ledger',
        entityId: user.ledger.id,
      },
    });
    expect(notifications.some((item) => (item.payload as { requires_full?: boolean }).requires_full === true)).toBe(
      true,
    );
  });

  it('超过100项的完整父子模板一次写入，重放不增加实体或同步事件', async () => {
    const user = await account();
    const defaults = await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } });
    expect(defaults).toHaveLength(61);
    const defaultIds = new Set(defaults.map((category) => category.id));
    const rootId = randomUUID();
    const items = Array.from({ length: 130 }, (_, index) => ({
      id: index === 0 ? rootId : randomUUID(),
      name: `完整模板${index}`,
      kind: 'expense',
      level: index === 0 ? 1 : 2,
      parent_id: index === 0 ? null : rootId,
      sort_order: index,
      icon: 'wallet',
    }));
    const key = randomUUID();
    const path = `/ledgers/${user.ledger.id}/categories/add-batch`;
    const response = await user.call('POST', path, { items }, key);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toHaveLength(130);
    const beforeReplay = await prisma.category.findMany({
      where: { ownerId: user.user.user_id },
      orderBy: { id: 'asc' },
    });
    expect(beforeReplay).toHaveLength(191);
    expect(beforeReplay.map((category) => category.id).sort()).toEqual(
      [...defaultIds, ...items.map((category) => category.id)].sort(),
    );
    expect(beforeReplay.filter((category) => defaultIds.has(category.id))).toEqual(defaults);
    const count = await prisma.syncChange.count({ where: { userId: user.user.user_id } });
    const replay = await user.call('POST', path, { items }, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(response.json());
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id } })).toBe(count);
    expect(await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } })).toEqual(
      beforeReplay,
    );
  });

  it('模板后续父引用无效时回滚前面已创建的分类和同步事件', async () => {
    const user = await account();
    const before = await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } });
    expect(before).toHaveLength(61);
    const count = await prisma.syncChange.count({ where: { userId: user.user.user_id } });
    const response = await user.call(
      'POST',
      `/ledgers/${user.ledger.id}/categories/add-batch`,
      {
        items: [
          { id: randomUUID(), name: '不会残留', kind: 'expense', level: 1, sort_order: 0 },
          { id: randomUUID(), name: '错误引用', kind: 'expense', level: 2, parent_id: randomUUID(), sort_order: 1 },
        ],
      },
      randomUUID(),
    );
    expect([400, 404]).toContain(response.statusCode);
    expect(await prisma.category.findMany({ where: { ownerId: user.user.user_id }, orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id } })).toBe(count);
  });

  it('拒绝未支持的删除策略，关联交易和分类保持原值', async () => {
    const user = await account();
    const source = await user.category('保留交易');
    const transaction = await user.transaction(source.id);
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    const scope = await user.preview([source.id]);
    const response = await user.call(
      'POST',
      `/ledgers/${user.ledger.id}/categories/remove`,
      {
        category_ids: [source.id],
        mode: 'uncategorize',
        preview_token: scope.preview_token,
      },
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(400);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(after).toEqual(before);
    expect(
      await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: source.id, ownerId: user.user.user_id } } }),
    ).toMatchObject({ deletedAt: null });
  });

  it('排序整批校验版本，响应丢失重试不重复写事件', async () => {
    const user = await account();
    const first = await user.category('排序甲');
    const second = await user.category('排序乙');
    const body = {
      items: [
        { id: first.id, sort_order: 2, expected_updated_at: first.updated_at },
        { id: second.id, sort_order: 1, expected_updated_at: second.updated_at },
      ],
    };
    const result = await user.call('POST', `/ledgers/${user.ledger.id}/categories/reorder`, body);
    expect(result.statusCode, result.body).toBe(200);
    const count = await prisma.syncChange.count({ where: { userId: user.user.user_id } });
    expect((await user.call('POST', `/ledgers/${user.ledger.id}/categories/reorder`, body)).statusCode).toBe(200);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id } })).toBe(count);
    const stale = await user.call('POST', `/ledgers/${user.ledger.id}/categories/reorder`, {
      items: [
        { ...body.items[0], sort_order: 4 },
        { ...body.items[1], sort_order: 5 },
      ],
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: first.id, ownerId: user.user.user_id } } }))
        .sortOrder,
    ).toBe(2);
  });

  it('父子分类跨所有者账本迁移，原始金额保留、交易版本增加、幂等重放', async () => {
    const user = await account();
    const other = await account();
    const root = await user.category('迁移源');
    const child = await user.category('迁移子', root.id);
    const target = await user.category('迁移目标');
    await other.category('别人的同ID', undefined, root.id);
    const foreignTransaction = await other.transaction(root.id);
    const first = await user.transaction(root.id);
    const secondLedger = (await user.call('POST', '/ledgers', { name: '另一本', currency: 'CNY' })).json<{
      id: string;
    }>();
    const second = await user.transaction(child.id, secondLedger.id);
    const scope = await user.preview([root.id]);
    expect(scope.transaction_count).toBe(2);
    const body = {
      category_ids: [root.id],
      mode: 'migrate',
      target_category_id: target.id,
      expected_target_updated_at: target.updated_at,
      preview_token: scope.preview_token,
    };
    const key = randomUUID();
    const response = await user.call('POST', `/ledgers/${user.ledger.id}/categories/remove`, body, key);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ removed_categories: 2, affected_transactions: 2 });
    const count = await prisma.syncChange.count({ where: { userId: user.user.user_id } });
    expect((await user.call('POST', `/ledgers/${user.ledger.id}/categories/remove`, body, key)).statusCode).toBe(200);
    expect(await prisma.syncChange.count({ where: { userId: user.user.user_id } })).toBe(count);
    for (const id of [first.id, second.id])
      expect(await prisma.transaction.findUniqueOrThrow({ where: { id } })).toMatchObject({
        categoryId: target.id,
        revision: 2,
        deletedAt: null,
      });
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: foreignTransaction.id } })).toMatchObject({
      categoryId: root.id,
      revision: 1,
      deletedAt: null,
    });
  });

  it('确认后新增关联交易导致409，分类和全部交易保持原样', async () => {
    const user = await account();
    const root = await user.category('并发源');
    const scope = await user.preview([root.id]);
    const transaction = await user.transaction(root.id);
    const response = await user.call(
      'POST',
      `/ledgers/${user.ledger.id}/categories/remove`,
      { category_ids: [root.id], mode: 'delete', preview_token: scope.preview_token },
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: root.id, ownerId: user.user.user_id } } }))
        .deletedAt,
    ).toBeNull();
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).deletedAt).toBeNull();
  });

  it('删除分类树只软删除测试交易，并通过同步日志传播', async () => {
    const user = await account();
    const root = await user.category('级联源');
    const child = await user.category('级联子', root.id);
    const transaction = await user.transaction(child.id);
    const scope = await user.preview([root.id]);
    const response = await user.call(
      'POST',
      `/ledgers/${user.ledger.id}/categories/remove`,
      { category_ids: [root.id], mode: 'delete', preview_token: scope.preview_token },
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ removed_categories: 2, affected_transactions: 1 });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).deletedAt).not.toBeNull();
    expect(
      await prisma.syncChange.count({
        where: { userId: user.user.user_id, entityType: 'transaction', entityId: transaction.id, action: 'delete' },
      }),
    ).toBe(1);
  });

  it('提升保留子分类及其交易，只删除父分类直接关联交易', async () => {
    const user = await account();
    const root = await user.category('提升源');
    const child = await user.category('提升子', root.id);
    const parentTransaction = await user.transaction(root.id);
    const childTransaction = await user.transaction(child.id);
    const scope = await user.preview([root.id]);
    const response = await user.call(
      'POST',
      `/ledgers/${user.ledger.id}/categories/remove`,
      { category_ids: [root.id], mode: 'promote', preview_token: scope.preview_token },
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ removed_categories: 1, promoted_categories: 1, affected_transactions: 1 });
    expect(
      await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: child.id, ownerId: user.user.user_id } } }),
    ).toMatchObject({ level: 1, parentId: null, deletedAt: null });
    expect(
      (await prisma.transaction.findUniqueOrThrow({ where: { id: parentTransaction.id } })).deletedAt,
    ).not.toBeNull();
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: childTransaction.id } })).deletedAt).toBeNull();
  });

  it('跨账号预览与写入拒绝，提升同名冲突在任何数据写入前回滚', async () => {
    const user = await account();
    const stranger = await account();
    const root = await user.category('冲突源');
    await user.category('同名', root.id);
    await user.category('同名');
    const scope = await user.preview([root.id]);
    const denied = await stranger.call('POST', `/ledgers/${user.ledger.id}/categories/removal-preview`, {
      category_ids: [root.id],
    });
    expect([403, 404]).toContain(denied.statusCode);
    const response = await user.call(
      'POST',
      `/ledgers/${user.ledger.id}/categories/remove`,
      { category_ids: [root.id], mode: 'promote', preview_token: scope.preview_token },
      randomUUID(),
    );
    expect(response.statusCode, response.body).toBe(409);
    expect(
      (await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: root.id, ownerId: user.user.user_id } } }))
        .deletedAt,
    ).toBeNull();
  });
});
