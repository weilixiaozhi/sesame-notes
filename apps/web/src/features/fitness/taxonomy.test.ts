import { describe, expect, it } from 'vitest';
import type { Catalog } from './fitness-types';
import { isTaxonomyDirectory, taxonomyChoices, taxonomyEntries, taxonomyLabels } from './taxonomy';

const catalog: Catalog = {
  exercises: [],
  taxonomies: {
    body_parts: [
      { id: 'chest', name: { zh: '胸部训练', zh_hant: '胸部訓練', en: 'Chest training' }, is_deleted: false },
      { id: 'custom-region', name: { zh: '复合训练', zh_hant: '複合訓練', en: 'Compound' }, is_deleted: false },
      { id: 'retired', name: { zh: '旧部位', zh_hant: '舊部位', en: 'Retired' }, is_deleted: true },
    ],
    equipment: [
      { id: 'custom-machine', name: { zh: '综合器械', zh_hant: '綜合器械', en: 'Machine' }, is_deleted: false },
    ],
  },
};

describe('跨端部位与器械目录', () => {
  it('改名使用后台名称，新增分类可选，已删除项只为历史提供标签', () => {
    expect(taxonomyLabels(catalog, 'body_parts').chest).toBe('胸部训练');
    expect(taxonomyLabels(catalog, 'body_parts').retired).toBe('旧部位');
    expect(taxonomyChoices(catalog, 'body_parts').map((entry) => entry.id)).toEqual(['chest', 'custom-region']);
    expect(taxonomyChoices(catalog, 'body_parts', 'retired').map((entry) => entry.id)).toContain('retired');
    expect(taxonomyChoices(catalog, 'equipment').map((entry) => entry.id)).toEqual(['custom-machine']);
  });

  it('原记录的未知分类可保留，编辑其他字段不自动换归属', () => {
    expect(taxonomyChoices(catalog, 'body_parts', 'legacy').at(-1)).toMatchObject({ id: 'legacy', is_deleted: true });
  });

  it('无在线目录可用时兼容内置名称，服务端空目录不会复活已删除分类', () => {
    expect(taxonomyLabels(undefined, 'body_parts').chest).toBe('胸部');
    expect(taxonomyEntries({ exercises: [], taxonomies: { body_parts: [], equipment: [] } }, 'body_parts')).toEqual([]);
  });

  it('损坏和重复标识不能替换离线快照', () => {
    expect(isTaxonomyDirectory(catalog.taxonomies)).toBe(true);
    expect(isTaxonomyDirectory(undefined)).toBe(false);
    expect(isTaxonomyDirectory({ body_parts: [] })).toBe(false);
    expect(isTaxonomyDirectory({ ...catalog.taxonomies, body_parts: [null] })).toBe(false);
    expect(
      isTaxonomyDirectory({
        ...catalog.taxonomies,
        body_parts: [catalog.taxonomies!.body_parts[0], catalog.taxonomies!.body_parts[0]],
      }),
    ).toBe(false);
  });
});
