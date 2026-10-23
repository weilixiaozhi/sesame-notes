import { Prisma, type PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { CategorySchema } from '../../shared/contracts/accounting.js';
import { CategoryConflictSchema, CategoryResolutionSchema } from '../../shared/contracts/category-conflicts.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { registerErrorHandler } from '../../shared/errors.js';
import { exchangeRateOverrideId } from '../accounting/index.js';
import { registerPushRoutes } from './push-routes.js';

const auth = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
vi.mock('../auth/index.js', () => ({
  authenticate: () => async () => {},
  requireScopes: () => async () => {},
  requireAuth: () => ({
    userId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  }),
  currentSessionAccess: async () => true,
}));

describe('同步原值业务错误边界', () => {
  it.each([0, 1, 2])('数字 AA 模式 %i 只拒绝本条变更，后续合法变更继续提交', async (aaMode) => {
    const app = Fastify({ logger: false });
    try {
      const now = new Date('2026-10-22T12:00:00.000Z');
      const ledgerId = '33333333-3333-4333-8333-333333333333';
      const syncId = '44444444-4444-4444-8444-444444444444';
      const invalidId = '55555555-5555-4555-8555-555555555555';
      const rateId = exchangeRateOverrideId(auth.userId, 'USD', 'CNY');
      const event = vi.fn().mockResolvedValue({ changeId: 42n });
      const create = vi.fn();
      const rate = vi.fn().mockResolvedValue({
        id: rateId,
        baseCurrency: 'USD',
        quoteCurrency: 'CNY',
        rate: new Prisma.Decimal('7'),
        updatedAt: now,
      });
      const tx = {
        $executeRaw: async () => 0,
        $queryRaw: async () => [{ id: ledgerId, ownerId: auth.userId }],
        ledger: {
          findUnique: async () => ({ id: ledgerId, ownerId: auth.userId, syncId, deletedAt: null, currency: 'CNY' }),
        },
        transaction: { findUnique: async () => null, create },
        syncChange: { findUnique: async () => null, create: event },
        mutationReservation: { findUnique: async () => null },
        exchangeRateOverride: { findUnique: async () => null, upsert: rate },
      };
      const prisma = {
        $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
        $queryRaw: async () => [{ cursor: 0n, completedAt: now }],
        syncChange: { findFirst: async () => ({ changeId: 42n }) },
      };
      for (const schema of [CategorySchema, CategoryConflictSchema, CategoryResolutionSchema, ErrorSchema])
        app.addSchema(schema);
      registerErrorHandler(app);
      registerPushRoutes(app, prisma as unknown as PrismaClient, { syncRetentionMinCursor: 0 } as ApiConfig);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sync/push',
        payload: {
          device_id: auth.deviceId,
          changes: [
            {
              mutation_id: invalidId,
              entity_type: 'transaction',
              entity_id: invalidId,
              ledger_id: ledgerId,
              sync_id: syncId,
              action: 'upsert',
              updated_at: now.toISOString(),
              payload: {
                tx_type: 'expense',
                amount: '1',
                native_amount: '1',
                currency_code: 'CNY',
                happened_at: now.toISOString(),
                note: null,
                category_id: null,
                recurring_id: null,
                aa_mode: aaMode,
                splits: null,
                last_edited_at: null,
              },
            },
            {
              mutation_id: '66666666-6666-4666-8666-666666666666',
              entity_type: 'exchange_rate_override',
              entity_id: rateId,
              ledger_id: null,
              action: 'upsert',
              updated_at: now.toISOString(),
              payload: { base_currency: 'USD', quote_currency: 'CNY', rate: '7' },
            },
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().outcomes).toMatchObject([
        { entity_id: invalidId, status: 'invalid', code: 'INVALID_AA_MODE' },
        { entity_id: rateId, status: 'accepted', change_id: '42' },
      ]);
      expect(create).not.toHaveBeenCalled();
      expect(rate).toHaveBeenCalledOnce();
      expect(event).toHaveBeenCalledOnce();
    } catch (cause) {
      throw new Error('同步 AA 模式原值错误隔离验证失败', { cause });
    } finally {
      await app.close();
    }
  });
});
