import type { Prisma } from '@prisma/client';

import { decimalToCanonical } from '../../shared/decimal.js';

type TransactionWithSplits = Prisma.TransactionGetPayload<{ include: { splits: true } }>;
export type HistoryAction = 'edit' | 'delete' | 'category-migration' | 'ledger-currency';

/** 只读取对象型历史正文；异常或数组正文不能作为展示字段来源。 */
function historyRecord(changes: Prisma.InputJsonValue): Prisma.JsonObject {
  return changes && typeof changes === 'object' && !Array.isArray(changes) ? (changes as Prisma.JsonObject) : {};
}

/** 历史动作由提交正文中的动作/操作标识决定，普通更新统一归为 edit。 */
export function historyActionOf(changes: Prisma.InputJsonValue): HistoryAction {
  const value = historyRecord(changes);
  if (value.action === 'delete') return 'delete';
  if (value.action === 'category-migration') return 'category-migration';
  if (value.operation === 'change-ledger-currency') return 'ledger-currency';
  return 'edit';
}

/** 分摊指纹只用于判断本次编辑是否改变分摊，不参与对外的历史存储。 */
function splitsFingerprint(splits: TransactionWithSplits['splits']): string {
  return [...splits]
    .sort((left, right) => left.memberId.localeCompare(right.memberId))
    .map((split) => `${split.memberId}:${decimalToCanonical(split.amount)}`)
    .join('|');
}

/** 仅在普通编辑时比较更新前后，备注和分摊变化用于展示追加提示。 */
export function historyChangeFlags(
  before: TransactionWithSplits | null,
  after: TransactionWithSplits,
  action: HistoryAction,
): { noteChanged: boolean; sharingChanged: boolean } {
  if (action !== 'edit' || before === null) {
    return { noteChanged: false, sharingChanged: false };
  }
  return {
    noteChanged: before.note !== after.note,
    sharingChanged:
      before.aaMode !== after.aaMode ||
      before.payerMemberId !== after.payerMemberId ||
      splitsFingerprint(before.splits) !== splitsFingerprint(after.splits),
  };
}

/**
 * 在提交正文旁写入展示快照，所有客户端无需再猜测分类名和金额。
 * changes 仍保留原始提交字段/动作，display 只服务历史展示。
 */
export function withHistoryDisplay(
  changes: Prisma.InputJsonValue,
  transaction: TransactionWithSplits,
  options: {
    action: HistoryAction;
    noteChanged?: boolean;
    sharingChanged?: boolean;
  },
): Prisma.InputJsonValue {
  const raw = historyRecord(changes);
  return {
    ...raw,
    display: {
      action: options.action,
      category_name: transaction.categoryName ?? null,
      amount: decimalToCanonical(transaction.amount),
      currency_code: transaction.currencyCode,
      happened_at: transaction.happenedAt.toISOString(),
      note: transaction.note,
      note_changed: options.noteChanged ?? false,
      sharing_changed: options.sharingChanged ?? false,
    } satisfies Prisma.JsonObject,
  } satisfies Prisma.InputJsonObject;
}
