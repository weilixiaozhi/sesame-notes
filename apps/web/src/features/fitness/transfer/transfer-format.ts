import type { paths } from '@sesame-notes/api-client';
import { parseCsvTable } from '../../../lib/delimited-text';
import { assertUniqueJsonKeys } from '../../../lib/transfer/json';
import { validDate, validWeight, type Catalog } from '../fitness-model';
import { preferencesPayload } from '../preferences-model';

type Change = paths['/api/v1/sync/push']['post']['requestBody']['content']['application/json']['changes'][number];
type FitnessChange = Extract<
  Change,
  { entity_type: 'fitness_template' | 'fitness_plan' | 'fitness_workout' | 'fitness_preferences'; action: 'upsert' }
>;
// 文件记录借用生成契约的判别联合，不另行定义 HTTP 载荷。
export type TransferRecord = {
  [K in FitnessChange['entity_type']]: {
    id: string;
    entity_type: K;
    payload: Extract<FitnessChange, { entity_type: K }>['payload'];
  };
}[FitnessChange['entity_type']];
export const maxTransferBytes = 64 * 1024 * 1024;
export const transferFields = [
  ['entity_type', '数据类型', 'type'],
  ['name', '名称', '计划名称', '训练名称', 'title'],
  ['day', '训练日'],
  ['day_index', '训练日序号（从 0 开始）'],
  ['cycle_days', '循环天数'],
  ['exercise', '动作', 'exercise_id', '动作名称'],
  ['weight', '重量'],
  ['weight_left', '左侧重量'],
  ['weight_right', '右侧重量'],
  ['reps', '次数'],
  ['set_count', '组数', 'sets_count'],
  ['kind', '组类型'],
  ['rest_seconds', '休息秒数'],
  ['warmup_rest_seconds', '热身休息秒数'],
  ['scheduled_date', '训练日期', 'date', '日期'],
  ['start_date', '计划开始日期'],
  ['status', '状态'],
  ['completed', '完成'],
  ['exercises', '动作与组'],
  ['sets', '组明细'],
  ['slot', '训练安排'],
  ['days', '训练日安排'],
  ['generation_state', '计划执行状态'],
  ['pending_schedule', '待生效安排'],
  ['catalog_origin', '官方来源'],
  ['source_kind', '训练来源'],
  ['source_plan_id', '关联计划'],
  ['source_plan_name', '关联计划名称'],
  ['source_template_id', '关联模板'],
  ['occurrence_key', '计划发生标识'],
  ['run_segments', '执行时段'],
  ['rest_timer', '计时状态'],
  ['preferences', '健身偏好'],
  ['id', '记录关联标识'],
  ['created_at', '创建时间'],
  ['updated_at', '修改时间'],
] as const;
type FieldKey = (typeof transferFields)[number][0];
export type FieldMapping = Partial<Record<FieldKey, string>>;
export type TransferTable = { headers: string[]; rows: Record<string, unknown>[]; format: 'json' | 'csv' };
export type TransferPreview = { exportId: string; records: TransferRecord[]; warnings: string[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 身份只由源内容决定，刷新预览和勾选子集不会生成新的来源身份。 */
export async function transferId(value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  return formatUuid(bytes);
}

/** 计划训练发生键按移动端相同 UUID v5 算法生成，保持关系身份合法。 */
async function occurrenceId(namespace: string, value: string): Promise<string> {
  const ns = Uint8Array.from(namespace.replaceAll('-', '').match(/../g)!, (hex) => Number.parseInt(hex, 16));
  const name = new TextEncoder().encode(value);
  const input = new Uint8Array(ns.length + name.length);
  input.set(ns);
  input.set(name, ns.length);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  return formatUuid(bytes);
}

/** 将十六字节摘要序列化为标准 UUID 文本。 */
function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 忽略表头大小写和常见分隔字符，歧义表头仍需手工映射。 */
const normalized = (text: string) => text.toLowerCase().replace(/[\s_\-（）()]/g, '');

/** 解析移动端原生 JSON 或严格 CSV，拒绝重复键、身份包装和静默截断。 */
export function parseTransferTable(text: string): TransferTable {
  if (new TextEncoder().encode(text).byteLength > maxTransferBytes) throw new Error('文件不能超过 64 MiB。');
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (clean.startsWith('[') || clean.startsWith('{')) {
    assertUniqueJsonKeys(clean);
    const value: unknown = JSON.parse(clean);
    if (!Array.isArray(value)) throw new Error('健身 JSON 应为客户端导出的业务对象数组。');
    const rows = value.map((row) => object(row, '记录'));
    return { headers: [...new Set(rows.flatMap((row) => Object.keys(row)))], rows, format: 'json' };
  }
  const csv = parseCsvTable(text);
  return {
    headers: csv.headers,
    rows: csv.rows.map((row) => Object.fromEntries(csv.headers.map((header, index) => [header, row[index]!]))),
    format: 'csv',
  };
}

/** 每个业务字段只有唯一匹配时才自动选择，保留用户决定。 */
export function detectTransferMapping(headers: string[]): FieldMapping {
  return Object.fromEntries(
    transferFields.map(([key, ...aliases]) => {
      const names = new Set([key, ...aliases].map(normalized));
      const matches = headers.filter((header) => names.has(normalized(header)));
      return [key, matches.length === 1 ? matches[0]! : ''];
    }),
  );
}

/** 结构字段可能来自 CSV JSON 单元格，解析前同样排除重复键。 */
function structured(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value === '' ? undefined : value;
  assertUniqueJsonKeys(value);
  return JSON.parse(value);
}

/** 文件节点只接受普通对象，避免宽松转换吞掉损坏的数据。 */
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}应为对象。`);
  return value as Record<string, unknown>;
}

/** 使用整数上限与移动端一致，拒绝指数、负数和小数。 */
function integer(value: unknown, name: string, fallback?: number, min = 0, max = 2147483647): number {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  if (!/^\d+$/.test(String(raw))) throw new Error(`${name}需为整数。`);
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name}超出允许范围。`);
  return number;
}

