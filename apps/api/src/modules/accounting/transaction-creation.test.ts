import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createTransactionHistory, createTransactionMutation } from './transaction-creation.js';

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
    updatedByDeviceId: auth.deviceId,
    deletedAt: null,
    createdAt: now,
    splits: [{ id: memberId, transactionId, ledgerId, memberId, amount: new Prisma.Decimal('7') }],
    ...overrides,
  };
}

/** 使用真实事件入口和序列化函数，仅替代数据库操作以验证失败传播与完整事件内容。 */
function creationClient(rows: StoredTransaction[]) {
  const create = vi.fn().mockResolvedValue(rows[0]);
  const createMany = vi.fn().mockResolvedValue({ count: rows.length });
  const splitMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUniqueOrThrow = vi.fn().mockResolvedValue(rows[0]);
  const findMany = vi
    .fn()
    .mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      rows.filter((row) => where.id.in.includes(row.id)),
    );
  const event = vi.fn().mockResolvedValue({ changeId: 41n });
  const events = vi.fn().mockResolvedValue([{ changeId: 42n }]);
  const tx = {
    transaction: { create, createMany, findUniqueOrThrow, findMany },
    transactionSplit: { createMany: splitMany },
    syncChange: { create: event, createManyAndReturn: events },
  } as unknown as SyncTransaction;
  return { tx, create, createMany, splitMany, findUniqueOrThrow, event, events };
}

/** 从已经验证的持久字段构造创建输入，不携带读取关系对象。 */
function creationData(row: StoredTransaction): Prisma.TransactionUncheckedCreateInput & { id: string } {
  const { splits: _splits, ...data } = row;
  return data;
}

describe('交易创建与事件边界', () => {
  it('事件使用落库后包含分摊和服务器字段的完整快照，并保留客户端 mutation 身份', async () => {
    try {
      const row = storedTransaction();
      const client = creationClient([row]);
      const result = await createTransactionMutation(client.tx, auth, {
        data: { ...creationData(row), amount: '7.00', createdAt: undefined },
        splits: [{ memberId, amount: '7' }],
        mutationId: transactionId,
        requestHash: 'frozen-request',
      });
      expect(result).toEqual({ transaction: row, revision: 1, changeId: 41n });
      expect(client.event).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          ledgerId,
          entityType: 'transaction',
          entityId: transactionId,
          mutationId: transactionId,
          requestHash: 'frozen-request',
          updatedAt: now,
          payload: expect.objectContaining({
            amount: '7',
            native_amount: '7',
            created_at: now.toISOString(),
            splits: [{ member_id: memberId, amount: '7' }],
            revision: 1,
          }),
        }),
      });
      expect(client.splitMany.mock.invocationCallOrder[0]).toBeLessThan(client.event.mock.invocationCallOrder[0]!);
    } catch (cause) {
      throw new Error('交易创建权威事件验证失败', { cause });
    }
  });

  it('分摊失败向外抛出以回滚调用方事务，不发布不完整交易事件', async () => {
    try {
      const row = storedTransaction();
      const client = creationClient([row]);
      client.splitMany.mockRejectedValue(new Error('split write failed'));
      await expect(
        createTransactionMutation(client.tx, auth, { data: creationData(row), splits: [{ memberId, amount: '7' }] }),
      ).rejects.toThrow('交易创建失败');
      expect(client.event).not.toHaveBeenCalled();
      expect(client.findUniqueOrThrow).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('交易分摊失败边界验证失败', { cause });
    }
  });

  it('唯一约束错误保留给协议映射，不误发成功事件', async () => {
    try {
      const row = storedTransaction();
      const client = creationClient([row]);
      const conflict = Object.assign(new Error('unique conflict'), { code: 'P2002' });
      client.create.mockRejectedValue(conflict);
      await expect(createTransactionMutation(client.tx, auth, { data: creationData(row), splits: null })).rejects.toBe(
        conflict,
      );
      expect(client.event).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('交易创建冲突映射验证失败', { cause });
    }
  });

  it('历史墓碑先发完整来源快照，再发原始删除时刻及较高版本', async () => {
    try {
      const deletedAt = new Date('2026-10-12T02:00:00.000Z');
      const row = storedTransaction({
        recurringId: memberId,
        occurrenceDate: '2026-10-11',
        revision: 2,
        updatedAt: deletedAt,
        deletedAt,
      });
      const client = creationClient([row]);
      await createTransactionHistory(client.tx, auth, ledgerId, [
        { data: creationData(row), splits: [{ memberId, amount: '7' }] },
      ]);
      const payloads = client.events.mock.calls[0]![0].data;
      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toMatchObject({
        action: 'upsert',
        payload: { revision: 1, recurring_id: memberId, occurrence_date: '2026-10-11' },
        updatedAt: deletedAt,
      });
      expect(payloads[1]).toMatchObject({
        action: 'delete',
        payload: { revision: 2, deleted_at: deletedAt.toISOString(), splits: [{ member_id: memberId, amount: '7' }] },
        updatedAt: deletedAt,
      });
    } catch (cause) {
      throw new Error('周期历史墓碑事件验证失败', { cause });
    }
  });

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
