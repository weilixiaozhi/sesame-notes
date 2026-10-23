import { describe, expect, it, vi } from 'vitest';
import { applyChange } from '../src/modules/sync/testing.js';
import type { SyncTransaction } from '../src/shared/sync-transaction.js';

describe('同步错误响应的权限边界', () => {
  it('非成员不得从同步标识不匹配响应中取得他人账本状态', async () => {
    const tx = {
      syncChange: { findUnique: vi.fn().mockResolvedValue(null) },
      ledger: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'ledger', ownerId: 'owner', syncId: 'private-sync', deletedAt: null }),
      },
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'ledger', ownerId: 'owner' }])
        .mockResolvedValueOnce([]),
    };
    await expect(
      applyChange(
        tx as unknown as SyncTransaction,
        { userId: 'outsider', deviceId: 'device' },
        {
          mutation_id: 'mutation',
          entity_type: 'ledger',
          entity_id: 'ledger',
          ledger_id: 'ledger',
          action: 'upsert',
          updated_at: new Date().toISOString(),
          sync_id: 'wrong',
          payload: {},
        },
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'LEDGER_NOT_FOUND', statusCode: 404 });
  });
});
