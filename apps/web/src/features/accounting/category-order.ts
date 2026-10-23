import type { components, paths } from '@sesame-notes/api-client';

type Category = components['schemas']['Category'];
type ReorderItems =
  paths['/api/v1/ledgers/{ledger_id}/categories/reorder']['post']['requestBody']['content']['application/json']['items'];
export const CATEGORY_BATCH_LIMIT = 500;
const MIN_ORDER = -2147483648;
const MAX_ORDER = 2147483647;

/** 保留移动区间外的排序值；无整数空隙时扩大到最近边界，避免轻微移动重写整层。 */
export function categoryReorderPlan(rows: readonly Category[], ids: readonly string[]): ReorderItems {
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id)))
    throw new Error('分类排序范围已变化，请重新打开排序');
  const first = ids.findIndex((id, index) => id !== rows[index]!.id);
  if (first === -1) return [];
  let last = ids.length - 1;
  while (ids[last] === rows[last]!.id) last--;
  const changed = (id: string, sort_order: number) => ({
    id,
    sort_order,
    expected_updated_at: byId.get(id)!.updated_at,
  });
  // 完整重编号作为有界备用方案，实际提交仍只包含真正发生变化的分类。
  let best = ids.flatMap((id, index) => (byId.get(id)!.sort_order === index ? [] : [changed(id, index)]));
  const maxWidth = Math.min(ids.length, CATEGORY_BATCH_LIMIT + 1);
  for (let width = last - first + 1; width <= maxWidth; width++) {
    let found = false;
    for (let start = Math.max(0, last - width + 1); start <= Math.min(first, ids.length - width); start++) {
      const end = start + width - 1;
      const before = start > 0 ? byId.get(ids[start - 1]!)! : null;
      const after = end + 1 < ids.length ? byId.get(ids[end + 1]!)! : null;
      const firstRow = byId.get(ids[start]!)!;
      const lastRow = byId.get(ids[end]!)!;
      // 与窗口外同值时，只有名称次序仍严格一致才可共用边界值。
      const lower = before ? before.sort_order + (before.name.localeCompare(firstRow.name) < 0 ? 0 : 1) : MIN_ORDER;
      const upper = after ? after.sort_order - (lastRow.name.localeCompare(after.name) < 0 ? 0 : 1) : MAX_ORDER;
      if (upper - lower + 1 < width) continue;
      const base = Math.max(lower, Math.min(rows[start]!.sort_order, upper - width + 1));
      const candidate: ReorderItems = [];
      for (let index = start; index <= end; index++) {
        const id = ids[index]!;
        const sort = base + index - start;
        if (byId.get(id)!.sort_order !== sort) candidate.push(changed(id, sort));
      }
      if (candidate.length <= best.length) best = candidate;
      found = true;
    }
    if (found) break;
  }
  return best;
}
