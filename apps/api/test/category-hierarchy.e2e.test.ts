import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

const config: ApiConfig = {
  databaseUrl: testFixtureDatabaseUrl(),
  jwtSecret: 'category-hierarchy-test-secret-at-least-32-bytes',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: resolve('../../Temp/category-hierarchy'),
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

type Owner = { token: string; deviceId: string; userId: string; ledgerId: string };
type Transport = 'REST' | 'sync';

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
  app = buildApp({ logger: false, config, prisma });
  try {
    await app.ready();
  } catch (cause) {
    await app.close();
    throw new Error('分类层级测试服务初始化失败', { cause });
  }
});

afterAll(async () => {
  try {
    await app.close();
  } catch (cause) {
    throw new Error('分类层级测试服务关闭失败', { cause });
  }
});

/** 通过公开接口发送请求，失败时附带入口上下文而不记录凭证或载荷。 */
async function api(method: 'post' | 'patch' | 'delete', path: string, token?: string, body?: Record<string, unknown>) {
  try {
    return await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body,
    });
  } catch (cause) {
    throw new Error(`分类层级测试请求失败：${method} ${path}`, { cause });
  }
}

/** 为每个场景建立独立账号和账本，避免随机执行顺序影响分类状态。 */
async function createOwner(): Promise<Owner> {
  try {
    const registration = await api('post', '/auth/register', undefined, {
      country_code: '+86',
      phone: `138${randomInt(100_000_000).toString().padStart(8, '0')}`,
      password: 'category-hierarchy-password',
      device: { installation_id: randomUUID(), name: '分类层级测试', platform: 'test' },
    });
    expect(registration.statusCode).toBe(201);
    const session = registration.json<{ access_token: string; device_id: string; user: { user_id: string } }>();
    const ledgerId = randomUUID();
    const ledger = await api('post', '/ledgers', session.access_token, { id: ledgerId, name: '分类层级账本' });
    expect(ledger.statusCode).toBe(201);
    return { token: session.access_token, deviceId: session.device_id, userId: session.user.user_id, ledgerId };
  } catch (cause) {
    throw new Error('分类层级测试账号与账本创建失败', { cause });
  }
}

/** 提供 REST 与同步写入共用的完整分类内容。 */
function categoryPayload(level: 1 | 2, parentId: string | null) {
  return { name: '分类内容', kind: 'expense', level, parent_id: parentId, sort_order: 0, icon: null };
}

/** 经 REST 创建合法分类，作为树结构变更前的基线。 */
async function createCategory(owner: Owner, id: string, parentId: string | null = null): Promise<void> {
  try {
    const response = await api('post', `/ledgers/${owner.ledgerId}/categories`, owner.token, {
      id,
      ...categoryPayload(parentId === null ? 1 : 2, parentId),
      name: `分类${id}`,
    });
    expect(response.statusCode).toBe(201);
  } catch (cause) {
    throw new Error('分类层级测试基线创建失败', { cause });
  }
}

/** 经指定业务入口变更分类；同步时间严格晚于当前版本，保证实际进入层级校验。 */
async function moveCategory(owner: Owner, transport: Transport, id: string, parentId: string) {
  try {
    const payload = { ...categoryPayload(2, parentId), name: '更新后的分类内容' };
    if (transport === 'REST') {
      return await api('patch', `/ledgers/${owner.ledgerId}/categories/${id}`, owner.token, payload);
    }
    const current = await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id, ownerId: owner.userId } } });
    return await api('post', '/sync/push', owner.token, {
      device_id: owner.deviceId,
      changes: [
        {
          mutation_id: randomUUID(),
          entity_type: 'category',
          entity_id: id,
          ledger_id: null,
          action: 'upsert',
          updated_at: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)).toISOString(),
          payload,
        },
      ],
    });
  } catch (cause) {
    throw new Error(`${transport} 分类层级变更请求失败`, { cause });
  }
}

/** 同时读取分类、交易展示快照与同步事件，验证拒绝写入时没有任何持久化副作用。 */
async function captureState(owner: Owner) {
  try {
    const [categories, transactions, changes] = await Promise.all([
      prisma.category.findMany({ where: { ownerId: owner.userId }, orderBy: { id: 'asc' } }),
      prisma.transaction.findMany({ where: { ownerId: owner.userId }, orderBy: { id: 'asc' } }),
      prisma.syncChange.findMany({ where: { userId: owner.userId }, orderBy: { changeId: 'asc' } }),
    ]);
    return { categories, transactions, changes };
  } catch (cause) {
    throw new Error('分类层级测试状态读取失败', { cause });
  }
}

/** 检查两个入口各自的失败协议，避免把同步批次成功误当作分类写入成功。 */
function expectRejected(
  response: Awaited<ReturnType<typeof api>>,
  transport: Transport,
  code: string,
  message: string,
) {
  if (transport === 'REST') {
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code, message });
  } else {
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcomes: [{ status: 'invalid', change_id: null, code, message }] });
  }
}

