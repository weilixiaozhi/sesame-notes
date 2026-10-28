import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { mapTransaction } from '../accounting/index.js';
import type { PushChange } from './sync-schemas.js';
import { applyTransaction } from './transaction-projection.js';

const auth = {
  userId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
const ledgerId = '33333333-3333-4333-8333-333333333333';
const transactionId = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-10-28T00:00:00.000Z');

/** 构造合法交易请求，让用例直接验证领域结果到同步回执的转换。 */
function transactionChange(baseRevision?: number): PushChange {
  return {
    mutation_id: '55555555-5555-4555-8555-555555555555',
    entity_type: 'transaction',
    entity_id: transactionId,
    ledger_id: ledgerId,
    action: 'upsert',
    updated_at: now.toISOString(),
    ...(baseRevision === undefined ? {} : { base_revision: baseRevision }),
    payload: {
      tx_type: 'expense',
      amount: '10',
      native_amount: '10',
      currency_code: 'CNY',
      happened_at: now.toISOString(),
      aa_mode: '0',
      splits: null,
    },
  };
}

/** 只替换数据库边界，保留权限、交易状态机和响应映射的真实执行。 */
function fixture() {
  const transaction = {
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: ledgerId, ownerId: auth.userId }]),
    ledger: { findUnique: vi.fn().mockResolvedValue({ id: ledgerId, ownerId: auth.userId, currency: 'CNY' }) },
    transaction,
    transactionEditHistory: { create: vi.fn() },
    syncChange: { create: vi.fn() },
  };
  return {
    tx: tx as unknown as SyncTransaction,
    transaction,
    history: tx.transactionEditHistory,
    events: tx.syncChange,
  };
}

/** 构造包含分摊的权威交易，冲突响应必须完整保留当前金额、版本和参与人。 */
function storedTransaction(): Prisma.TransactionGetPayload<{ include: { splits: true } }> {
  return {
    id: transactionId,
    ledgerId,
    ownerId: auth.userId,
    txType: 'expense',
    amount: new Prisma.Decimal('20'),
    nativeAmount: new Prisma.Decimal('20'),
    currencyCode: 'CNY',
    happenedAt: now,
    note: '云端已确认的交易',
    categoryId: null,
    categoryName: null,
    categoryKind: null,
    recurringId: null,
    occurrenceDate: null,
    createdByMemberId: auth.userId,
    lastEditedByMemberId: auth.userId,
    payerMemberId: auth.userId,
    aaMode: 2,
    revision: 3,
    lastEditedAt: now,
    updatedAt: now,
    createdAt: now,
    updatedByDeviceId: auth.deviceId,
    deletedAt: null,
    splits: [{ id: auth.deviceId, transactionId, ledgerId, memberId: auth.userId, amount: new Prisma.Decimal('20') }],
  };
}

describe('同步交易冲突与存储错误边界', () => {
  it('冲突回执使用领域层读取的完整快照，不把重复读取的空结果当作当前状态', async () => {
    try {
      const { tx, transaction, history, events } = fixture();
      const current = storedTransaction();
      transaction.findUnique.mockResolvedValueOnce(current).mockResolvedValueOnce(current).mockResolvedValue(null);

      const outcome = await applyTransaction(tx, auth, transactionChange(1), now, 'fingerprint');

      expect(outcome).toEqual({
        status: 'conflict',
        current_revision: 3,
        current_deleted: false,
        current_entity: mapTransaction(current),
      });
      expect(transaction.findUnique).toHaveBeenCalledTimes(2);
      expect(history.create).not.toHaveBeenCalled();
      expect(events.create).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('同步冲突权威快照验证失败', { cause });
    }
  });

  it('创建唯一约束失败保留原始错误，不在已失败事务中查询或伪造业务冲突', async () => {
    try {
      const { tx, transaction, history, events } = fixture();
      const original = new Prisma.PrismaClientKnownRequestError('交易写入违反唯一约束', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
        meta: { target: ['id'] },
      });
      transaction.findUnique.mockResolvedValueOnce(null).mockRejectedValue(new Error('事务已中止'));
      transaction.create.mockRejectedValue(original);

      await expect(applyTransaction(tx, auth, transactionChange(), now, 'fingerprint')).rejects.toMatchObject({
        message: '交易创建失败',
        cause: original,
      });
      expect(transaction.findUnique).toHaveBeenCalledOnce();
      expect(history.create).not.toHaveBeenCalled();
      expect(events.create).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('同步存储错误传播验证失败', { cause });
    }
  });
});
