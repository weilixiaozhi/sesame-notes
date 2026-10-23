import type { SyncTransaction } from '../../shared/sync-transaction.js';
import type { Prisma } from '@prisma/client';

import { ApiError } from '../../shared/errors.js';
import { createChange } from '../sync-events/index.js';
import { transactionPayload } from './mappers.js';
import { createdByMemberIdFor } from './member-refs.js';

type TransactionWithSplits = Prisma.TransactionGetPayload<{ include: { splits: true } }>;

export type TransactionMutationResult =
  | { status: 'applied'; transaction: TransactionWithSplits; revision: number; changeId: bigint }
  | {
      status: 'not_found' | 'deleted' | 'scope_conflict' | 'conflict';
      current: TransactionWithSplits | null;
    };

type TransactionUpdateMutation = {
  ledgerId: string;
  transactionId: string;
  baseRevision?: number;
  fields: Prisma.TransactionUncheckedUpdateManyInput;
  splits?: Array<{ memberId: string; amount: string }> | null;
  historyChanges: Prisma.InputJsonValue;
  updatedAt: Date;
  mutationId?: string;
  requestHash?: string;
};

type TransactionDeleteMutation = {
  ledgerId: string;
  transactionId: string;
  baseRevision?: number;
  updatedAt: Date;
  mutationId?: string;
  requestHash?: string;
};

/** 原子执行交易更新：revision CAS、分摊替换、编辑历史与同步事件共用同一事务。 */
export async function updateTransactionMutation(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  mutation: TransactionUpdateMutation,
): Promise<TransactionMutationResult> {
  try {
    if (mutation.baseRevision === undefined) {
      return await readMutationFailure(tx, mutation.transactionId, mutation.ledgerId);
    }
    const operatorMemberId = createdByMemberIdFor(mutation.ledgerId, auth.userId);
    const cas = await tx.transaction.updateMany({
      where: {
        id: mutation.transactionId,
        ledgerId: mutation.ledgerId,
        revision: mutation.baseRevision,
        deletedAt: null,
      },
      data: {
        ...mutation.fields,
        lastEditedByMemberId: operatorMemberId,
        revision: { increment: 1 },
        lastEditedAt: mutation.updatedAt,
        updatedAt: mutation.updatedAt,
        updatedByDeviceId: auth.deviceId,
      },
    });
    if (cas.count === 0) return await readMutationFailure(tx, mutation.transactionId, mutation.ledgerId);

    if (mutation.splits !== undefined) {
      await tx.transactionSplit.deleteMany({ where: { transactionId: mutation.transactionId } });
      await writeTransactionSplits(tx, mutation.ledgerId, mutation.transactionId, mutation.splits);
    }
    const transaction = await tx.transaction.findUniqueOrThrow({
      where: { id: mutation.transactionId },
      include: { splits: true },
    });
    await tx.transactionEditHistory.create({
      data: {
        transactionId: mutation.transactionId,
        ledgerId: mutation.ledgerId,
        version: transaction.revision,
        operatorMemberId,
        changes: mutation.historyChanges,
      },
    });
    const changeId = await createChange(
      tx,
      auth,
      mutation.ledgerId,
      'transaction',
      mutation.transactionId,
      'upsert',
      transactionPayload(transaction),
      mutation.updatedAt,
      null,
      mutation.mutationId,
      mutation.requestHash,
    );
    return { status: 'applied', transaction, revision: transaction.revision, changeId };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('交易更新失败', { cause: error });
  }
}

/** 原子执行交易删除：revision CAS、tombstone、编辑历史与同步事件共用同一事务。 */
export async function deleteTransactionMutation(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  mutation: TransactionDeleteMutation,
): Promise<TransactionMutationResult> {
  try {
    if (mutation.baseRevision === undefined) {
      return await readMutationFailure(tx, mutation.transactionId, mutation.ledgerId);
    }
    const operatorMemberId = createdByMemberIdFor(mutation.ledgerId, auth.userId);
    const cas = await tx.transaction.updateMany({
      where: {
        id: mutation.transactionId,
        ledgerId: mutation.ledgerId,
        revision: mutation.baseRevision,
        deletedAt: null,
      },
      data: {
        revision: { increment: 1 },
        deletedAt: mutation.updatedAt,
        lastEditedByMemberId: operatorMemberId,
        lastEditedAt: mutation.updatedAt,
        updatedAt: mutation.updatedAt,
        updatedByDeviceId: auth.deviceId,
      },
    });
    if (cas.count === 0) return await readMutationFailure(tx, mutation.transactionId, mutation.ledgerId);

    const transaction = await tx.transaction.findUniqueOrThrow({
      where: { id: mutation.transactionId },
      include: { splits: true },
    });
    await tx.transactionEditHistory.create({
      data: {
        transactionId: mutation.transactionId,
        ledgerId: mutation.ledgerId,
        version: transaction.revision,
        operatorMemberId,
        changes: { action: 'delete', base_revision: mutation.baseRevision },
      },
    });
    const changeId = await createChange(
      tx,
      auth,
      mutation.ledgerId,
      'transaction',
      mutation.transactionId,
      'delete',
      { revision: transaction.revision },
      mutation.updatedAt,
      null,
      mutation.mutationId,
      mutation.requestHash,
    );
    return { status: 'applied', transaction, revision: transaction.revision, changeId };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('交易删除失败', { cause: error });
  }
}

/** 写入交易分摊；空或 null 表示非指定分摊，不落任何行。 */
export async function writeTransactionSplits(
  tx: Prisma.TransactionClient,
  ledgerId: string,
  transactionId: string,
  splits: Array<{ memberId: string; amount: string }> | null,
): Promise<void> {
  try {
    if (!splits || splits.length === 0) return;
    await tx.transactionSplit.createMany({
      data: splits.map((split) => ({ ledgerId, transactionId, memberId: split.memberId, amount: split.amount })),
    });
  } catch (error) {
    throw new Error('交易分摊写入失败', { cause: error });
  }
}

/** CAS 未命中时读取权威状态，让 REST 与 push 分别映射自己的协议响应。 */
async function readMutationFailure(
  tx: Prisma.TransactionClient,
  transactionId: string,
  ledgerId: string,
): Promise<Exclude<TransactionMutationResult, { status: 'applied' }>> {
  const current = await tx.transaction.findUnique({
    where: { id: transactionId },
    include: { splits: true },
  });
  if (!current) return { status: 'not_found', current: null };
  if (current.ledgerId !== ledgerId) return { status: 'scope_conflict', current };
  if (current.deletedAt !== null) return { status: 'deleted', current };
  return { status: 'conflict', current };
}
