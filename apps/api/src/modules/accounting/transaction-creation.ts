import type { Prisma, RecurringTransaction } from '@prisma/client';

import { ApiError } from '../../shared/errors.js';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createChange, createChanges } from '../sync-events/index.js';
import { mapTransaction, transactionPayload } from './mappers.js';
import { advanceRecurringCursor } from './recurring-progress.js';
import { writeTransactionSplits } from './transaction-mutations.js';

type TransactionWithSplits = Prisma.TransactionGetPayload<{ include: { splits: true } }>;
type TransactionCreation = {
  data: Prisma.TransactionUncheckedCreateInput;
  splits: Array<{ memberId: string; amount: string }> | null;
  mutationId?: string;
  requestHash?: string;
  recurringCursor?: RecurringTransaction;
};
type HistoricalTransactionCreation = {
  data: Prisma.TransactionCreateManyInput & { id: string };
  splits: Array<{ memberId: string; amount: string }>;
};

/** 在调用方同步事务中创建交易、分摊及权威快照事件；认证、输入校验和重放策略由协议入口负责。 */
export async function createTransactionMutation(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  mutation: TransactionCreation,
): Promise<{ transaction: TransactionWithSplits; revision: number; changeId: bigint }> {
  try {
    const created = await tx.transaction.create({ data: mutation.data });
    await writeTransactionSplits(tx, created.ledgerId, created.id, mutation.splits);
    const transaction = await tx.transaction.findUniqueOrThrow({
      where: { id: created.id },
      include: { splits: true },
    });
    // 离线周期发生先物化完整分摊，再推进连续游标；规则事件和交易事件仍按同一事务顺序发布。
    if (mutation.recurringCursor) await advanceRecurringCursor(tx, auth, mutation.recurringCursor);
    const changeId = await createChange(
      tx,
      auth,
      transaction.ledgerId,
      'transaction',
      transaction.id,
      'upsert',
      transactionPayload(transaction),
      transaction.updatedAt,
      null,
      mutation.mutationId,
      mutation.requestHash,
    );
    return { transaction, revision: transaction.revision, changeId };
  } catch (cause) {
    // 唯一约束由 REST、同步和导入各自映射；其余异常保留根因交给公共错误边界记录。
    if (cause instanceof ApiError || isUniqueConflict(cause)) throw cause;
    throw new Error('交易创建失败', { cause });
  }
}

/** 原子物化已验证的历史发生及分摊，再写完整快照和墓碑；分片只限制单次 SQL 大小，不拆事务。 */
export async function createTransactionHistory(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  ledgerId: string,
  mutations: HistoricalTransactionCreation[],
): Promise<void> {
  try {
    if (mutations.some((mutation) => mutation.data.ledgerId !== ledgerId)) {
      throw new Error('交易历史与目标账本不一致');
    }
    for (let offset = 0; offset < mutations.length; offset += 250) {
      await tx.transaction.createMany({ data: mutations.slice(offset, offset + 250).map((mutation) => mutation.data) });
    }
    let splitBatch: Prisma.TransactionSplitCreateManyInput[] = [];
    for (const mutation of mutations) {
      for (const split of mutation.splits) {
        splitBatch.push({ ...split, ledgerId, transactionId: mutation.data.id });
        if (splitBatch.length === 500) {
          await tx.transactionSplit.createMany({ data: splitBatch });
          splitBatch = [];
        }
      }
    }
    if (splitBatch.length) await tx.transactionSplit.createMany({ data: splitBatch });
    for (let offset = 0; offset < mutations.length; offset += 250) {
      const ids = mutations.slice(offset, offset + 250).map((mutation) => mutation.data.id);
      const stored = await tx.transaction.findMany({
        where: { id: { in: ids } },
        include: { splits: true },
        orderBy: { id: 'asc' },
      });
      if (stored.length !== ids.length) throw new Error('交易历史物化后数量不一致');
      // 删除发生先给新设备完整来源和内容，再发较高 revision 的墓碑，不能只发删除丢失周期来源。
      await createChanges(
        tx,
        auth,
        ledgerId,
        stored.flatMap((row) => [
          {
            entityType: 'transaction',
            entityId: row.id,
            action: 'upsert' as const,
            payload: { ...mapTransaction(row), revision: row.deletedAt ? row.revision - 1 : row.revision },
            updatedAt: row.updatedAt,
          },
          ...(row.deletedAt
            ? [
                {
                  entityType: 'transaction',
                  entityId: row.id,
                  action: 'delete' as const,
                  payload: { ...mapTransaction(row), deleted_at: row.deletedAt.toISOString() },
                  updatedAt: row.deletedAt,
                },
              ]
            : []),
        ]),
      );
    }
  } catch (cause) {
    if (cause instanceof ApiError || isUniqueConflict(cause)) throw cause;
    throw new Error('交易历史创建失败', { cause });
  }
}

/** 识别需要交由协议入口映射的数据库唯一约束冲突。 */
function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
