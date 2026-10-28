// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { components } from '@sesame-notes/api-client';
import { existingTemplate, templateBlockReason, templatePlan } from './category-template-plan';
import catalog from './category-catalog.json';

type Category = components['schemas']['Category'];
type DefaultCategory = Omit<(typeof catalog.hierarchical)[number], 'seed_id' | 'parent_key'> & {
  id: string;
  parent_id: string | null;
  sort_order: number;
};

/** 读取服务端实际使用的默认目录，校验跨端生成数据的一致性。 */
function readDefaultCatalog(): { items: DefaultCategory[] } {
  try {
    const path = fileURLToPath(
      new URL('../../../../api/src/modules/accounting/default-category-catalog.json', import.meta.url),
    );
    return JSON.parse(readFileSync(path, 'utf8')) as { items: DefaultCategory[] };
  } catch (error) {
    console.error('[category-templates.test] 读取服务端默认分类目录失败', error);
    throw new Error('无法读取默认分类测试数据', { cause: error });
  }
}

const defaults = readDefaultCatalog();
const hybrid = defaults.items.map((entry) => ({
  ...entry,
  seed_id: entry.id,
  parent_key: entry.parent_id ? (defaults.items.find((parent) => parent.id === entry.parent_id)?.key ?? null) : null,
}));
/** 测试数据使用生成分类模型，覆盖跨端身份与父子关联规则。 */
function category(id: string, name: string, parentId: string | null = null): Category {
  return {
    id,
    name,
    kind: 'expense',
    level: parentId ? 2 : 1,
    parent_id: parentId,
    icon: null,
    sort_order: 5,
    deleted_at: null,
    version_token: 'test-category-version',
    updated_at: '2026-09-30T00:00:00.000Z',
  };
}