/** 日期按自然日验证，不用浏览器时区修正错误日期。 */
function date(value: unknown, name: string): string {
  const raw = String(value ?? '').replaceAll('/', '-');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  const result = match ? `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}` : raw;
  if (!validDate(result)) throw new Error(`${name}需为有效的 YYYY-MM-DD 日期。`);
  return result;
}

/** 时间必须可验证，纯日期严格保留自然日，其余转为毫秒 UTC。 */
function timestamp(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value);
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(raw)) return `${date(raw, '时间')}T00:00:00.000Z`;
  const result = new Date(raw);
  if (!Number.isFinite(result.getTime())) throw new Error('创建或修改时间无效。');
  return result.toISOString();
}

/** 接受表格常用布尔值，不将未知文本当成 false。 */
function boolean(value: unknown): boolean {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['', 'false', '0', '否'].includes(raw)) return false;
  if (['true', '1', '是'].includes(raw)) return true;
  throw new Error('完成状态需为 true/false 或 是/否。');
}

/** 数据类型只接受约定的字符串名称；缺失字段使用与移动端一致的默认计划。 */
function entityType(value: unknown): TransferRecord['entity_type'] {
  const names: Record<string, TransferRecord['entity_type']> = {
    模板: 'fitness_template',
    template: 'fitness_template',
    fitness_template: 'fitness_template',
    计划: 'fitness_plan',
    plan: 'fitness_plan',
    fitness_plan: 'fitness_plan',
    训练: 'fitness_workout',
    记录: 'fitness_workout',
    workout: 'fitness_workout',
    fitness_workout: 'fitness_workout',
    偏好: 'fitness_preferences',
    preferences: 'fitness_preferences',
    fitness_preferences: 'fitness_preferences',
  };
  const name = value ?? 'fitness_plan';
  const type = typeof name === 'string' && Object.hasOwn(names, name.trim()) ? names[name.trim()] : undefined;
  if (!type) throw new Error('数据类型应为计划、模板、训练或偏好。');
  return type;
}

/** 收集尚未匹配的动作供用户明确映射，不在后台猜测相似名称。 */
export function transferExerciseNames(table: TransferTable, mapping: FieldMapping): string[] {
  const result = new Set<string>();
  function visit(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'exercise' || key === 'exercise_id') && typeof entry === 'string') result.add(entry);
      if (['days', 'exercises', 'pending_schedule', 'slot'].includes(key)) visit(structured(entry));
    }
  }
  for (const source of table.rows) {
    const row = mappedTransferRow(source, mapping);
    visit(row);
  }
  return [...result].filter(Boolean);
}

