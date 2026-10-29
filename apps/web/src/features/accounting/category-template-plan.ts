import type { components, paths } from '@sesame-notes/api-client';
import catalog from './category-catalog.json';

type Category = components['schemas']['Category'];
export type CategoryTemplate = { key: string; name: string; icon: string; parentKey: string | null };
type Input = paths['/api/v1/ledgers/{ledger_id}/categories']['post']['requestBody']['content']['application/json'];

/** 明确目标失效时允许重新选择，不能按同名替换已有选择。 */
export class CategoryTemplateTargetUnavailableError extends Error {
  /** 提供可直接展示的固定提示，不携带账号或分类正文。 */
  constructor() {
    super('所选分类已不可用，请重新选择所属分类');
    this.name = 'CategoryTemplateTargetUnavailableError';
  }
}

/** 从同一分类树派生遍历节点；资源键仅定位模板，不作为用户分类身份。 */
export function unifiedCategoryTemplates(): CategoryTemplate[] {
  try {
    return catalog.groups.flatMap(({ children, ...parent }) => [
      { ...parent, parentKey: null },
      ...children.map((child) => ({ ...child, parentKey: parent.key })),
    ]);
  } catch (error) {
    console.error('[category-template-plan] 读取分类模板失败', error);
    throw new Error('分类模板暂时无法读取，请重新打开', { cause: error });
  }
}

/** 新建分类按包含关系补齐本次所属分类；追加模式将每个所选节点放入明确目标。 */
export function selectedTemplateKeys(items: CategoryTemplate[], selected: Set<string>, attachToExisting: boolean) {
  const wanted = new Set(items.filter((item) => selected.has(item.key)).map((item) => item.key));
  if (!attachToExisting) {
    for (const item of items) if (wanted.has(item.key) && item.parentKey) wanted.add(item.parentKey);
  }
  return wanted;
}

/** 每次主动添加生成独立身份，原请求重试必须复用计划；层级仅在协议边界派生。 */
export function templatePlan(
  items: CategoryTemplate[],
  selected: Set<string>,
  existing: Category[],
  options: { targetParentId?: string; createId?: () => string } = {},
): Input[] {
  try {
    const attach = options.targetParentId !== undefined;
    const target = attach ? existing.find((row) => row.id === options.targetParentId) : undefined;
    if (attach && (!target || target.deleted_at || target.parent_id !== null))
      throw new CategoryTemplateTargetUnavailableError();
    const wanted = selectedTemplateKeys(items, selected, attach);
    const createId = options.createId ?? (() => crypto.randomUUID());
    const ids = new Map<string, string>();
    for (const item of items) if (wanted.has(item.key)) ids.set(item.key, createId());
    const created: Input[] = [];
    for (const item of [
      ...items.filter((row) => row.parentKey === null),
      ...items.filter((row) => row.parentKey !== null),
    ]) {
      if (!wanted.has(item.key)) continue;
      const parentId = attach ? target!.id : item.parentKey ? ids.get(item.parentKey) : null;
      if (item.parentKey && !parentId) throw new Error('所选子分类缺少所属分类，请重新选择');
      created.push({
        id: ids.get(item.key)!,
        name: item.name,
        icon: item.icon,
        kind: 'expense',
        level: parentId ? 2 : 1,
        parent_id: parentId ?? null,
        sort_order: 0,
      });
    }
    const orders = new Map<string, number>();
    for (const item of created) {
      const parent = item.parent_id ?? '';
      // 已有目录只用于追加排序与校验明确目标，不用于名称判重或模板占位。
      const order =
        (orders.get(parent) ??
          Math.max(
            -1,
            ...existing
              .filter((row) => !row.deleted_at && (row.parent_id ?? '') === parent)
              .map((row) => row.sort_order),
          )) + 1;
      if (order > 2147483647) throw new Error('分类排序已到上限，请先调整已有分类排序');
      orders.set(parent, order);
      item.sort_order = order;
    }
    return created;
  } catch (error) {
    console.error('[category-template-plan] 创建分类计划失败', error);
    throw error;
  }
}
