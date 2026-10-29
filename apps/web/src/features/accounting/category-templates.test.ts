// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@sesame-notes/api-client';
import {
  CategoryTemplateTargetUnavailableError,
  selectedTemplateKeys,
  templatePlan,
  unifiedCategoryTemplates,
} from './category-template-plan';

type Category = components['schemas']['Category'];
const items = unifiedCategoryTemplates();

/** 使用真实分类字段验证已有记录、层级和账单关联身份保持不变。 */
function category(id: string, name: string, parentId: string | null = null): Category {
  return {
    id,
    name,
    kind: 'expense',
    level: parentId ? 2 : 1,
    parent_id: parentId,
    icon: 'utensils',
    sort_order: 5,
    deleted_at: null,
    version_token: 'test-version',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

afterEach(() => vi.restoreAllMocks());

describe('独立分类模板创建', () => {
  it('统一目录包含52个父分类和107个子分类，独立父项也能选择', () => {
    expect(items.filter((item) => item.parentKey === null)).toHaveLength(52);
    expect(items.filter((item) => item.parentKey !== null)).toHaveLength(107);
    expect(new Set(items.map((item) => item.key)).size).toBe(159);
    const plan = templatePlan(items, new Set(['subscription']), []);
    expect(plan).toMatchObject([{ name: '订阅服务', level: 1, parent_id: null }]);
    expect(plan[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('选择多个子项只创建本次一个父项，已有同名父子不被复用或修改', () => {
    const saved = [category('existing', '餐饮'), category('existing-child', '午餐', 'existing')];
    const before = structuredClone(saved);
    const plan = templatePlan(items, new Set(['dining_breakfast', 'dining_lunch']), saved);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toMatchObject({ name: '餐饮', level: 1, parent_id: null });
    expect(plan[0]!.id).not.toBe('existing');
    expect(plan.slice(1).every((child) => child.parent_id === plan[0]!.id)).toBe(true);
    expect(saved).toEqual(before);
  });

  it('两次主动添加得到完全不同的ID，原模板即使已移动也不占位', () => {
    const moved = category('ffec6471-df8b-5bb3-8a05-93ef863ca958', '餐饮', 'other-parent');
    const first = templatePlan(items, new Set(['dining_lunch']), [moved]);
    const second = templatePlan(items, new Set(['dining_lunch']), [moved]);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(second.every((row) => first.every((previous) => previous.id !== row.id))).toBe(true);
    expect(moved.parent_id).toBe('other-parent');
  });

  it('明确目标父ID后只创建子项，同名不同图标父项不会选错', () => {
    const first = category('first', '餐饮');
    const second = { ...category('second', '餐饮'), icon: 'home' };
    const plan = templatePlan(items, new Set(['dining_lunch', 'fruit_apple']), [first, second], {
      targetParentId: second.id,
    });
    expect(plan).toHaveLength(2);
    expect(plan.every((row) => row.level === 2 && row.parent_id === second.id)).toBe(true);
    expect(plan.map((row) => row.name)).toEqual(['午餐', '苹果']);
  });

  it('目标消失、变成二级或不属于当前目录时拒绝追加，不新建替代父项', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const current of [
      [],
      [category('target', '餐饮', 'other')],
      [{ ...category('target', '餐饮'), deleted_at: '2026-10-01T00:00:00Z' }],
      [category('same-name', '餐饮')],
    ]) {
      expect(() => templatePlan(items, new Set(['dining_lunch']), current, { targetParentId: 'target' })).toThrow(
        CategoryTemplateTargetUnavailableError,
      );
    }
  });

  it('取消最后一个子项后仅保留用户明确选择的父项', () => {
    expect([...selectedTemplateKeys(items, new Set(['dining_lunch']), false)]).toEqual(['dining_lunch', 'dining']);
    expect([...selectedTemplateKeys(items, new Set(), false)]).toEqual([]);
    expect([...selectedTemplateKeys(items, new Set(['dining']), false)]).toEqual(['dining']);
    expect([...selectedTemplateKeys(items, new Set(['dining']), true)]).toEqual(['dining']);
  });
});
