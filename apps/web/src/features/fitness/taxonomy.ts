import type { Catalog, FitnessTaxon } from './fitness-types';
import { bodyPartLabels, equipmentLabels } from './preferences-model';

type TaxonomyKind = 'body_parts' | 'equipment';

/** 离线内置资源使用本地名称；已有目录以发布内容为准，包括空目录。 */
export function taxonomyEntries(catalog: Catalog | undefined, kind: TaxonomyKind): FitnessTaxon[] {
  if (catalog?.taxonomies) return catalog.taxonomies[kind];
  const fallback = kind === 'body_parts' ? bodyPartLabels : equipmentLabels;
  return Object.entries(fallback).map(([id, zh]) => ({ id, name: { zh, zh_hant: zh, en: id }, is_deleted: false }));
}

/** 已删除分类继续提供名称，避免历史训练与自定义动作丢失可读标签。 */
export function taxonomyLabels(catalog: Catalog | undefined, kind: TaxonomyKind): Record<string, string> {
  const labels = Object.create(null) as Record<string, string>;
  for (const entry of taxonomyEntries(catalog, kind)) labels[entry.id] = entry.name.zh;
  return labels;
}

/** 新选择只展示可用分类；原记录的旧值保留为当前选项，保存其他字段不会篡改历史归属。 */
export function taxonomyChoices(catalog: Catalog | undefined, kind: TaxonomyKind, current?: string): FitnessTaxon[] {
  const entries = taxonomyEntries(catalog, kind);
  const choices = entries.filter((entry) => !entry.is_deleted || entry.id === current);
  if (current && !choices.some((entry) => entry.id === current))
    choices.push({ id: current, name: { zh: current, zh_hant: current, en: current }, is_deleted: true });
  return choices;
}

/** 分类快照必须完整、唯一且字段类型有效，损坏响应不能覆盖离线目录。 */
export function isTaxonomyDirectory(value: unknown): value is NonNullable<Catalog['taxonomies']> {
  if (!value || typeof value !== 'object') return false;
  return ['body_parts', 'equipment'].every((kind) => {
    const entries = (value as Record<string, unknown>)[kind];
    if (!Array.isArray(entries)) return false;
    const ids = new Set<string>();
    return entries.every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 100 || ids.has(item.id)) return false;
      if (typeof item.is_deleted !== 'boolean' || !item.name || typeof item.name !== 'object') return false;
      const names = item.name as Record<string, unknown>;
      if (!['zh', 'zh_hant', 'en'].every((key) => typeof names[key] === 'string' && names[key].trim().length > 0))
        return false;
      ids.add(item.id);
      return true;
    });
  });
}
