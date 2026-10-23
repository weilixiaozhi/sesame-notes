import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { exchangeRateOverrideId } from '../accounting/index.js';
import { applyRateOverride } from './catalog-projection.js';
import type { PushChange } from './sync-schemas.js';

const auth = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};

describe('汇率覆盖币种边界', () => {
  it.each(['upsert', 'delete'] as const)('同币种%s在数据库读写前返回可操作错误', async (action) => {
    try {
      const findUnique = vi.fn();
      const upsert = vi.fn();
      const tx = { exchangeRateOverride: { findUnique, upsert } } as unknown as Prisma.TransactionClient;
      const change: PushChange = {
        mutation_id: auth.deviceId,
        entity_type: 'exchange_rate_override',
        entity_id: exchangeRateOverrideId(auth.userId, 'CNY', 'CNY'),
        ledger_id: null,
        action,
        updated_at: '2026-10-22T00:00:00.000Z',
        payload: { base_currency: 'CNY', quote_currency: 'CNY', rate: '1' },
      };
      await expect(applyRateOverride(tx, auth, change, new Date(change.updated_at))).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_RATE_PAIR',
      });
      expect(findUnique).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('同币种汇率覆盖校验回归失败', { cause });
    }
  });
});