describe('手机分类模板兼容', () => {
  it('首次默认目录保持手机20父41子、父先子后、分组顺序与稳定种子身份', () => {
    expect(hybrid).toHaveLength(61);
    const parents = hybrid.filter((entry) => entry.level === 1);
    expect(parents.map((entry) => entry.key)).toEqual([
      'dining',
      'beverage',
      'shopping',
      'transport',
      'communication',
      'fruit',
      'snacks',
      'sports',
      'pets',
      'housing',
      'transfer',
      'subscription',
      'entertainment',
      'education',
      'gift',
      'game',
      'beauty',
      'medical',
      'digital',
      'other',
    ]);
    expect(parents.map((entry) => entry.sort_order)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(new Set(hybrid.map((entry) => entry.seed_id)).size).toBe(61);
    expect(hybrid[0]).toMatchObject({
      key: 'dining',
      name: '餐饮',
      seed_id: 'ffec6471-df8b-5bb3-8a05-93ef863ca958',
      icon: 'utensils',
      parent_key: null,
    });
    expect(hybrid[1]).toMatchObject({
      key: 'dining_breakfast',
      name: '早餐',
      seed_id: '02d2cbc5-0298-5dea-ae85-f4616e0eafc2',
      icon: 'sandwich',
      parent_key: 'dining',
    });
    for (const [index, entry] of hybrid.entries()) {
      const template = [...catalog.flat, ...catalog.hierarchical].find((item) => item.seed_id === entry.seed_id);
      expect(template).toMatchObject({
        key: entry.key,
        name: entry.name,
        icon: entry.icon,
        parent_key: entry.parent_key,
      });
      if (entry.parent_key) {
        const parentIndex = hybrid.findIndex((item) => item.key === entry.parent_key);
        expect(parentIndex).toBeGreaterThanOrEqual(0);
        expect(parentIndex).toBeLessThan(index);
        const siblings = hybrid.filter((item) => item.parent_key === entry.parent_key);
        expect(siblings.map((item) => item.sort_order)).toEqual(
          Array.from({ length: siblings.length }, (_, order) => order),
        );
      }
    }
  });

  it('目录名称、稳定种子与图标完整，批量模板保留全部130项', () => {
    expect(catalog.flat).toHaveLength(47);
    expect(catalog.hierarchical).toHaveLength(130);
    for (const items of [catalog.flat, catalog.hierarchical]) {
      expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
      expect(new Set(items.map((item) => item.seed_id)).size).toBe(items.length);
      for (const item of items) {
        expect(item.name).not.toMatch(/^(category|defaultCategory)|\?/);
        if (item.level === 2)
          expect(items.some((parent) => parent.key === item.parent_key && parent.level === 1)).toBe(true);
      }
    }
    expect(templatePlan(catalog.hierarchical, new Set(catalog.hierarchical.map((row) => row.key)), [])).toHaveLength(
      130,
    );
  });

  it('只选子分类补齐固定身份父分类，不使用随机 UUID', () => {
    const child = catalog.hierarchical.find((item) => item.level === 2)!;
    const parent = catalog.hierarchical.find((item) => item.key === child.parent_key)!;
    const plan = templatePlan(catalog.hierarchical, new Set([child.key]), []);
    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({ id: parent.seed_id, level: 1, name: parent.name });
    expect(plan[1]).toMatchObject({ id: child.seed_id, parent_id: parent.seed_id, name: child.name });
    expect(templatePlan(catalog.hierarchical, new Set([child.key]), [])).toEqual(plan);
  });

  it('159个官方身份跨语言一致，重命名或变更图标后再次应用仍不覆盖', () => {
    const official = [...catalog.flat, ...catalog.hierarchical];
    expect(new Set(official.map((item) => item.seed_id)).size).toBe(159);
    const translated = catalog.hierarchical.map((item) => ({ ...item, name: `Translated ${item.key}` }));
    const created = templatePlan(catalog.hierarchical, new Set(catalog.hierarchical.map((item) => item.key)), []);
    const saved = created.map((item) => ({
      ...category(item.id!, `改名 ${item.name}`, item.parent_id ?? null),
      icon: 'user-custom-icon',
      sort_order: 99,
    }));
    const before = structuredClone(saved);
    expect(templatePlan(translated, new Set(translated.map((item) => item.key)), saved)).toEqual([]);
    expect(saved).toEqual(before);
  });

  it('同名自定义父分类不认领身份、不挂接模板子分类，其余模板仍可添加', () => {
    const child = catalog.hierarchical.find((item) => item.level === 2)!;
    const parent = catalog.hierarchical.find((item) => item.key === child.parent_key)!;
    const unrelated = catalog.hierarchical.find((item) => item.level === 1 && item.key !== parent.key)!;
    const custom = category('custom-parent', parent.name);
    expect(existingTemplate(parent, [custom])).toBeUndefined();
    expect(templateBlockReason(parent, catalog.hierarchical, [custom])).toContain('同名');
    expect(templateBlockReason(child, catalog.hierarchical, [custom])).toContain('父分类同名');
    const plan = templatePlan(catalog.hierarchical, new Set([child.key, unrelated.key]), [custom]);
    expect(plan.map((item) => item.id)).toEqual([unrelated.seed_id]);
    expect(custom).toEqual(category('custom-parent', parent.name));
  });

  it('已改名的固定父身份可复用，不能把同父同名自定义子分类当作已添加', () => {
    const child = catalog.hierarchical.find((item) => item.level === 2)!;
    const parent = catalog.hierarchical.find((item) => item.key === child.parent_key)!;
    const renamed = category(parent.seed_id, '用户重命名');
    expect(existingTemplate(parent, [renamed])).toBe(renamed);
    const plan = templatePlan(catalog.hierarchical, new Set([child.key]), [renamed]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ id: child.seed_id, parent_id: renamed.id });
    const same = category('same-child', child.name, renamed.id);
    expect(existingTemplate(child, [renamed, same])).toBeUndefined();
    expect(templatePlan(catalog.hierarchical, new Set([child.key]), [renamed, same])).toEqual([]);
  });

  it('同名不同父级或不同层级不冲突，不修改已有引用', () => {
    const child = catalog.hierarchical.find((item) => item.level === 2)!;
    const parent = catalog.hierarchical.find((item) => item.key === child.parent_key)!;
    const existing = [
      category(parent.seed_id, '重命名父分类'),
      category('unrelated-child', child.name, 'other-parent'),
      category('unrelated-parent', child.name),
    ];
    const original = structuredClone(existing);
    expect(templateBlockReason(child, catalog.hierarchical, existing)).toBeNull();
    expect(templatePlan(catalog.hierarchical, new Set([child.key]), existing)).toMatchObject([
      { id: child.seed_id, parent_id: parent.seed_id },
    ]);
    expect(existing).toEqual(original);
  });

  it('固定父分类已改为二级时跳过依赖子项，不另造身份绕过用户修改', () => {
    const child = catalog.hierarchical.find((item) => item.level === 2)!;
    const parent = catalog.hierarchical.find((item) => item.key === child.parent_key)!;
    const moved = category(parent.seed_id, '移动后的父分类', 'custom-parent');
    expect(templateBlockReason(child, catalog.hierarchical, [moved])).toContain('层级');
    expect(templatePlan(catalog.hierarchical, new Set([parent.key, child.key]), [moved])).toEqual([]);
  });

  it('同名判断只去服务端定义的边缘空白，不按大小写或NFKC合并', () => {
    const item = catalog.flat[0]!;
    expect(templateBlockReason(item, catalog.flat, [category('custom', `\u0085 \uFEFF${item.name}\u3000`)])).toContain(
      '同名',
    );
    const latin = { ...item, name: 'Food' };
    expect(templateBlockReason(latin, [latin], [category('custom', 'food')])).toBeNull();
    expect(templateBlockReason(latin, [latin], [category('custom', 'Ｆｏｏｄ')])).toBeNull();
  });

  it('默认61项后两个模板都按固定身份补齐，重复应用没有可新增项', () => {
    const seeded = hybrid.map((item) => ({
      ...category(
        item.seed_id,
        item.name,
        item.parent_key ? hybrid.find((row) => row.key === item.parent_key)!.seed_id : null,
      ),
      icon: item.icon,
      sort_order: item.sort_order,
    }));
    for (const [items, count] of [
      [catalog.flat, 28],
      [catalog.hierarchical, 74],
    ] as const) {
      const selected = new Set(items.map((item) => item.key));
      const plan = templatePlan(items, selected, seeded);
      expect(plan).toHaveLength(count);
      const saved = plan.map((item) => category(item.id!, item.name, item.parent_id ?? null));
      expect(templatePlan(items, selected, [...seeded, ...saved])).toEqual([]);
      expect(new Set([...seeded, ...saved].map((item) => item.id)).size).toBe(61 + count);
    }
  });
});