/** 精确名称唯一匹配才识别动作，动作 ID 和自定义动作 ID 原样保留。 */
export function detectTransferExercise(
  raw: string,
  catalog: Catalog,
  customIds: Set<string> = new Set(),
): string | undefined {
  if (customIds.has(raw) || catalog.exercises.some((exercise) => exercise.id === raw)) return raw;
  const matches = catalog.exercises.filter((exercise) =>
    [exercise.name_zh, exercise.name_en].some((name) => normalized(name) === normalized(raw)),
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/** 只映射当前源记录实际包含的字段，稀疏 JSON 不能把原型属性当作缺失单元格。 */
function mappedTransferRow(source: Record<string, unknown>, mapping: FieldMapping): Record<string, unknown> {
  return Object.fromEntries(
    transferFields.flatMap(([key]) => {
      const header = mapping[key];
      const value = header && Object.hasOwn(source, header) ? source[header] : undefined;
      return value === undefined || value === '' ? [] : [[key, value]];
    }),
  );
}

/** 构造完整预览；同一父项的平面 CSV 行合并为组，所有身份与选择无关。 */
export async function buildTransferPreview(
  table: TransferTable,
  mapping: FieldMapping,
  catalog: Catalog,
  exerciseMapping: Record<string, string>,
  now: string,
): Promise<TransferPreview> {
  const rows = table.rows.map((source) => mappedTransferRow(source, mapping));
  // 与客户端 transferFields 的顺序及缺省值对齐，同一原生文件跨端具有相同的来源身份。
  const mobileFieldOrder = [
    'entity_type',
    'name',
    'day',
    'day_index',
    'cycle_days',
    'exercise',
    'weight',
    'weight_left',
    'weight_right',
    'reps',
    'set_count',
    'kind',
    'rest_seconds',
    'scheduled_date',
    'start_date',
    'status',
    'completed',
    'exercises',
    'sets',
    'slot',
    'days',
    'generation_state',
    'pending_schedule',
    'catalog_origin',
    'source_kind',
    'source_plan_id',
    'source_plan_name',
    'source_template_id',
    'occurrence_key',
    'run_segments',
    'rest_timer',
    'preferences',
    'id',
    'created_at',
    'updated_at',
  ];
  const mobileDefaults: Record<string, string> = {
    entity_type: 'fitness_plan',
    day: '1',
    set_count: '1',
    kind: 'working',
    rest_seconds: '90',
    completed: 'false',
  };
  const exportId = await transferId(
    rows.map((row) =>
      Object.fromEntries(mobileFieldOrder.map((key) => [key, row[key] ?? mobileDefaults[key] ?? null])),
    ),
  );
  const customIds = new Set<string>();
  for (const row of rows) {
    if (row.preferences !== undefined) {
      const prefs = object(structured(row.preferences), '健身偏好');
      if (Array.isArray(prefs.custom_exercises))
        for (const item of prefs.custom_exercises) customIds.add(String(object(item, '自定义动作').id));
    }
  }
  const groups = new Map<string, { rows: Record<string, unknown>[]; index: number }>();
  rows.forEach((row, index) => {
    const key =
      row.days !== undefined || row.exercises !== undefined || row.preferences !== undefined
        ? `record:${index}`
        : JSON.stringify([entityType(row.entity_type), row.id ?? row.name, row.scheduled_date]);
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { rows: [row], index });
  });
  const references = new Map<string, Promise<string>>();
  const reference = (value: unknown) => {
    const raw = String(value);
    if (uuid.test(raw)) return Promise.resolve(raw.toLowerCase());
    let result = references.get(raw);
    if (!result) {
      result = transferId(['fitness-reference', raw]);
      references.set(raw, result);
    }
    return result;
  };
  const exerciseId = (value: unknown) => {
    const raw = String(value ?? '');
    const resolved =
      (Object.hasOwn(exerciseMapping, raw) ? exerciseMapping[raw] : undefined) ||
      detectTransferExercise(raw, catalog, customIds) ||
      (raw.startsWith('custom:') && uuid.test(raw.slice(7)) ? raw : undefined);
    if (!resolved) throw new Error(`动作「${raw || '未填写'}」未匹配，请选择对应动作。`);
    return resolved;
  };
  async function exercise(
    row: Record<string, unknown>,
    seed: string,
    execution: boolean,
  ): Promise<Record<string, unknown>> {
    const rawSets =
      row.sets === undefined
        ? Array.from({ length: integer(row.set_count, '组数', 1, 1, 1000) }).fill(row)
        : structured(row.sets);
    if (!Array.isArray(rawSets) || rawSets.length > 1000) throw new Error('组明细应为不超过 1000 组的数组。');
    const sets = await Promise.all(
      rawSets.map(async (input, index) => {
        const set = object(input, '训练组');
        const weight = (key: string) => {
          const value = set[key];
          const result = value === undefined || value === null || value === '' ? null : String(value);
          if (!validWeight(result)) throw new Error('重量需为非负十进制文本，最多 18 位整数和 10 位小数。');
          return result;
        };
        const total = weight('weight');
        const left = weight('weight_left');
        const right = weight('weight_right');
        if (total !== null && (left !== null || right !== null)) throw new Error('同一组不能混合总重和左右重量。');
        const kind =
          ({ 热身: 'warmup', 正式: 'working' } as Record<string, string>)[String(set.kind)] ?? set.kind ?? 'working';
        if (kind !== 'warmup' && kind !== 'working') throw new Error('组类型需为热身或正式。');
        const completed = execution && boolean(set.completed);
        const reps =
          set.reps === undefined || set.reps === null || set.reps === ''
            ? null
            : integer(set.reps, '次数', undefined, 1);
        if (completed && (reps === null || (left === null) !== (right === null)))
          throw new Error('完成组需填写次数，左右重量需成对填写。');
        return {
          id: set.id ? await reference(set.id) : await transferId([seed, 'set', index]),
          kind,
          weight: total,
          weight_left: left,
          weight_right: right,
          reps,
          ...(execution ? { completed, rest_durations_seconds: structured(set.rest_durations_seconds) ?? [] } : {}),
        };
      }),
    );
    return {
      id: row.id ? await reference(row.id) : await transferId([seed, 'exercise']),
      exercise_id: exerciseId(row.exercise ?? row.exercise_id),
      rest_seconds: integer(row.rest_seconds, '休息秒数', 90),
      warmup_rest_seconds:
        row.warmup_rest_seconds == null || row.warmup_rest_seconds === ''
          ? null
          : integer(row.warmup_rest_seconds, '热身休息秒数'),
      sets,
    };
  }
  async function exercises(value: unknown, seed: string, execution: boolean): Promise<Record<string, unknown>[]> {
    const list = structured(value);
    if (!Array.isArray(list) || list.length > 1000) throw new Error('动作与组应为不超过 1000 个动作的数组。');
    return Promise.all(list.map((item, index) => exercise(object(item, '动作'), `${seed}:${index}`, execution)));
  }
  async function groupedExercises(
    source: Record<string, unknown>[],
    seed: string,
    execution: boolean,
  ): Promise<Record<string, unknown>[]> {
    const byExercise = new Map<string, Record<string, unknown>[]>();
    for (const row of source) {
      const id = exerciseId(row.exercise);
      const group = byExercise.get(id) ?? [];
      group.push(row);
      byExercise.set(id, group);
    }
    return Promise.all(
      [...byExercise.entries()].map(async ([id, group]) => {
        const all = await Promise.all(
          group.map((row, index) => exercise({ ...row, id: undefined }, `${seed}:${id}:${index}`, execution)),
        );
        return { ...all[0]!, id: await transferId([seed, id]), sets: all.flatMap((item) => item.sets as unknown[]) };
      }),
    );
  }
  async function days(value: unknown, seed: string): Promise<Record<string, unknown>[]> {
    const list = structured(value);
    if (!Array.isArray(list) || list.length > 36500) throw new Error('训练日安排应为最多 36500 天的数组。');
    return Promise.all(
      list.map(async (input, index) => {
        const day = object(input, '训练日');
        const slot = day.slot == null ? null : object(day.slot, '训练安排');
        return {
          day_index:
            day.day !== undefined
              ? integer(day.day, '训练日', undefined, 1) - 1
              : integer(day.day_index, '训练日序号', index),
          slot: slot
            ? {
                id: slot.id ? await reference(slot.id) : await transferId([seed, 'day', index]),
                name: slot.name,
                source_template_id: slot.source_template_id == null ? null : await reference(slot.source_template_id),
                exercises: await exercises(slot.exercises, `${seed}:day:${index}`, false),
              }
            : null,
        };
      }),
    );
  }
  const records: TransferRecord[] = [];
  const warnings: string[] = [];
  for (const { rows: source, index } of groups.values()) {
    try {
      const row = source[0]!;
      for (const field of ['cycle_days', 'start_date', 'status'])
        if (new Set(source.map((item) => item[field])).size > 1) throw new Error(`同一计划或训练的 ${field} 不一致。`);
      const type = entityType(row.entity_type);
      let id = row.id ? await reference(row.id) : await transferId([exportId, index]);
      const created = timestamp(row.created_at, now);
      const updated = timestamp(row.updated_at, created);
      if (updated < created) throw new Error('修改时间不能早于创建时间。');
      const name = String(row.name ?? '').trim();
      if (type !== 'fitness_preferences' && (!name || [...name].length > 100 || name.includes('\u0000')))
        throw new Error('名称需为 1–100 个字符。');
      const base = { name, created_at: created, updated_at: updated };
      const origin = row.catalog_origin === undefined ? {} : { catalog_origin: structured(row.catalog_origin) };
      let payload: Record<string, unknown>;
      if (type === 'fitness_preferences') {
        const prefs = row.preferences === undefined ? {} : object(structured(row.preferences), '健身偏好');
        payload = {
          ...preferencesPayload(undefined, created),
          ...prefs,
          created_at: timestamp(prefs.created_at, created),
          updated_at: timestamp(prefs.updated_at, updated),
        };
      } else if (type === 'fitness_template')
        payload = {
          ...base,
          ...origin,
          exercises:
            row.exercises !== undefined
              ? await exercises(row.exercises, id, false)
              : await groupedExercises(source, id, false),
        };
      else if (type === 'fitness_plan') {
        let schedule: Record<string, unknown>[];
        if (row.days !== undefined) schedule = await days(row.days, id);
        else {
          const dayGroups = new Map<number, Record<string, unknown>[]>();
          for (const entry of source) {
            const day = integer(entry.day, '训练日', 1, 1, 36500) - 1;
            const group = dayGroups.get(day) ?? [];
            group.push(entry);
            dayGroups.set(day, group);
          }
          const count = integer(row.cycle_days, '循环天数', Math.max(...dayGroups.keys()) + 1, 1, 36500);
          if ([...dayGroups.keys()].some((day) => day >= count)) throw new Error('训练日超出循环天数。');
          schedule = await Promise.all(
            Array.from({ length: count }, async (_, day) => ({
              day_index: day,
              slot: dayGroups.has(day)
                ? {
                    id: await transferId([id, 'day', day]),
                    name,
                    source_template_id: null,
                    exercises: await groupedExercises(dayGroups.get(day)!, `${id}:day:${day}`, false),
                  }
                : null,
            })),
          );
        }
        const count = integer(row.cycle_days, '循环天数', schedule.length, 1, 36500);
        if (
          schedule.length !== count ||
          schedule.some((day, dayIndex) => day.day_index !== dayIndex) ||
          !schedule.some((day) => day.slot !== null)
        )
          throw new Error('计划需包含完整且连续的每日安排，并至少有一天训练。');
        const pending = row.pending_schedule == null ? null : object(structured(row.pending_schedule), '待生效安排');
        payload = {
          ...base,
          ...origin,
          cycle_days: count,
          days: schedule,
          start_date: row.start_date == null ? null : date(row.start_date, '计划开始日期'),
          status: row.status ?? (row.start_date ? 'in_progress' : 'closed'),
          generation_state: structured(row.generation_state) ?? {
            next_cycle_start_date: null,
            next_cycle_index: 0,
            generated_cycles: [],
          },
          pending_schedule: pending ? { ...pending, days: await days(pending.days, `${id}:pending`) } : null,
        };
        if (payload.status !== 'in_progress' && payload.status !== 'closed')
          throw new Error('计划状态应为 in_progress 或 closed。');
        if (payload.status === 'in_progress' && !payload.start_date) throw new Error('启用中的计划需要开始日期。');
        if (payload.status === 'in_progress')
          warnings.push(`「${name}」为启用中的计划，导入后进入空间会继续生成到期周期。`);
      } else {
        const sourcePlanId = row.source_plan_id == null ? null : await reference(row.source_plan_id);
        let occurrence = row.occurrence_key == null ? null : String(row.occurrence_key);
        if (occurrence !== null) {
          const parts = occurrence.split(':');
          if (parts.length !== 4) throw new Error('计划发生标识需包含四部分。');
          occurrence = [await reference(parts[0]), parts[1], parts[2], await reference(parts[3])].join(':');
          if (sourcePlanId) id = await occurrenceId(sourcePlanId, occurrence);
        }
        const timer = row.rest_timer == null ? null : object(structured(row.rest_timer), '计时状态');
        payload = {
          ...base,
          scheduled_date: date(row.scheduled_date, '训练日期'),
          source_kind: row.source_kind ?? 'blank',
          source_plan_id: sourcePlanId,
          source_plan_name: row.source_plan_name ?? null,
          source_template_id: row.source_template_id == null ? null : await reference(row.source_template_id),
          occurrence_key: occurrence,
          exercises:
            row.exercises !== undefined
              ? await exercises(row.exercises, id, true)
              : await groupedExercises(source, id, true),
          status: row.status ?? 'scheduled',
          run_segments: structured(row.run_segments) ?? [],
          rest_timer: timer
            ? {
                ...timer,
                // 手动休息可以不关联训练组，只为实际存在的来源身份生成映射。
                ...(timer.exercise_id == null ? {} : { exercise_id: await reference(timer.exercise_id) }),
                ...(timer.set_id == null ? {} : { set_id: await reference(timer.set_id) }),
              }
            : null,
        };
        if (!['scheduled', 'in_progress', 'completed'].includes(String(payload.status)))
          throw new Error('训练状态应为 scheduled、in_progress 或 completed。');
      }
      records.push({ id, entity_type: type, payload } as TransferRecord);
    } catch (error) {
      throw new Error(
        `第 ${index + (table.format === 'csv' ? 2 : 1)} 行：${error instanceof Error ? error.message : '记录无效'}`,
      );
    }
  }
  const ids = new Map<string, TransferRecord['entity_type']>();
  let preferencesCount = 0;
  let runningCount = 0;
  for (const record of records) {
    if (ids.has(record.id)) throw new Error('文件中有重复记录身份，请检查是否重复导出了同一条记录。');
    ids.set(record.id, record.entity_type);
    if (record.entity_type === 'fitness_preferences') preferencesCount++;
    if (record.entity_type === 'fitness_workout' && record.payload.status === 'in_progress') runningCount++;
  }
  if (preferencesCount > 1 || runningCount > 1) throw new Error('同一空间只能导入一份偏好和最多一项进行中的训练。');
  return { exportId, records, warnings: [...new Set(warnings)] };
}

/** 导出与移动端相同的完整业务对象，偏好嵌套单独字段，不遗漏训练执行状态。 */
export function encodeTransferJson(records: TransferRecord[]): string {
  return JSON.stringify(
    records.map((record) =>
      record.entity_type === 'fitness_preferences'
        ? { entity_type: record.entity_type, id: record.id, preferences: record.payload }
        : { entity_type: record.entity_type, id: record.id, ...record.payload },
    ),
    null,
    2,
  );
}

/** CSV 每个业务实体一行，复杂状态以 JSON 单元格保存，可无损重新导入。 */
export function encodeTransferCsv(records: TransferRecord[]): string {
  const rows = JSON.parse(encodeTransferJson(records)) as Record<string, unknown>[];
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (!headers.length) return 'entity_type,id,name\r\n';
  const cell = (value: unknown) => {
    const raw =
      value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // 所有单元格加引号保留逗号/换行；公式样式名称前置制表符仅用于表格应用安全。
    const safe = /^[=+\-@]/.test(raw) ? `\t${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return `\uFEFF${[headers.map(cell).join(','), ...rows.map((row) => headers.map((header) => cell(row[header])).join(','))].join('\r\n')}`;
}
