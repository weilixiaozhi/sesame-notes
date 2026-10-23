import type { Ledger, PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { LedgerSchema } from '../../shared/contracts/accounting.js';
import { registerErrorHandler } from '../../shared/errors.js';
import { registerLedgerCurrencyRoutes } from './ledger-currency-routes.js';
import { registerLedgerRoutes } from './ledger-routes.js';

const hooks = vi.hoisted(() => ({ transaction: vi.fn(), access: vi.fn(), event: vi.fn() }));
vi.mock('../auth/index.js', () => ({
  authenticate: () => async () => {},
  requireScopes: () => async () => {},
  requireAuth: () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  }),
  currentSessionAccess: async () => true,
}));
vi.mock('../../shared/sync-transaction.js', () => ({ withSyncTransaction: hooks.transaction }));
vi.mock('./domain/ledger-access.js', () => ({
  getLedgerWriteAccess: hooks.access,
  getLedgerReadAccess: hooks.access,
  accessibleLedgerWhere: vi.fn(),
  ledgerRoleOf: vi.fn(),
}));
vi.mock('../sync-events/index.js', () => ({ createChange: hooks.event }));
vi.mock('./ledger-action-preview.js', () => ({ ledgerActionPreview: async () => ({ fingerprint: 'a'.repeat(64) }) }));
vi.mock('../../shared/idempotency.js', () => ({
  findIdempotentReplay: async () => null,
  storeIdempotentResult: async () => {},
}));

const ledgerId = '33333333-3333-4333-8333-333333333333';
const syncId = '44444444-4444-4444-8444-444444444444';
const now = Date.parse('2026-10-22T12:00:00.000Z');
type Action = 'patch' | 'currency' | 'delete';

/** 运行真实账本路由并保存落库时间和事件时间；数据库与锁等待采用独立可观察替身。 */
async function verifyWrite(action: Action, versionOffset: number, lockWait = 0): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  hooks.event.mockReset();
  const app = Fastify({ logger: false });
  try {
    let ledger: Ledger = {
      id: ledgerId,
      syncId,
      ownerId: '11111111-1111-4111-8111-111111111111',
      name: '当前账本',
      currency: 'CNY',
      monthStartDay: 1,
      aaEnabled: false,
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now + versionOffset),
      updatedByDeviceId: '55555555-5555-4555-8555-555555555555',
      deletedAt: null,
    };
    const prior = ledger.updatedAt.getTime();
    const tx = {
      ledger: {
        update: vi.fn(async ({ data }: { data: Partial<Ledger> }) => (ledger = { ...ledger, ...data })),
      },
      ledgerMember: { count: async () => 1, findUnique: async () => null },
      ledgerInvite: { updateMany: async () => ({ count: 0 }) },
      transaction: { findMany: async () => [] },
    };
    hooks.access.mockImplementation(async () => {
      vi.setSystemTime(now + lockWait);
      return { ledger, role: 'owner' };
    });
    hooks.transaction.mockImplementation(async (_client, work: (client: typeof tx) => Promise<unknown>) => work(tx));
    app.addSchema(LedgerSchema);
    registerErrorHandler(app);
    registerLedgerRoutes(app, tx as unknown as PrismaClient, {} as ApiConfig);
    registerLedgerCurrencyRoutes(app, tx as unknown as PrismaClient, {} as ApiConfig);
    const response = await app.inject(
      action === 'patch'
        ? { method: 'PATCH', url: `/api/v1/ledgers/${ledgerId}`, payload: { name: '明确改名', aa_enabled: true } }
        : action === 'currency'
          ? {
              method: 'POST',
              url: `/api/v1/ledgers/${ledgerId}/change-currency`,
              headers: { 'idempotency-key': 'currency-change-test' },
              payload: { currency: 'USD', expected_currency: 'CNY', rates: {} },
            }
          : {
              method: 'DELETE',
              url: `/api/v1/ledgers/${ledgerId}?expected_sync_id=${syncId}&expected_fingerprint=${'a'.repeat(64)}`,
            },
    );
    expect(response.statusCode, response.body).toBe(action === 'delete' ? 204 : 200);
    expect(ledger.updatedAt.getTime()).toBeGreaterThan(prior);
    expect(ledger.updatedAt.getTime()).toBeGreaterThanOrEqual(now + lockWait);
    expect(hooks.event).toHaveBeenCalledOnce();
    expect(hooks.event.mock.calls[0]![7]).toEqual(ledger.updatedAt);
    if (action === 'delete') {
      expect(ledger.deletedAt).toEqual(ledger.updatedAt);
      expect(hooks.event.mock.calls[0]![6]).toMatchObject({
        owner_id: ledger.ownerId,
        deleted_at: ledger.deletedAt!.toISOString(),
      });
    } else {
      const result = action === 'currency' ? response.json().ledger : response.json();
      expect(result.updated_at).toBe(ledger.updatedAt.toISOString());
      expect(hooks.event.mock.calls[0]![6]).toMatchObject({ name: ledger.name, currency: ledger.currency });
    }
  } catch (cause) {
    throw new Error(`账本 ${action} 写入版本回归失败`, { cause });
  } finally {
    await app.close();
    vi.useRealTimers();
  }
}

describe('账本 REST 元数据版本', () => {
  it.each(['patch', 'currency', 'delete'] as const)('%s 使用严格晚于设备超前版本的时间', async (action) => {
    await verifyWrite(action, 5000);
  });

  it.each(['patch', 'currency', 'delete'] as const)('%s 等锁后取时，同毫秒的当前版本也严格前进', async (action) => {
    await verifyWrite(action, 10000, 10000);
  });
});
