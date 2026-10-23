import type { Category, PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { CategorySchema } from '../../shared/contracts/accounting.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { registerCategoryRoutes } from './category-routes.js';

const hooks = vi.hoisted(() => ({
  transaction: vi.fn(),
  access: vi.fn(),
  session: vi.fn(),
  event: vi.fn(),
}));
vi.mock('../auth/index.js', () => ({
  authenticate: () => async () => {},
  requireScopes: () => async () => {},
  requireAuth: () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  }),
  currentSessionAccess: hooks.session,
}));
vi.mock('../../shared/sync-transaction.js', () => ({ withSyncTransaction: hooks.transaction }));
vi.mock('./domain/ledger-access.js', () => ({ getLedgerReadAccess: hooks.access, getLedgerWriteAccess: hooks.access }));
vi.mock('../sync-events/index.js', () => ({ createChange: hooks.event }));
vi.mock('./category-snapshot.js', () => ({ updateCategoryTransactionSnapshots: vi.fn() }));

it('自定义分类无版本令牌的明确编辑也推进快时钟版本，响应和事件可被其他设备应用', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T05:00:00.000Z'));
  const app = Fastify({ logger: false });
  try {
    const previous: Category = {
      id: '44444444-4444-4444-8444-444444444444',
      ownerId: '11111111-1111-4111-8111-111111111111',
      name: '自定义分类',
      kind: 'expense',
      level: 1,
      sortOrder: 0,
      parentId: null,
      icon: null,
      createdAt: new Date('2026-10-22T04:00:00.000Z'),
      updatedAt: new Date('2026-10-22T05:00:05.000Z'),
      updatedByDeviceId: '55555555-5555-4555-8555-555555555555',
      deletedAt: null,
    };
    let current = { ...previous };
    const tx = {
      category: {
        findFirst: async () => current,
        findMany: async () => [],
        update: async ({ data }: { data: Partial<Category> }) => (current = { ...current, ...data }),
      },
    };
    hooks.transaction.mockImplementation(async (_prisma, work: (client: typeof tx) => Promise<unknown>) => work(tx));
    hooks.access.mockResolvedValue({ ledger: { ownerId: previous.ownerId } });
    hooks.session.mockResolvedValue(true);
    hooks.event.mockClear();
    app.addSchema(CategorySchema);
    app.addSchema(ErrorSchema);
    registerCategoryRoutes(app, {} as PrismaClient, {} as ApiConfig);
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/ledgers/33333333-3333-4333-8333-333333333333/categories/${previous.id}`,
      payload: { name: '明确改名' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(current.updatedAt.getTime()).toBeGreaterThan(previous.updatedAt.getTime());
    expect(response.json()).toMatchObject({ name: '明确改名', updated_at: current.updatedAt.toISOString() });
    expect(hooks.event).toHaveBeenCalledOnce();
    expect(hooks.event.mock.calls[0]![6]).toMatchObject({
      name: '明确改名',
      updated_at: current.updatedAt.toISOString(),
    });
    expect(hooks.event.mock.calls[0]![7]).toEqual(current.updatedAt);
  } catch (cause) {
    throw new Error('自定义分类明确编辑的单调时间验证失败', { cause });
  } finally {
    await app.close();
    vi.useRealTimers();
  }
});

it('单删自定义分类推进快时钟版本，墓碑和事件时间保持一致', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-19T05:00:00.000Z'));
  const app = Fastify({ logger: false });
  try {
    const original: Category = {
      id: '44444444-4444-4444-8444-444444444444',
      ownerId: '11111111-1111-4111-8111-111111111111',
      name: '审查分类',
      kind: 'expense',
      level: 1,
      sortOrder: 0,
      parentId: null,
      icon: null,
      createdAt: new Date('2026-10-19T04:00:00.000Z'),
      updatedAt: new Date('2026-10-19T05:00:30.000Z'),
      updatedByDeviceId: '22222222-2222-4222-8222-222222222222',
      deletedAt: null,
    };
    let current = { ...original };
    const tx = {
      category: {
        findFirst: vi.fn(async (query: { where: { parentId?: string } }) => (query.where.parentId ? null : current)),
        update: vi.fn(async (query: { data: Partial<Category> }) => {
          current = { ...current, ...query.data };
          return current;
        }),
      },
      transaction: { findFirst: vi.fn(async () => null) },
    };
    hooks.transaction.mockImplementation(async (_prisma, work: (client: typeof tx) => Promise<unknown>) => work(tx));
    hooks.access.mockResolvedValue({ ledger: { ownerId: original.ownerId } });
    hooks.session.mockResolvedValue(true);
    app.addSchema(CategorySchema);
    app.addSchema(ErrorSchema);
    registerCategoryRoutes(app, {} as PrismaClient, {} as ApiConfig);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/ledgers/33333333-3333-4333-8333-333333333333/categories/${original.id}`,
    });
    expect(response.statusCode, response.body).toBe(204);
    expect(current.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
    expect(current.deletedAt).toEqual(current.updatedAt);
    expect(hooks.event).toHaveBeenCalledWith(
      tx,
      { userId: original.ownerId, deviceId: original.updatedByDeviceId },
      null,
      'category',
      original.id,
      'delete',
      expect.objectContaining({
        updated_at: current.updatedAt.toISOString(),
        deleted_at: current.updatedAt.toISOString(),
      }),
      current.updatedAt,
    );
  } catch (error) {
    console.error('分类墓碑时间回归失败', error);
    throw error;
  } finally {
    await app.close();
    vi.useRealTimers();
  }
});
