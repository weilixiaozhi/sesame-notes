import { describe, it, expect } from 'vitest';
import type { components } from '@sesame-notes/api-client';
import { categoryReorderPlan, CATEGORY_BATCH_LIMIT } from './category-order';

type Category = components['schemas']['Category'];
/** 每行保留独立的原始修订时间，验证计划只携带真实改动的CAS条件。 */
function rows(orders: number[]): Category[] {
  return orders.map((sort_order, index) => ({
    id: `category-${index}`,
    name: `分类${String(index).padStart(4, '0')}`,
    kind: 'expense',
    level: 1,
    parent_id: null,
    icon: null,
    sort_order,
    deleted_at: null,
    version_token: 'a'.repeat(64),
    updated_at: `2026-10-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
  }));
}
/** 把计划应用到副本后按页面规则排序，最终必须得到完整目标顺序。 */
function verify(source: Category[], desired: string[]) {
  const plan = categoryReorderPlan(source, desired);
  const applied = source.map((row) => ({
    ...row,
    sort_order: plan.find((item) => item.id === row.id)?.sort_order ?? row.sort_order,
  }));
  expect(
    applied.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)).map((row) => row.id),
  ).toEqual(desired);
  for (const item of plan) {
    const original = source.find((row) => row.id === item.id)!;
    expect(item.sort_order).not.toBe(original.sort_order);
    expect(item.expected_updated_at).toBe(original.updated_at);
    expect(item.sort_order).toBeGreaterThanOrEqual(-2147483648);
    expect(item.sort_order).toBeLessThanOrEqual(2147483647);
  }
  expect(categoryReorderPlan(source, desired)).toEqual(plan);
  return plan;
}

describe('局部分类整数排序', () => {
  it.each([
    ['连续整数', [0, 1, 2, 3]],
    ['重复零', [0, 0, 0, 0]],
    ['负数', [-9, -8, -7, -6]],
    ['INT32上沿', [2147483647, 2147483647, 2147483647]],
    ['INT32下沿', [-2147483648, -2147483648, -2147483648]],
  ] as const)('%s交换邻项保留正确顺序和整数边界', (_name, orders) => {
    const source = rows([...orders]);
    const ids = source.map((row) => row.id);
    [ids[0], ids[1]] = [ids[1]!, ids[0]!];
    verify(source, ids);
  });
  it.each(['连续值', '全零'] as const)('501个%s邻位交换不提交501项，零值首项只改一条', (mode) => {
    const source = rows(Array.from({ length: 501 }, (_, index) => (mode === '全零' ? 0 : index)));
    const desired = source.map((row) => row.id);
    [desired[0], desired[1]] = [desired[1]!, desired[0]!];
    expect(verify(source, desired)).toHaveLength(mode === '全零' ? 1 : 2);
  });
  it('501个分类全部在INT32下沿仍可用500项原子完成首对交换', () => {
    const source = rows(Array.from<number>({ length: 501 }).fill(-2147483648));
    const ids = source.map((row) => row.id);
    [ids[0], ids[1]] = [ids[1]!, ids[0]!];
    expect(verify(source, ids)).toHaveLength(500);
  });
  it('相同值中间交换只调整附近一侧，不强制整层重编号', () => {
    const source = rows(Array.from<number>({ length: 501 }).fill(0));
    const ids = source.map((row) => row.id);
    [ids[249], ids[250]] = [ids[250]!, ids[249]!];
    expect(verify(source, ids).length).toBeLessThan(CATEGORY_BATCH_LIMIT);
  });
  it('超过500项实际变化保留完整计划供UI拒绝，不拆成半成功请求', () => {
    const source = rows(Array.from({ length: 502 }, (_, index) => index));
    expect(verify(source, source.map((row) => row.id).reverse())).toHaveLength(502);
  });
  it('无移动时不重新编号重复值，损坏的身份列表不能生成计划', () => {
    const source = rows([9, 9, 9]);
    expect(
      categoryReorderPlan(
        source,
        source.map((row) => row.id),
      ),
    ).toEqual([]);
    expect(() => categoryReorderPlan(source, ['unknown'])).toThrow('范围');
  });
});
