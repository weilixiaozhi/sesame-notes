import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api, request } from '../../api/client';
import type { ExerciseContent, FitnessContent, FitnessKind, Localized, TemplateContent } from './model';

export type TaxonomyKind = Parameters<typeof api.adminFitnessTaxonomies.list>[0];
export type TaxonomyRow = Awaited<ReturnType<typeof api.adminFitnessTaxonomies.list>>['items'][number];
export const taxonomyLabels: Record<TaxonomyKind, string> = { body_part: '部位', equipment: '器械' };
export const taxonomyFormSchema = z.object({
  name: z.object({
    zh: z.string().trim().min(1, '请填写简体中文名称。').max(100, '名称最多 100 个字符。'),
    zh_hant: z.string().trim().min(1, '请填写繁体中文名称。').max(100, '名称最多 100 个字符。'),
    en: z.string().trim().min(1, '请填写英文名称。').max(100, '名称最多 100 个字符。'),
  }),
  sort_order: z.number().int('排序需填写整数。').min(0, '排序不能小于 0。').max(9999, '排序不能超过 9999。'),
});

/** 分类目录与内容共享缓存前缀，增删改后所有列表、预览和编辑选项一起更新。 */
export function useTaxonomies(kind: TaxonomyKind, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'fitness', 'taxonomies', kind],
    enabled,
    queryFn: ({ signal }) =>
      request<{ items: TaxonomyRow[] }>(() => api.adminFitnessTaxonomies.list(kind, signal), `fitness-${kind}-list`),
  });
}

/** 选项仅包含未删除的同类型分类，不把残留历史值作为可用选项。 */
export function availableTaxonomies(rows: TaxonomyRow[] | undefined, kind: TaxonomyKind): TaxonomyRow[] {
  return rows?.filter((row) => row.kind === kind && !row.is_deleted) ?? [];
}

/** 多语言预览使用目录中的对应名称，未知资料显示缺失提示。 */
export function taxonomyName(rows: TaxonomyRow[] | undefined, id: string, language: keyof Localized = 'zh'): string {
  const row = rows?.find((entry) => entry.id === id);
  if (!row) return '分类资料暂不可用';
  return row.is_deleted ? `${row.name[language]}（已删除）` : row.name[language];
}

/** 保存前核对动态分类，防止长期打开的编辑器把已删除分类重新写回内容。 */
export function taxonomyContentError(
  kind: FitnessKind,
  content: FitnessContent,
  bodyParts: TaxonomyRow[],
  equipment: TaxonomyRow[],
): string | null {
  const bodyIds = new Set(availableTaxonomies(bodyParts, 'body_part').map((row) => row.id));
  const equipmentIds = new Set(availableTaxonomies(equipment, 'equipment').map((row) => row.id));
  if (kind === 'exercise') {
    const value = content as ExerciseContent;
    if (!bodyIds.has(value.body_part)) return '请选择当前可用的部位。';
    if (!equipmentIds.has(value.equipment)) return '请选择当前可用的器械。';
  }
  if (kind === 'template' && (content as TemplateContent).equipment.some((id) => !equipmentIds.has(id))) {
    return '所选器械已不可用，请移除后重新选择。';
  }
  return null;
}

/** 已被动作或模板使用的分类必须迁移到同类型有效分类，避免产生悬空引用。 */
export function taxonomyReplacementError(row: TaxonomyRow, replacement: string, rows: TaxonomyRow[]): string | null {
  if (row.exercise_count + row.template_count === 0 && !replacement) return null;
  const valid = availableTaxonomies(rows, row.kind).some(
    (candidate) => candidate.id === replacement && candidate.id !== row.id,
  );
  return valid ? null : '请选择同类型的有效替代项，已有动作和模板将迁移到该项。';
}
