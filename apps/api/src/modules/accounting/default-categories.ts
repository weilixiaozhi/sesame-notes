import { Value } from '@sinclair/typebox/value';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createChanges } from '../sync-events/index.js';
import { CategoryInput, categoryData } from './domain/categories.js';
import { categoryPayload } from './mappers.js';
import catalog from './default-category-catalog.json' with { type: 'json' };

/** 注册事务与显式空目录初始化共用完整默认分类；已有目录或墓碑均保留用户意图。 */
export async function ensureDefaultCategories(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${auth.userId}::uuid FOR UPDATE`;
  if (await tx.category.findFirst({ where: { ownerId: auth.userId }, select: { id: true } })) return;
  const now = new Date(0);
  const knownParents = new Set<string>();
  const data = catalog.items.map((item) => {
    if (
      !Value.Check(CategoryInput, item) ||
      (item.level !== 1 && item.level !== 2) ||
      (item.level === 1 && item.parent_id !== null) ||
      (item.level === 2 && (item.parent_id === null || !knownParents.has(item.parent_id))) ||
      knownParents.has(item.id)
    )
      throw new Error('默认分类目录格式、层级或身份无效');
    knownParents.add(item.id);
    return categoryData(auth.userId, auth.deviceId, { ...item, level: item.level }, now);
  });
  // 先父后子批量落库，减少全局同步锁持有期间的网络往返；任何失败仍回滚全部目录与事件。
  const parents = await tx.category.createManyAndReturn({ data: data.filter((item) => item.level === 1) });
  const children = await tx.category.createManyAndReturn({ data: data.filter((item) => item.level === 2) });
  const categories = new Map([...parents, ...children].map((item) => [item.id, item]));
  await createChanges(
    tx,
    auth,
    null,
    catalog.items.map((item) => {
      const category = categories.get(item.id);
      if (!category) throw new Error('默认分类批量写入结果不完整');
      return {
        entityType: 'category',
        entityId: category.id,
        action: 'upsert',
        payload: categoryPayload(category),
        updatedAt: now,
      };
    }),
  );
}