/** 检查更新确实被应用，同步返回 ignored 也不能满足合法迁移的预期。 */
function expectAccepted(response: Awaited<ReturnType<typeof api>>, transport: Transport): void {
  expect(response.statusCode).toBe(200);
  if (transport === 'sync') expect(response.json()).toMatchObject({ outcomes: [{ status: 'accepted' }] });
}

describe('分类两级树与账号归属', () => {
  it.each(['REST', 'sync'] as const)(
    '%s 拒绝将含有效子分类的一级节点改为二级，状态与事件保持不变',
    async (transport) => {
      try {
        const owner = await createOwner();
        const parentId = randomUUID();
        const targetId = randomUUID();
        await createCategory(owner, parentId);
        await createCategory(owner, targetId);
        await createCategory(owner, randomUUID(), parentId);
        const transaction = await api('post', `/ledgers/${owner.ledgerId}/transactions`, owner.token, {
          id: randomUUID(),
          tx_type: 'expense',
          amount: '10',
          currency_code: 'CNY',
          native_amount: '10',
          happened_at: '2026-09-01T00:00:00.000Z',
          category_id: parentId,
        });
        expect(transaction.statusCode).toBe(201);
        const before = await captureState(owner);

        const response = await moveCategory(owner, transport, parentId, targetId);

        expectRejected(response, transport, 'CATEGORY_HAS_CHILDREN', '分类包含子分类，不能改为二级分类');
        expect(await captureState(owner)).toEqual(before);
      } catch (cause) {
        throw new Error(`${transport} 含子分类节点降级保护验证失败`, { cause });
      }
    },
  );

  it.each(['REST', 'sync'] as const)('%s 拒绝分类以自身为父节点，状态与事件保持不变', async (transport) => {
    try {
      const owner = await createOwner();
      const categoryId = randomUUID();
      await createCategory(owner, categoryId);
      const before = await captureState(owner);

      const response = await moveCategory(owner, transport, categoryId, categoryId);

      expectRejected(response, transport, 'CATEGORY_CYCLE', '分类不能以自身为父分类');
      expect(await captureState(owner)).toEqual(before);
    } catch (cause) {
      throw new Error(`${transport} 分类自引用保护验证失败`, { cause });
    }
  });

  it.each(['REST', 'sync'] as const)('%s 拒绝引用其他账号的父分类', async (transport) => {
    try {
      const owner = await createOwner();
      const other = await createOwner();
      const categoryId = randomUUID();
      const foreignParentId = randomUUID();
      await createCategory(owner, categoryId);
      await createCategory(other, foreignParentId);
      const before = await captureState(owner);
      const otherBefore = await captureState(other);

      const response = await moveCategory(owner, transport, categoryId, foreignParentId);

      expectRejected(response, transport, 'CATEGORY_PARENT_UNAVAILABLE', '父分类不存在或不可用');
      expect(await captureState(owner)).toEqual(before);
      expect(await captureState(other)).toEqual(otherBefore);
    } catch (cause) {
      throw new Error(`${transport} 分类父节点账号隔离验证失败`, { cause });
    }
  });

  it.each(['REST', 'sync'] as const)(
    '%s 允许叶子降级和二级换父，忽略已删除子分类与其他账号同 ID 的子分类',
    async (transport) => {
      try {
        const owner = await createOwner();
        const other = await createOwner();
        const categoryId = randomUUID();
        const firstParentId = randomUUID();
        const secondParentId = randomUUID();
        const deletedChildId = randomUUID();
        await createCategory(owner, categoryId);
        await createCategory(owner, firstParentId);
        await createCategory(owner, secondParentId);
        await createCategory(owner, deletedChildId, categoryId);
        const removed = await api('delete', `/ledgers/${owner.ledgerId}/categories/${deletedChildId}`, owner.token);
        expect(removed.statusCode).toBe(204);
        // 相同分类 ID 属于两个不同账号；另一账号的有效子节点不能阻止当前账号移动叶子。
        await createCategory(other, categoryId);
        await createCategory(other, randomUUID(), categoryId);
        const otherBefore = await captureState(other);
        const before = await captureState(owner);

        expectAccepted(await moveCategory(owner, transport, categoryId, firstParentId), transport);
        expectAccepted(await moveCategory(owner, transport, categoryId, secondParentId), transport);

        expect(
          await prisma.category.findUniqueOrThrow({ where: { id_ownerId: { id: categoryId, ownerId: owner.userId } } }),
        ).toMatchObject({ level: 2, parentId: secondParentId, deletedAt: null });
        const after = await captureState(owner);
        expect(after.changes).toHaveLength(before.changes.length + 2);
        expect(await captureState(other)).toEqual(otherBefore);
      } catch (cause) {
        throw new Error(`${transport} 合法分类迁移与子节点归属验证失败`, { cause });
      }
    },
  );
});
