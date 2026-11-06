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
});

describe('默认分类身份跨账号派生', () => {
  it.each(['rest-update', 'push-delete'] as const)('%s 仅修改分类所属账号的交易与失效事件', async (operation) => {
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
  });
});
