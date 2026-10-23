import type { Category } from '@prisma/client';
import type { SyncTransaction } from '../../../shared/sync-transaction.js';
import { ApiError } from '../../../shared/errors.js';
import { normalizeName } from '../../../shared/text-validation.js';

type CategorySemanticDraft = { name: unknown; kind: string; level: number; parent_id: string | null };
type ExistingCategoryIdentity = Pick<Category, 'id' | 'ownerId' | 'name' | 'kind' | 'level' | 'parentId' | 'deletedAt'>;

/** 分类语义由类型、层级、父身份和规范名称组成，显示名称不能替代实体身份。 */
export function categorySemanticKey(draft: CategorySemanticDraft): string {
  try {
    return JSON.stringify([draft.kind, draft.level, draft.parent_id, normalizeName(draft.name)]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('分类语义身份计算失败', { cause: error });
  }
}

/** 在持有同步提交锁的事务中验证新语义唯一性，既有同身份内容编辑保留原记录。 */
export async function assertCategoryNameIdentity(
  tx: SyncTransaction,
  ownerId: string,
  draft: CategorySemanticDraft,
  options: { categoryId?: string; current?: ExistingCategoryIdentity; removingIds?: ReadonlySet<string> } = {},
): Promise<void> {
  try {
    // 品牌事务已持有同步提交锁，查重与最终写入处于同一提交窗口。
    const wanted = categorySemanticKey(draft);
    const current = options.current;
    if (
      current &&
      current.ownerId === ownerId &&
      current.id === options.categoryId &&
      current.deletedAt === null &&
      categorySemanticKey({ ...current, parent_id: current.parentId }) === wanted
    ) {
      // 同一实体仅修改图标或排序时保留既有身份，历史重复行不会被合并或删掉。
      return;
    }
    const excludedIds = new Set(options.removingIds ?? []);
    if (options.categoryId) excludedIds.add(options.categoryId);
    const candidates = await tx.category.findMany({
      where: {
        ownerId,
        kind: draft.kind,
        level: draft.level,
        parentId: draft.parent_id,
        deletedAt: null,
        ...(excludedIds.size ? { id: { notIn: [...excludedIds] } } : {}),
      },
      select: { id: true, name: true },
    });
    if (candidates.some((row) => normalizeName(row.name) === normalizeName(draft.name))) {
      throw new ApiError(409, 'CATEGORY_NAME_CONFLICT', '同一父分类下已存在同名分类，请调整名称后重试');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('分类语义唯一性校验失败', { cause: error });
  }
}
