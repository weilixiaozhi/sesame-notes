import type { SyncTransaction } from '../../shared/sync-transaction.js';

import { createChange } from '../sync-events/index.js';
import { ledgerPayload } from './mappers.js';

/** 生成交易分类快照的级联更新，确保分类名称和类型在所有读路径中保持一致。 */
export function categorySnapshotUpdate(name: string | null, kind: string | null) {
  return name === null
    ? { categoryId: null, categoryName: null, categoryKind: null }
    : { categoryName: name, categoryKind: kind };
}

/** 在分类所属账号内更新交易展示快照，并为受影响账本追加全量失效事件。 */
export async function updateCategoryTransactionSnapshots(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  category: { id: string; ownerId: string; name: string | null; kind: string | null },
  updatedAt: Date,
): Promise<void> {
  try {
    // 分类的完整身份是账号与分类 ID；默认分类 ID 会在不同账号之间重复。
    const where = { categoryId: category.id, ownerId: category.ownerId };
    const ledgers = await tx.ledger.findMany({
      where: {
        ownerId: category.ownerId,
        deletedAt: null,
        OR: [
          { transactions: { some: where } },
          ...(category.name === null ? [{ recurringTransactions: { some: where } }] : []),
        ],
      },
    });
    // 删除分类会清空引用，因此必须先保存受影响账本，再执行更新与事件写入。
    if (category.name === null) {
      // 显式删除只清引用；SQL 保留历史交易与墓碑的时间、版本、金额、身份等其他字段。
      await tx.$executeRaw`
        UPDATE transactions SET category_id = NULL, category_name = NULL, category_kind = NULL
        WHERE owner_id = ${category.ownerId}::uuid AND category_id = ${category.id}::uuid
      `;
      // 分类删除派生的清理只改变引用，保留活动/墓碑规则的排期、游标与元数据时钟。
      await tx.$executeRaw`
        UPDATE recurring_transactions SET category_id = NULL
        WHERE owner_id = ${category.ownerId}::uuid AND category_id = ${category.id}::uuid
      `;
    } else {
      await tx.transaction.updateMany({ where, data: categorySnapshotUpdate(category.name, category.kind) });
    }
    for (const ledger of ledgers) {
      await createChange(
        tx,
        auth,
        ledger.id,
        'ledger',
        ledger.id,
        'upsert',
        { ...ledgerPayload(ledger), requires_full: true },
        updatedAt,
      );
    }
  } catch (error) {
    throw new Error('分类交易快照更新失败', { cause: error });
  }
}
