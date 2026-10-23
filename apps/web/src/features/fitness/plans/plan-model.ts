import { localToday, validDate, type FitnessPlan, type FitnessTemplate } from '../fitness-model';
import type { SyncChange } from '../../../lib/session';

type PlanPayload = Extract<SyncChange, { entity_type: 'fitness_plan'; action: 'upsert' }>['payload'];
export type PlanDraft = { payload: PlanPayload; filled: Set<number> };
export const maxCycleDays = 36500;

/** 从快照提取契约载荷，完整保留游标、待生效排班和官方来源。 */
function planPayload(plan: FitnessPlan): PlanPayload {
  return {
    name: plan.name,
    status: plan.status,
    start_date: plan.start_date,
    cycle_days: plan.cycle_days,
    days: structuredClone(plan.days),
    generation_state: structuredClone(plan.generation_state),
    pending_schedule: structuredClone(plan.pending_schedule),
    ...(plan.catalog_origin ? { catalog_origin: structuredClone(plan.catalog_origin) } : {}),
    created_at: plan.created_at,
    updated_at: plan.updated_at,
  };
}

/** 优先编辑待生效排班；新建空白日必须由用户明确指定训练或休息。 */
export function newPlanDraft(plan?: FitnessPlan, today = localToday(), now = new Date().toISOString()): PlanDraft {
  if (plan) {
    const payload = planPayload(plan);
    if (payload.pending_schedule) {
      payload.cycle_days = payload.pending_schedule.cycle_days;
      payload.days = structuredClone(payload.pending_schedule.days);
    }
    payload.days.sort((a, b) => a.day_index - b.day_index);
    return { payload, filled: new Set(payload.days.map((day) => day.day_index)) };
  }
  return {
    payload: {
      name: '',
      status: 'in_progress',
      start_date: today,
      cycle_days: 7,
      days: Array.from({ length: 7 }, (_, day_index) => ({ day_index, slot: null })),
      generation_state: { next_cycle_index: 0, next_cycle_start_date: null, generated_cycles: [] },
      pending_schedule: null,
      created_at: now,
      updated_at: now,
    },
    filled: new Set(),
  };
}

/** 修改周期只截去尾部或添加未填写日期，保留既有槽位身份和快照。 */
export function resizePlan(draft: PlanDraft, count: number): PlanDraft {
  if (!Number.isInteger(count) || count < 1 || count > maxCycleDays) throw new Error('周期请输入 1–36500 天的整数。');
  return {
    payload: {
      ...draft.payload,
      cycle_days: count,
      days: Array.from({ length: count }, (_, day_index) => draft.payload.days[day_index] ?? { day_index, slot: null }),
    },
    filled: new Set([...draft.filled].filter((index) => index < count)),
  };
}

/** 选择用户模板建立独立快照，不覆盖模板本身。 */
export function assignPlanDay(draft: PlanDraft, index: number, template: FitnessTemplate | null): PlanDraft {
  if (index < 0 || index >= draft.payload.cycle_days) throw new Error('安排日期超出计划周期。');
  const days = [...draft.payload.days];
  days[index] = {
    day_index: index,
    slot: template
      ? {
          id: crypto.randomUUID(),
          source_template_id: template.id,
          name: template.name,
          exercises: structuredClone(template.exercises),
        }
      : null,
  };
  return { payload: { ...draft.payload, days }, filled: new Set([...draft.filled, index]) };
}

/** 调序时填写标记随槽位一起移动，不能隐式把未填写日期变成休息日。 */
export function movePlanDay(draft: PlanDraft, from: number, to: number): PlanDraft {
  if (![from, to].every((index) => Number.isInteger(index) && index >= 0 && index < draft.payload.cycle_days))
    throw new Error('安排日期超出计划周期。');
  const days = [...draft.payload.days];
  const filled = days.map((_, index) => draft.filled.has(index));
  days.splice(to, 0, days.splice(from, 1)[0]!);
  filled.splice(to, 0, filled.splice(from, 1)[0]!);
  return {
    payload: { ...draft.payload, days: days.map((day, day_index) => ({ ...day, day_index })) },
    filled: new Set(filled.flatMap((value, index) => (value ? [index] : []))),
  };
}

/** 保存前验证明确排班和日期边界，服务端再执行权威校验与原子生成。 */
export function validatePlanDraft(draft: PlanDraft, original?: FitnessPlan, today = localToday()): string | null {
  const plan = draft.payload;
  if (!plan.name.trim() || [...plan.name.trim()].length > 100 || plan.name.includes('\u0000'))
    return '计划名称需为 1–100 个字符。';
  if (!Number.isInteger(plan.cycle_days) || plan.cycle_days < 1 || plan.cycle_days > maxCycleDays)
    return '周期请输入 1–36500 天的整数。';
  if (plan.days.length !== plan.cycle_days || new Set(plan.days.map((day) => day.day_index)).size !== plan.cycle_days)
    return '周期日期不完整，请重新检查排班。';
  for (let index = 0; index < plan.cycle_days; index++) {
    if (!draft.filled.has(index)) return `请明确安排第 ${index + 1} 天的训练或休息。`;
    if (plan.days[index]?.day_index !== index) return '周期日期顺序不正确，请重新检查排班。';
  }
  if (!plan.days.some((day) => day.slot)) return '一个周期至少需要安排一次训练。';
  if (!plan.start_date || !validDate(plan.start_date)) return '请选择有效的计划起始日期。';
  const restarting = original?.status === 'closed' && plan.status === 'in_progress';
  if ((restarting || !original || plan.start_date !== original.start_date) && plan.start_date < today)
    return '新的起始日期不能早于今天。';
  if (
    original?.generation_state.next_cycle_start_date &&
    original.status === 'in_progress' &&
    plan.status === 'in_progress' &&
    plan.start_date !== original.start_date
  )
    return '已生成计划的起始日不能修改；请先停用，再选择日期重新启用。';
  const slotIds = plan.days.flatMap((day) => (day.slot ? [day.slot.id] : []));
  if (new Set(slotIds).size !== slotIds.length) return '训练安排标识重复，请重新选择对应模板。';
  if (plan.days.some((day) => day.slot && (!day.slot.name.trim() || !day.slot.exercises.length)))
    return '训练安排需要包含有效模板和动作。';
  return null;
}

/** 日历日期按 UTC 相加，闰年和夏令时不会改变周期日序。 */
export function planDateOffset(date: string, offset: number): string {
  if (!validDate(date) || !Number.isSafeInteger(offset)) throw new Error('计划日期无效。');
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  const result = value.toISOString().slice(0, 10);
  if (!validDate(result)) throw new Error('计划日期超出支持范围。');
  return result;
}

/** 提交只规范名称和更新时间，历史字段交由服务端事务保留。 */
export function submissionPayload(
  draft: PlanDraft,
  original?: FitnessPlan,
  today = localToday(),
  now = new Date().toISOString(),
): PlanPayload {
  const error = validatePlanDraft(draft, original, today);
  if (error) throw new Error(error);
  return {
    ...structuredClone(draft.payload),
    name: draft.payload.name.trim(),
    updated_at: [now, draft.payload.updated_at, draft.payload.created_at].sort().at(-1)!,
  };
}
