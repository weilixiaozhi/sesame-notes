import type { SelectedTable } from '../../../lib/transfer/table';
import type { Snapshot, TransferMapping } from './transfer-schema';

export type CategoryImportChoice = { kind: 'existing'; id: string } | { kind: 'new' };
export type CategoryImportChoices = Record<string, CategoryImportChoice>;
export type CategoryImportSource = {
  key: string;
  name: string;
  icon: string | null;
  parentKey: string | null;
  label: string;
  scope: string;
  sourceId: string;
  rows: number[];
};
export type CategorySourceCatalog = {
  sources: Map<string, CategoryImportSource>;
  rowKeys: Array<string | null>;
};
const categoryHashFields = [
  'date',
  'type',
  'amount',
  'currency',
  'category',
  'sub_category',
  'category_icon',
  'sub_category_icon',
  'category_scope',
  'category_id',
  'parent_category_id',
  'note',
] as const;

/** 与手机的 Unicode 首尾空白规则对齐，保证相同文件跨端生成相同来源身份。 */
function trimmedCell(value: string): string {
  return value.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, '');
}

/** 分类来源指纹使用跨端统一的字段顺序，交易导入身份单独计算。 */
async function categoryFileHash(table: SelectedTable, mapping: TransferMapping): Promise<string> {
  try {
    const rows = table.rows.map((row) =>
      categoryHashFields.map((key) => {
        const value = mapping[key] ? trimmedCell(row[table.headers.indexOf(mapping[key])] ?? '') : '';
        return key === 'type' && !value ? 'expense' : value;
      }),
    );
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch (cause) {
    throw new Error('无法读取分类来源，请重新选择文件', { cause });
  }
}

/** 来源身份包含所属目录；缺少身份的旧文件逐行保留，禁止按同名吞并来源。 */
export async function categoryImportSources(
  table: SelectedTable,
  mapping: TransferMapping,
): Promise<CategorySourceCatalog> {
  try {
    const hash = await categoryFileHash(table, mapping);
    const sources = new Map<string, CategoryImportSource>();
    const rowKeys: Array<string | null> = [];
    for (let index = 0; index < table.rows.length; index += 1) {
      const row = table.rows[index]!;
      const cell = (key: keyof TransferMapping) =>
        mapping[key] ? trimmedCell(row[table.headers.indexOf(mapping[key])] ?? '') : '';
      const top = cell('category');
      const sub = cell('sub_category');
      if (!top && !sub && !cell('category_id')) {
        rowKeys.push(null);
        continue;
      }
      const scope = cell('category_scope');
      const sourceId = cell('category_id');
      const parentId = cell('parent_category_id');
      if (sourceId && sourceId === parentId) throw new Error(`第 ${index + 2} 行分类不能将自身作为父分类`);
      const key =
        scope && sourceId
          ? JSON.stringify(['category', scope, sourceId])
          : JSON.stringify(['category-row', hash, index]);
      const parentKey = sub
        ? scope && parentId
          ? JSON.stringify(['category', scope, parentId])
          : JSON.stringify(['category-parent', key])
        : null;
      const entries: CategoryImportSource[] = [];
      if (parentKey)
        entries.push({
          key: parentKey,
          name: top,
          icon: cell('category_icon') || null,
          parentKey: null,
          label: top,
          scope,
          sourceId: parentId,
          rows: [index + 2],
        });
      entries.push({
        key,
        name: sub || top,
        icon: cell(sub ? 'sub_category_icon' : 'category_icon') || null,
        parentKey,
        label: [top, sub].filter(Boolean).join(' / '),
        scope,
        sourceId,
        rows: [index + 2],
      });
      for (const source of entries) {
        const previous = sources.get(source.key);
        if (
          previous &&
          (previous.name !== source.name || previous.icon !== source.icon || previous.parentKey !== source.parentKey)
        )
          throw new Error(`第 ${index + 2} 行的同一分类来源包含不一致内容，请检查文件`);
        if (previous) previous.rows.push(index + 2);
        else sources.set(source.key, source);
      }
      rowKeys.push(key);
    }
    return { sources, rowKeys };
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : '分类来源无法解析', { cause });
  }
}

/** 分类新建身份与手机一致；相同来源导入同一目标账本时保持稳定。 */
export async function categoryImportId(targetLedgerId: string, sourceKey: string): Promise<string> {
  try {
    const value = JSON.stringify(['category-import', targetLedgerId, sourceKey]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).slice(0, 16);
    digest[6] = (digest[6]! & 0x0f) | 0x40;
    digest[8] = (digest[8]! & 0x3f) | 0x80;
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch (cause) {
    throw new Error('无法生成导入分类身份，请重试', { cause });
  }
}

/** 共享账本使用其所有者的目录身份，不能使用当前查看者账号代替。 */
export function categoryTargetScope(snapshot: Snapshot): string | null {
  return snapshot.ledger.owner_id ? `account:${snapshot.ledger.owner_id}` : null;
}
