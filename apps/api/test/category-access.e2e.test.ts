import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('category-access'),
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
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return {
    status: response.statusCode,
    json: (): unknown => (response.body ? JSON.parse(response.body) : null),
  };
}

function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

async function registerUser(): Promise<{ token: string; deviceId: string; userId: string }> {
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone: uniquePhone(),
    password: 'password-123456',
    device: { installation_id: uuid(), name: 'e2e-device', platform: 'e2e' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as { access_token: string; device_id: string; user: { user_id: string } };
  return { token: session.access_token, deviceId: session.device_id, userId: session.user.user_id };
}

/** 通过公开接口建立 Owner 与 Editor 共享账本，供导入权限验证使用。 */
async function createSharedLedger() {
  try {
    const owner = await registerUser();
    const editor = await registerUser();
    const ledgerId = uuid();
    expect(
      (await api('post', '/ledgers', { id: ledgerId, name: '导入权限账本', currency: 'CNY' }, owner.token)).status,
    ).toBe(201);
    const invite = await api('post', `/ledgers/${ledgerId}/invites`, {}, owner.token);
    expect(invite.status).toBe(201);
    const { code } = invite.json() as { code: string };
    expect((await api('post', `/invites/${code}/accept`, {}, editor.token)).status).toBe(200);
    return { owner, editor, ledgerId };
  } catch (error) {
    console.error('导入权限测试账本初始化失败', error);
    throw error;
  }
}

const importedTransaction = {
  tx_type: 'expense',
  amount: '10',
  happened_at: '2026-09-06T00:00:00.000Z',
  currency_code: 'CNY',
  native_amount: '10',
};

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('分类增删与成员权限', () => {
  it('唯一共享账本删除后，原成员不能读取所有者新建分类及其墓碑', async () => {
    try {
      const { owner, editor, ledgerId } = await createSharedLedger();
      expect((await api('delete', `/ledgers/${ledgerId}`, undefined, owner.token)).status).toBe(204);
      const privateLedgerId = uuid();
      expect((await api('post', '/ledgers', { id: privateLedgerId, name: '私人账本' }, owner.token)).status).toBe(201);
      const categoryId = uuid();
      expect(
        (
          await api(
            'post',
            `/ledgers/${privateLedgerId}/categories`,
            {
              id: categoryId,
              name: '私有分类内容',
              kind: 'expense',
              level: 1,
            },
            owner.token,
          )
        ).status,
      ).toBe(201);
      const pull = await api('get', '/sync/pull', undefined, editor.token);
      expect(pull.status).toBe(200);
      expect(JSON.stringify(pull.json())).not.toContain(categoryId);
      expect(
        (await api('delete', `/ledgers/${privateLedgerId}/categories/${categoryId}`, undefined, owner.token)).status,
      ).toBe(204);
      const full = await api('get', '/sync/accounting/full', undefined, editor.token);
      expect(full.status).toBe(200);
      expect(JSON.stringify(full.json())).not.toContain(categoryId);
    } catch (error) {
      throw new Error('已删除账本的跨账号分类权限验证失败', { cause: error });
    }
  });
  it('owner 创建/删除分类（含客户端 v5 id），editor 只读且增删改均被拒', async () => {
    const owner = await registerUser();
    const ledgerId = uuid();
    expect(
      (await api('post', '/ledgers', { id: ledgerId, name: '权限账本', currency: 'CNY' }, owner.token)).status,
    ).toBe(201);

    const defaults = await prisma.category.findMany({ where: { ownerId: owner.userId }, orderBy: { id: 'asc' } });
    expect(defaults).toHaveLength(61);
    expect(defaults.filter((category) => category.level === 1)).toHaveLength(20);
    expect(defaults.filter((category) => category.level === 2)).toHaveLength(41);
    const defaultIds = new Set(defaults.map((category) => category.id));

    // owner 创建 v4 分类与 v5 分类（确定性派生 id 客户端提供）
    const v4Id = uuid();
    const v5Id = uuid().replace(/^([0-9a-f]{8}-[0-9a-f]{4}-)4/, '$15');
    expect(
      (
        await api(
          'post',
          `/ledgers/${ledgerId}/categories`,
          { id: v4Id, name: '自定义餐饮', kind: 'expense', level: 1 },
          owner.token,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await api(
          'post',
          `/ledgers/${ledgerId}/categories`,
          { id: v5Id, name: '自定义交通', kind: 'expense', level: 1 },
          owner.token,
        )
      ).status,
    ).toBe(201);

    // 第二账号 → 邀请 → 接受成为 editor
    const editor = await registerUser();
    const invite = await api('post', `/ledgers/${ledgerId}/invites`, {}, owner.token);
    expect(invite.status).toBe(201);
    const code = (invite.json() as { code: string }).code;
    expect((await api('post', `/invites/${code}/accept`, {}, editor.token)).status).toBe(200);

    const beforeDenied = await prisma.category.findMany({ where: { ownerId: owner.userId }, orderBy: { id: 'asc' } });
    expect(beforeDenied).toHaveLength(63);
    expect(beforeDenied.filter((category) => defaultIds.has(category.id))).toEqual(defaults);
    const eventCount = await prisma.syncChange.count({ where: { userId: owner.userId, entityType: 'category' } });
    const ownerList = await api('get', `/ledgers/${ledgerId}/categories`, undefined, owner.token);
    expect(ownerList.status).toBe(200);

    // editor 可读 owner 的分类集合
    const list = await api('get', `/ledgers/${ledgerId}/categories`, undefined, editor.token);
    expect(list.status).toBe(200);
    expect(list.json()).toEqual(ownerList.json());
    expect((list.json() as Array<{ id: string }>).map((category) => category.id).sort()).toEqual(
      [...defaultIds, v4Id, v5Id].sort(),
    );

    // editor 增/改/删分类一律 403
    expect(
      (
        await api(
          'post',
          `/ledgers/${ledgerId}/categories`,
          { id: uuid(), name: '越权分类', kind: 'expense', level: 1 },
          editor.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (await api('patch', `/ledgers/${ledgerId}/categories/${v4Id}`, { name: '越权改名' }, editor.token)).status,
    ).toBe(403);
    expect((await api('delete', `/ledgers/${ledgerId}/categories/${v4Id}`, undefined, editor.token)).status).toBe(403);

    expect(await prisma.category.findMany({ where: { ownerId: owner.userId }, orderBy: { id: 'asc' } })).toEqual(
      beforeDenied,
    );
    expect(await prisma.syncChange.count({ where: { userId: owner.userId, entityType: 'category' } })).toBe(eventCount);

    // owner 删除 v5 分类：REST tombstone，行保留
    expect((await api('delete', `/ledgers/${ledgerId}/categories/${v5Id}`, undefined, owner.token)).status).toBe(204);
    const row = await prisma.category.findFirst({
      where: { id: v5Id, ownerId: owner.userId },
    });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    const remaining = await api('get', `/ledgers/${ledgerId}/categories`, undefined, editor.token);
    expect(remaining.status).toBe(200);
    expect((remaining.json() as Array<{ id: string }>).map((category) => category.id).sort()).toEqual(
      [...defaultIds, v4Id].sort(),
    );
    expect(
      (await prisma.category.findMany({ where: { ownerId: owner.userId }, orderBy: { id: 'asc' } })).filter(
        (category) => defaultIds.has(category.id),
      ),
    ).toEqual(defaults);
  });
});

describe('批量导入资源权限', () => {
  it('Editor 混合导入分类与交易返回 403，分类、交易、分摊、事件及幂等记录均零写入', async () => {
    const { editor, ledgerId } = await createSharedLedger();
    const categoryId = uuid();
    const transactionId = uuid();
    const idempotencyKey = uuid();
    const member = await prisma.ledgerMember.findUniqueOrThrow({
      where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: editor.userId } },
    });
    const response = await app.inject({
      method: 'post',
      url: await accountingRequestFixturePath(app, 'POST', `${API_BASE}/ledgers/${ledgerId}/imports`, {
        authorization: `Bearer ${editor.token}`,
      }),
      headers: { authorization: `Bearer ${editor.token}`, 'idempotency-key': idempotencyKey },
      payload: {
        categories: [{ id: categoryId, name: '餐饮', kind: 'expense', level: 1 }],
        transactions: [
          {
            ...importedTransaction,
            id: transactionId,
            category_id: categoryId,
            aa_mode: '2',
            splits: [{ member_id: member.id, amount: '10' }],
          },
        ],
      },
    });

    expect.soft(response.statusCode).toBe(403);
    expect.soft(response.json()).toMatchObject({ code: 'LEDGER_PERMISSION_DENIED', message: '你没有执行此操作的权限' });
    // 拒绝整批请求时，所有持久化副作用都必须为空，不能只检查 HTTP 状态。
    expect(await prisma.category.count({ where: { id: categoryId } })).toBe(0);
    expect(await prisma.transaction.count({ where: { id: transactionId } })).toBe(0);
    expect(await prisma.transactionSplit.count({ where: { transactionId } })).toBe(0);
    expect(await prisma.syncChange.count({ where: { entityId: { in: [categoryId, transactionId] } } })).toBe(0);
    expect(await prisma.idempotencyKey.count({ where: { userId: editor.userId, key: idempotencyKey } })).toBe(0);
  });

  it('Owner 混合导入成功，分类事件属于 Owner 用户域且 Owner 与共享成员可同步读取', async () => {
    const { owner, editor, ledgerId } = await createSharedLedger();
    const categoryId = uuid();
    const transactionId = uuid();
    const response = await api(
      'post',
      `/ledgers/${ledgerId}/imports`,
      {
        categories: [{ id: categoryId, name: '权限导入分类', kind: 'expense', level: 1 }],
        transactions: [{ ...importedTransaction, id: transactionId, category_id: categoryId }],
      },
      owner.token,
    );

    expect(response.status).toBe(201);
    expect(response.json()).toEqual({ imported_categories: 1, imported_transactions: 1 });
    expect(await prisma.category.findFirst({ where: { id: categoryId, ownerId: owner.userId } })).toMatchObject({
      ownerId: owner.userId,
    });
    const categoryEvents = await prisma.syncChange.findMany({ where: { entityId: categoryId } });
    expect(categoryEvents).toHaveLength(1);
    expect(categoryEvents[0]).toMatchObject({
      userId: owner.userId,
      deviceId: owner.deviceId,
      ledgerId: null,
      scope: 'user',
      entityType: 'category',
    });
    for (const account of [owner, editor]) {
      const pull = await app.inject({
        method: 'GET',
        url: '/api/v1/sync/pull?since=0',
        headers: {
          authorization: `Bearer ${account.token}`,
        },
      });
      expect(pull.statusCode).toBe(200);
      const { changes } = pull.json<{ changes: Array<{ entity_id: string }> }>();
      expect(changes.some((change) => change.entity_id === categoryId)).toBe(true);
      expect(changes.some((change) => change.entity_id === transactionId)).toBe(true);
    }
  });

  it.each([{ categories: undefined }, { categories: [] }])(
    'Editor 纯交易导入合法，categories=$categories',
    async ({ categories }) => {
      const { owner, editor, ledgerId } = await createSharedLedger();
      const transactionId = uuid();
      const response = await api(
        'post',
        `/ledgers/${ledgerId}/imports`,
        { categories, transactions: [{ ...importedTransaction, id: transactionId }] },
        editor.token,
      );

      expect(response.status).toBe(201);
      expect(response.json()).toEqual({ imported_categories: 0, imported_transactions: 1 });
      expect(await prisma.transaction.findUnique({ where: { id: transactionId } })).toMatchObject({
        ledgerId,
        ownerId: owner.userId,
      });
      expect(await prisma.syncChange.findMany({ where: { entityId: transactionId } })).toMatchObject([
        { userId: editor.userId, ledgerId, scope: 'ledger', entityType: 'transaction' },
      ]);
    },
  );
});

describe('默认分类身份跨账号派生', () => {
  it.each(['rest-update', 'rest-delete', 'push-update', 'push-delete'] as const)(
    '%s 仅修改分类所属账号的交易与失效事件',
    async (operation) => {
      try {
        const categoryId = uuid();
        const accounts = [];
        for (const name of ['甲', '乙']) {
          const session = await registerUser();
          const ledgerId = uuid();
          expect((await api('post', '/ledgers', { id: ledgerId, name, currency: 'CNY' }, session.token)).status).toBe(
            201,
          );
          expect(
            (
              await api(
                'post',
                `/ledgers/${ledgerId}/categories`,
                {
                  id: categoryId,
                  name,
                  kind: 'expense',
                  level: 1,
                },
                session.token,
              )
            ).status,
          ).toBe(201);
          const transactionId = uuid();
          expect(
            (
              await api(
                'post',
                `/ledgers/${ledgerId}/transactions`,
                {
                  ...importedTransaction,
                  id: transactionId,
                  category_id: categoryId,
                },
                session.token,
              )
            ).status,
          ).toBe(201);
          accounts.push({ ...session, ledgerId, transactionId });
        }
        const [first, second] = accounts;
        const before = await prisma.transaction.findUniqueOrThrow({ where: { id: second!.transactionId } });
        const deleting = operation.endsWith('delete');
        if (deleting) {
          const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: first!.transactionId } });
          expect(
            (
              await api(
                'delete',
                `/ledgers/${first!.ledgerId}/transactions/${first!.transactionId}`,
                {
                  base_revision: transaction.revision,
                },
                first!.token,
              )
            ).status,
          ).toBe(204);
        }
        if (operation.startsWith('rest')) {
          expect(
            (
              await api(
                deleting ? 'delete' : 'patch',
                `/ledgers/${first!.ledgerId}/categories/${categoryId}`,
                deleting ? undefined : { name: '甲的新名称' },
                first!.token,
              )
            ).status,
          ).toBe(deleting ? 204 : 200);
        } else {
          const response = await api(
            'post',
            '/sync/push',
            {
              device_id: first!.deviceId,
              changes: [
                {
                  mutation_id: uuid(),
                  entity_type: 'category',
                  entity_id: categoryId,
                  ledger_id: null,
                  action: deleting ? 'delete' : 'upsert',
                  updated_at: new Date(Date.now() + 1000).toISOString(),
                  payload: deleting
                    ? {}
                    : { name: '甲的新名称', kind: 'expense', level: 1, sort_order: 0, icon: null, parent_id: null },
                },
              ],
            },
            first!.token,
          );
          expect(response.status).toBe(200);
          expect(response.json()).toMatchObject({ outcomes: [{ status: 'accepted' }] });
        }
        // 完整行比较覆盖分类引用、展示快照与更新时间，防止跨账号旁路写入。
        expect(await prisma.transaction.findUnique({ where: { id: second!.transactionId } })).toEqual(before);
        expect(
          await prisma.category.findUnique({ where: { id_ownerId: { id: categoryId, ownerId: second!.userId } } }),
        ).toMatchObject({ name: '乙', deletedAt: null });
        expect(await prisma.transaction.findUnique({ where: { id: first!.transactionId } })).toMatchObject({
          categoryId: deleting ? null : categoryId,
          categoryName: deleting ? null : '甲的新名称',
        });
        expect(await prisma.syncChange.count({ where: { userId: first!.userId, ledgerId: second!.ledgerId } })).toBe(0);
        expect(
          await prisma.syncChange.findFirst({
            where: {
              userId: first!.userId,
              ledgerId: first!.ledgerId,
              entityType: 'ledger',
              payload: { path: ['requires_full'], equals: true },
            },
          }),
        ).not.toBeNull();
      } catch (error) {
        throw new Error(`分类跨账号隔离验证失败：${operation}`, { cause: error });
      }
    },
  );

  /// 客户端默认分类 id 由固定模板确定性派生：任何账号派出的都是同一批 id，
  /// 因此两个账号必须各自持有同一 id 的分类，引用它的交易才可能上云。
  const parentId = 'ffec6471-df8b-5bb3-8a05-93ef863ca958';
  const childId = '02d2cbc5-0298-5dea-ae85-f4616e0eafc2';

  /** 完整官方内容作为重复种子上传，两个账号各自确认自己的既有分类身份。 */
  async function pushDefaultCategories(session: { token: string; deviceId: string }) {
    return api(
      'post',
      '/sync/push',
      {
        device_id: session.deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: parentId,
            ledger_id: null,
            action: 'upsert',
            updated_at: '2026-09-07T00:00:00.000Z',
            payload: { name: '餐饮', kind: 'expense', level: 1, sort_order: 0, icon: 'utensils', parent_id: null },
          },
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: childId,
            ledger_id: null,
            action: 'upsert',
            updated_at: '2026-09-07T00:00:01.000Z',
            payload: { name: '早餐', kind: 'expense', level: 2, sort_order: 0, icon: 'sandwich', parent_id: parentId },
          },
        ],
      },
      session.token,
    );
  }

  it('两个账号独立确认同一批默认分类，持基线编辑互不污染且交易引用可上云', async () => {
    const first = await registerUser();
    const second = await registerUser();
    const secondBefore = await prisma.category.findMany({ where: { ownerId: second.userId }, orderBy: { id: 'asc' } });

    const firstPush = await pushDefaultCategories(first);
    expect(firstPush.status).toBe(200);
    const firstResult = firstPush.json() as {
      outcomes: Array<{ status: string; category_state: { owner_id: string; version_token: string } }>;
    };
    expect(firstResult.outcomes.map((o) => o.status)).toEqual(['accepted', 'accepted']);
    expect(firstResult.outcomes.every((o) => o.category_state.owner_id === first.userId)).toBe(true);

    // 同一默认 UUID 在第二个账号内也有独立身份，重复种子不会覆盖或重复创建。
    const secondPush = await pushDefaultCategories(second);
    expect(secondPush.status).toBe(200);
    expect((secondPush.json() as { outcomes: Array<{ status: string }> }).outcomes.map((o) => o.status)).toEqual([
      'accepted',
      'accepted',
    ]);
    for (const session of [first, second]) {
      expect(await prisma.category.count({ where: { ownerId: session.userId } })).toBe(61);
      expect(
        await prisma.category.findUnique({ where: { id_ownerId: { id: childId, ownerId: session.userId } } }),
      ).toMatchObject({ name: '早餐', icon: 'sandwich', level: 2, parentId });
    }

    const changed = await api(
      'post',
      '/sync/push',
      {
        device_id: first.deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'category',
            entity_id: parentId,
            ledger_id: null,
            action: 'upsert',
            updated_at: new Date().toISOString(),
            payload: {
              name: '甲的餐饮',
              kind: 'expense',
              level: 1,
              sort_order: 0,
              icon: 'utensils',
              parent_id: null,
              base_token: firstResult.outcomes[0]!.category_state.version_token,
            },
          },
        ],
      },
      first.token,
    );
    expect(changed.status).toBe(200);
    expect(changed.json()).toMatchObject({ outcomes: [{ status: 'accepted' }] });
    expect(
      await prisma.category.findUnique({ where: { id_ownerId: { id: parentId, ownerId: first.userId } } }),
    ).toMatchObject({ name: '甲的餐饮', icon: 'utensils' });
    expect(await prisma.category.findMany({ where: { ownerId: second.userId }, orderBy: { id: 'asc' } })).toEqual(
      secondBefore,
    );

    // 第二账号的账本和交易始终引用自己的早餐分类。
    const ledgerId = uuid();
    const ledgerPush = await api(
      'post',
      '/sync/push',
      {
        device_id: second.deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'ledger',
            entity_id: ledgerId,
            ledger_id: ledgerId,
            action: 'upsert',
            updated_at: '2026-09-07T01:00:00.000Z',
            payload: { name: '默认账本', currency: 'CNY', month_start_day: 1, aa_enabled: false },
          },
        ],
      },
      second.token,
    );
    expect(ledgerPush.status).toBe(200);
    const ledgerOutcome = (ledgerPush.json() as { outcomes: Array<{ status: string; sync_id?: string }> }).outcomes[0]!;
    expect(ledgerOutcome.status).toBe('accepted');

    const transactionId = uuid();
    const transactionPush = await api(
      'post',
      '/sync/push',
      {
        device_id: second.deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'transaction',
            entity_id: transactionId,
            ledger_id: ledgerId,
            sync_id: ledgerOutcome.sync_id,
            action: 'upsert',
            updated_at: '2026-09-07T02:00:00.000Z',
            payload: {
              tx_type: 'expense',
              amount: '12.5',
              happened_at: '2026-09-07T02:00:00.000Z',
              note: 'CSV 导入行',
              category_id: childId,
              currency_code: 'CNY',
              native_amount: '12.5',
              recurring_id: null,
              payer_member_id: null,
              aa_mode: null,
              splits: [],
              last_edited_at: null,
            },
          },
        ],
      },
      second.token,
    );
    expect(transactionPush.status).toBe(200);
    expect((transactionPush.json() as { outcomes: Array<{ status: string }> }).outcomes[0]!.status).toBe('accepted');
    expect(await prisma.transaction.findFirst({ where: { id: transactionId, ownerId: second.userId } })).toMatchObject({
      categoryId: childId,
    });
  });
});
