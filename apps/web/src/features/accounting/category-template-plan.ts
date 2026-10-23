import type { components, paths } from '@sesame-notes/api-client';
import type catalog from './category-catalog.json';

type Category = components['schemas']['Category'];
type Template = (typeof catalog.hierarchical)[number];
type Input = paths['/api/v1/ledgers/{ledger_id}/categories']['post']['requestBody']['content']['application/json'];

/** 模板身份只由跨端固定 ID 决定；同名自定义分类不能被认领为官方模板。 */
export function existingTemplate(item: Template, existing: Category[]): Category | undefined {
  return existing.find((row) => row.id === item.seed_id);
}

/** 与服务端普通名称规则一致，仅去边缘 Unicode 空白，不折叠大小写或兼容字形。 */
function normalizedName(value: string): string {
  return value.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
}

/** 同父名称冲突只阻止创建，不合并身份；父分类改为二级后也不能再挂接子分类。 */
export function templateBlockReason(item: Template, items: Template[], existing: Category[]): string | null {
  if (existingTemplate(item, existing)) return null;
  let parentId: string | null = null;
  if (item.parent_key) {
    const parent = items.find((row) => row.key === item.parent_key && row.level === 1);
    if (!parent) return '模板父分类不存在，未自动添加';
    const savedParent = existingTemplate(parent, existing);
    if (savedParent && (savedParent.level !== 1 || savedParent.parent_id !== null))
      return '父分类层级已改变，未自动添加';
    if (!savedParent && templateBlockReason(parent, items, existing)) return '父分类同名冲突，未自动添加';
    parentId = parent.seed_id;
  }
  return existing.some((row) => row.parent_id === parentId && normalizedName(row.name) === normalizedName(item.name))
    ? '同名分类已存在，未自动添加'
    : null;
}

/** 按固定身份补齐父子分类；重复应用或更换语言均不新建另一套分类。 */
export function templatePlan(items: Template[], selected: Set<string>, existing: Category[]): Input[] {
  const wanted = new Set(
    items
      .filter(
        (item) =>
          selected.has(item.key) && !existingTemplate(item, existing) && !templateBlockReason(item, items, existing),
      )
      .map((item) => item.key),
  );
  for (const item of items) if (wanted.has(item.key) && item.parent_key) wanted.add(item.parent_key);
  const created: Input[] = [];
  for (const level of [1, 2] as const) {
    for (const item of items.filter((row) => row.level === level)) {
      if (!wanted.has(item.key) || existingTemplate(item, existing)) continue;
      const parent = item.parent_key ? items.find((row) => row.key === item.parent_key && row.level === 1) : null;
      if (item.level === 2 && !parent) throw new Error('模板父分类不存在，请重新读取');
      created.push({
        id: item.seed_id,
        name: item.name,
        kind: 'expense',
        level,
        parent_id: parent?.seed_id ?? null,
        icon: item.icon,
        sort_order: 0,
      });
    }
  }
  const orders = new Map<string, number>();
  for (const item of created) {
    const parent = item.parent_id ?? '';
    const order =
      (orders.get(parent) ??
        Math.max(-1, ...existing.filter((row) => (row.parent_id ?? '') === parent).map((row) => row.sort_order))) + 1;
    if (order > 2147483647) throw new Error('分类排序已到上限，请先调整已有分类排序');
    orders.set(parent, order);
    item.sort_order = order;
  }
  return created;
}
