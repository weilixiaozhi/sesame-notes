// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  availableTaxonomies,
  taxonomyContentError,
  taxonomyFormSchema,
  taxonomyName,
  taxonomyReplacementError,
} from './taxonomy-data';
import type { TaxonomyKind, TaxonomyRow } from './taxonomy-data';
import { newContent } from './model';
import type { ExerciseContent } from './model';

/** 使用服务端目录样例，分类身份无需属于预置枚举。 */
function category(id: string, kind: TaxonomyKind, changes: Partial<TaxonomyRow> = {}): TaxonomyRow {
  return {
    id,
    kind,
    name: { zh: `分类${id}`, zh_hant: `分類${id}`, en: `Category ${id}` },
    sort_order: 1,
    version: 2,
    is_deleted: false,
    exercise_count: 0,
    template_count: 0,
    ...changes,
  };
}
const body = category('new-body', 'body_part');
const equipment = category('new-equipment', 'equipment');

describe('动态部位和器械目录', () => {
  it('同类型未删除目录才可被选择，历史名称使用当前目录多语言值', () => {
    const deleted = category('removed', 'body_part', { is_deleted: true });
    expect(availableTaxonomies([body, equipment, deleted], 'body_part')).toEqual([body]);
    expect(taxonomyName([body], body.id, 'en')).toBe('Category new-body');
    expect(taxonomyName([deleted], deleted.id)).toContain('已删除');
    expect(taxonomyName([], 'private-id')).toBe('分类资料暂不可用');
    expect(taxonomyFormSchema.safeParse({ name: body.name, sort_order: 9999 }).success).toBe(true);
    expect(taxonomyFormSchema.safeParse({ name: { ...body.name, zh: ' ' }, sort_order: 0 }).success).toBe(false);
    expect(taxonomyFormSchema.safeParse({ name: body.name, sort_order: 10000 }).success).toBe(false);
  });

  it('保存内容拒绝已删目录，有引用删除必须替换为同类型有效分类', () => {
    const exercise = { ...newContent('exercise'), body_part: body.id, equipment: equipment.id } as ExerciseContent;
    expect(taxonomyContentError('exercise', exercise, [body], [equipment])).toBeNull();
    expect(taxonomyContentError('exercise', exercise, [{ ...body, is_deleted: true }], [equipment])).toContain('部位');
    const referenced = { ...body, exercise_count: 1 };
    expect(taxonomyReplacementError(referenced, '', [body, equipment])).toContain('替代项');
    expect(taxonomyReplacementError(referenced, equipment.id, [body, equipment])).toContain('替代项');
    expect(taxonomyReplacementError(referenced, body.id, [body])).toContain('替代项');
    expect(taxonomyReplacementError(referenced, 'other', [category('other', 'body_part')])).toBeNull();
    expect(taxonomyReplacementError(body, '', [body])).toBeNull();
  });
});
