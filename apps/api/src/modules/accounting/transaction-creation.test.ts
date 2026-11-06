import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createTransactionHistory } from './transaction-creation.js';

const ledgerId = '11111111-1111-4111-8111-111111111111';
const transactionId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const auth = { userId: memberId, deviceId: '44444444-4444-4444-8444-444444444444' };
const now = new Date('2026-10-13T01:00:00.000Z');
type StoredTransaction = Prisma.TransactionGetPayload<{ include: { splits: true } }>;

/** 提供数据库权威字段和 Decimal，验证事件不是未经规范化的请求回显。 */
function storedTransaction(overrides: Partial<StoredTransaction> = {}): StoredTransaction {
  return {
    id: transactionId,
    ledgerId,
    ownerId: auth.userId,
    txType: 'expense',
    amount: new Prisma.Decimal('7.00'),
    nativeAmount: new Prisma.Decimal('7.00'),
    currencyCode: 'CNY',
    happenedAt: now,
    note: null,
    categoryId: null,
    categoryName: null,
    categoryKind: null,
    recurringId: null,
    occurrenceDate: null,
    createdByMemberId: memberId,
    lastEditedByMemberId: memberId,
    payerMemberId: memberId,
    aaMode: 2,
    revision: 1,
    lastEditedAt: null,
    updatedAt: now,
    deletedAt: null,
    createdAt: now,
    splits: [{ id: memberId, transactionId, ledgerId, memberId, amount: new Prisma.Decimal('7') }],
    ...overrides,
  };
}

/** 使用真实事件入口和序列化函数，仅替代数据库操作以验证失败传播与完整事件内容。 */
function creationClient(rows: StoredTransaction[]) {
  try {
    const createMany = vi.fn().mockResolvedValue({ count: rows.length });
    const splitMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
        rows.filter((row) => where.id.in.includes(row.id)),
      );
    const events = vi.fn().mockResolvedValue([{ changeId: 42n }]);
    const tx = {
      transaction: { createMany, findMany },
      transactionSplit: { createMany: splitMany },
      syncChange: { createManyAndReturn: events },
    } as unknown as SyncTransaction;
    return { tx, createMany, events };
  } catch (cause) {
    throw new Error('交易历史分片夹具初始化失败', { cause });
  }
}

/** 从已经验证的持久字段构造创建输入，不携带读取关系对象。 */
function creationData(row: StoredTransaction): Prisma.TransactionUncheckedCreateInput & { id: string } {
  const { splits: _splits, ...data } = row;
  return data;
}

describe('交易创建与事件边界', () => {
  it('历史分片跨过250条后仍完整发布，事务中途失败会向外传播', async () => {
    try {
      const rows = Array.from({ length: 251 }, (_, index) =>
        storedTransaction({ id: `record-${index}`, splits: [], aaMode: null }),
      );
      const client = creationClient(rows);
      await createTransactionHistory(
        client.tx,
        auth,
        ledgerId,
        rows.map((row) => ({ data: creationData(row), splits: [] })),
      );
      expect(client.createMany.mock.calls.map(([input]) => input.data.length)).toEqual([250, 1]);
      expect(client.events.mock.calls.map(([input]) => input.data.length)).toEqual([250, 1]);
      const broken = creationClient(rows);
      broken.createMany.mockResolvedValueOnce({ count: 250 }).mockRejectedValueOnce(new Error('batch unavailable'));
      await expect(
        createTransactionHistory(
          broken.tx,
          auth,
          ledgerId,
          rows.map((row) => ({ data: creationData(row), splits: [] })),
        ),
      ).rejects.toThrow('交易历史创建失败');
      expect(broken.events).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('交易历史分片原子性验证失败', { cause });
    }
  });
});
