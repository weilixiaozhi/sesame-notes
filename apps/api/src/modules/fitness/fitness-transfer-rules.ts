import { ApiError } from '../../shared/errors.js';
import { uuidV5 } from '../../shared/uuid.js';
import { validateFitnessPayload } from './fitness-rules.js';
import type { FitnessEntityType, FitnessPreferencesPayload } from './fitness-schemas.js';

export type TransferRecord = { id: string; entity_type: FitnessEntityType; payload: Record<string, unknown> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** 对齐移动端导入命名空间，映射全部嵌套标识并保留未随文件导出的引用身份。 */
export function prepareFitnessImport(
  records: TransferRecord[],
  targetSpaceId: string,
  exportId: string,
  targetPreferences: FitnessPreferencesPayload | null,
  officialIds?: ReadonlySet<string>,
) {
  const namespace = uuidV5(URL_NAMESPACE, `fitness-import:${targetSpaceId}:${exportId}`);
  const byId = new Map<string, TransferRecord>();
  let preferences = 0;
  let running = 0;
  for (const record of records) {
    if (!UUID.test(record.id) || byId.has(record.id))
      throw new ApiError(400, 'FITNESS_IMPORT_ID', '文件包含重复或无效记录标识');
    validateFitnessPayload(record.entity_type, record.payload, officialIds);
    if (record.entity_type === 'fitness_preferences' && ++preferences > 1)
      throw new ApiError(400, 'FITNESS_IMPORT_PREFERENCES', '文件只能有一份偏好');
    if (record.entity_type === 'fitness_workout' && record.payload.status === 'in_progress' && ++running > 1)
      throw new ApiError(400, 'FITNESS_IMPORT_RUNNING', '文件包含多个进行中的训练');
    if (
      record.entity_type === 'fitness_workout' &&
      typeof record.payload.occurrence_key === 'string' &&
      uuidV5(record.payload.source_plan_id as string, record.payload.occurrence_key) !== record.id
    )
      throw new ApiError(400, 'FITNESS_IMPORT_OCCURRENCE', '计划训练标识与计划发生键不一致');
    byId.set(record.id, record);
  }
  const ids = new Map<string, string>();
  const targetCustom = targetPreferences?.custom_exercises ?? [];
  const sourceCustom = new Set(targetCustom.map((item) => item.id));
  for (const record of records) {
    ids.set(record.id, record.entity_type === 'fitness_preferences' ? targetSpaceId : uuidV5(namespace, record.id));
    if (record.entity_type === 'fitness_preferences')
      for (const item of record.payload.custom_exercises as Array<{ id: string }>) sourceCustom.add(item.id);
  }
  /** 遍历结构化字段，只映射标识字段，不改写用户正文或名称中偶然相同的字符。 */
  function collect(node: unknown, field?: string): void {
    if (Array.isArray(node)) {
      node.forEach((value) => collect(value, field));
      return;
    }
    if (!node || typeof node !== 'object') {
      if (
        typeof node === 'string' &&
        node.startsWith('custom:') &&
        (field === 'exercise_id' || field === 'pinned_exercise_ids')
      )
        customReference(node);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'id' || key === 'source_plan_id' || key === 'source_template_id') && typeof value === 'string') {
        if (!ids.has(value))
          ids.set(value, value.startsWith('custom:') ? `custom:${uuidV5(namespace, value)}` : uuidV5(namespace, value));
        const source = byId.get(value);
        if (
          source &&
          key !== 'id' &&
          source.entity_type !== (key === 'source_plan_id' ? 'fitness_plan' : 'fitness_template')
        )
          throw new ApiError(400, 'FITNESS_IMPORT_REFERENCE', '文件中的模板或计划引用类型错误');
      }
      if ((field === 'exercise_rest_settings' || field === 'exercise_weight_modes') && key.startsWith('custom:'))
        customReference(key);
      if (key === 'occurrence_key' && typeof value === 'string')
        for (const part of value.split(':'))
          if (UUID.test(part) && !ids.has(part)) ids.set(part, uuidV5(namespace, part));
      collect(value, key);
    }
  }
  /** 同一文件分批导入时，允许引用前批已重映射并保存的自定义动作。 */
  function customReference(id: string): void {
    const imported = `custom:${uuidV5(namespace, id)}`;
    if (targetCustom.some((item) => item.id === imported)) ids.set(id, imported);
    else if (!sourceCustom.has(id))
      throw new ApiError(400, 'FITNESS_IMPORT_CUSTOM_MISSING', '文件引用的自定义动作缺少定义');
  }
  for (const record of records) collect(record.payload);
  for (const record of records) {
    if (record.entity_type === 'fitness_workout' && typeof record.payload.occurrence_key === 'string') {
      const key = record.payload.occurrence_key
        .split(':')
        .map((part) => ids.get(part) ?? part)
        .join(':');
      ids.set(record.id, uuidV5(ids.get(record.payload.source_plan_id as string)!, key));
    }
  }
  /** 递归映射自定义动作、休息计时引用、计划发生键及偏好键。 */
  function remap(node: unknown, field?: string): unknown {
    if (Array.isArray(node)) return node.map((value) => remap(value, field));
    if (node && typeof node === 'object')
      return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [
          field === 'exercise_rest_settings' || field === 'exercise_weight_modes' ? (ids.get(key) ?? key) : key,
          remap(value, key),
        ]),
      );
    if (
      typeof node === 'string' &&
      ['id', 'source_plan_id', 'source_template_id', 'exercise_id', 'set_id', 'pinned_exercise_ids'].includes(
        field ?? '',
      )
    )
      return ids.get(node) ?? node;
    if (typeof node === 'string' && field === 'occurrence_key')
      return node
        .split(':')
        .map((part) => ids.get(part) ?? part)
        .join(':');
    return node;
  }
  const prepared = records.map((record) => {
    const payload = remap(record.payload) as Record<string, unknown>;
    if (record.entity_type === 'fitness_preferences') {
      const merged = new Map(targetCustom.map((item) => [item.id, item]));
      for (const item of payload.custom_exercises as FitnessPreferencesPayload['custom_exercises'])
        merged.set(item.id, item);
      payload.custom_exercises = [...merged.values()];
    }
    return { ...record, id: ids.get(record.id)!, payload };
  });
  const rank: Record<FitnessEntityType, number> = {
    fitness_preferences: 0,
    fitness_template: 1,
    fitness_plan: 2,
    fitness_workout: 3,
  };
  prepared.sort((a, b) => rank[a.entity_type] - rank[b.entity_type] || a.id.localeCompare(b.id));
  return {
    records: prepared,
    ids: Object.fromEntries(records.map((record) => [record.id, ids.get(record.id)!])),
    namespace,
  };
}
