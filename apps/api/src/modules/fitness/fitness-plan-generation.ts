import { isDeepStrictEqual } from 'node:util';
import type { Static } from '@sinclair/typebox';
import { ApiError } from '../../shared/errors.js';
import { uuidV5 } from '../../shared/uuid.js';
import { validateFitnessPayload } from './fitness-rules.js';
import type {
  fitnessPayloadSchemas,
  FitnessPlanPayload,
  FitnessWorkoutPayload,
  FitnessPreferencesPayload,
} from './fitness-schemas.js';

type TemplatePayload = Static<typeof fitnessPayloadSchemas.fitness_template>;
type GeneratedWorkout = { id: string; payload: FitnessWorkoutPayload };
type PlanGeneration = { plan: FitnessPlanPayload; workouts: GeneratedWorkout[]; hasMore: boolean };
const MAX_CYCLES = 100;
const MAX_WORKOUTS = 500;

/** 日期计算始终使用 UTC 日历，严格拒绝日期溢出和年份超出四位的结果。 */
export function addPlanDays(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000'))
    throw new ApiError(400, 'INVALID_PLAN_DATE', '计划日期无效');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new ApiError(400, 'INVALID_PLAN_DATE', '计划日期无效');
  parsed.setUTCDate(parsed.getUTCDate() + days);
  const value = parsed.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, 'INVALID_PLAN_DATE', '计划日期超出支持范围');
  return value;
}

/** 对齐移动端 savePlan：历史游标不可由草稿覆盖，已生成排班的修改从下周期开始。 */
export function preparePlanSave(
  input: FitnessPlanPayload,
  previous: FitnessPlanPayload | null,
  today: string,
  now: string,
  restartDate?: string,
  officialIds?: ReadonlySet<string>,
): { plan: FitnessPlanPayload; restart: boolean } {
  addPlanDays(today, 0);
  validateFitnessPayload('fitness_plan', input, officialIds);
  const restart = previous !== null && previous.status === 'closed' && input.status === 'in_progress';
  if (restartDate !== undefined && !restart)
    throw new ApiError(400, 'FITNESS_PLAN_STATUS', '只有重新启用计划时才能指定重启日期');
  if (restart && previous.generation_state.next_cycle_start_date && !restartDate)
    throw new ApiError(400, 'FITNESS_START_DATE_REQUIRED', '重新启用时请选择新的开始日期');
  const plan: FitnessPlanPayload = {
    ...structuredClone(input),
    generation_state: previous
      ? structuredClone(previous.generation_state)
      : { next_cycle_index: 0, next_cycle_start_date: null, generated_cycles: [] },
    pending_schedule: null,
    created_at: previous?.created_at ?? input.created_at,
    updated_at: [now, previous?.updated_at ?? input.created_at].sort().at(-1)!,
  };
  if (restart) plan.start_date = restartDate ?? input.start_date;
  if (plan.start_date !== null) {
    addPlanDays(plan.start_date, 0);
    if ((restart || !previous || plan.start_date !== previous.start_date) && plan.start_date < today)
      throw new ApiError(400, 'FITNESS_PAST_SCHEDULE', '新的开始日期不能早于今天');
  }
  if (previous?.generation_state.next_cycle_start_date && !restart) {
    if (plan.status === 'in_progress' && plan.start_date !== previous.start_date)
      throw new ApiError(400, 'FITNESS_START_DATE_IMMUTABLE', '已生成计划的开始日期不可修改');
    const nextSchedule = { cycle_days: plan.cycle_days, days: structuredClone(plan.days) };
    plan.pending_schedule = isDeepStrictEqual(nextSchedule, { cycle_days: previous.cycle_days, days: previous.days })
      ? null
      : nextSchedule;
    plan.cycle_days = previous.cycle_days;
    plan.days = structuredClone(previous.days);
  }
  return { plan, restart };
}

/** 与移动端使用相同周期编号和 UUIDv5 身份；每次只追加完整周期，历史记录保持不变。 */
export function generatePlanCycles(
  id: string,
  input: FitnessPlanPayload,
  today: string,
  now: string,
  templates: ReadonlyMap<string, TemplatePayload> = new Map(),
  restSettings: FitnessPreferencesPayload['exercise_rest_settings'] = {},
  restart = false,
): PlanGeneration {
  addPlanDays(today, 0);
  const plan = structuredClone(input);
  if (plan.status !== 'in_progress') return { plan, workouts: [], hasMore: false };
  if (plan.start_date === null) throw new ApiError(400, 'FITNESS_START_DATE_REQUIRED', '启用的计划需要开始日期');
  const state = plan.generation_state;
  let start = restart ? plan.start_date : (state.next_cycle_start_date ?? plan.start_date);
  let first = restart || state.next_cycle_start_date === null;
  let count = 0;
  const workouts: GeneratedWorkout[] = [];
  while (first || start <= today) {
    const schedule = plan.pending_schedule ?? { cycle_days: plan.cycle_days, days: plan.days };
    const workoutCount = schedule.days.filter((day) => day.slot !== null).length;
    if (workoutCount > MAX_WORKOUTS)
      throw new ApiError(400, 'FITNESS_CYCLE_TOO_LARGE', '一个周期最多在线生成 500 次训练，请缩短周期后重试');
    if (count >= MAX_CYCLES || workouts.length + workoutCount > MAX_WORKOUTS) break;
    if (state.next_cycle_index >= 2147483647) throw new ApiError(400, 'FITNESS_CYCLE_LIMIT', '计划周期编号已达到上限');
    plan.cycle_days = schedule.cycle_days;
    plan.days = structuredClone(schedule.days);
    plan.pending_schedule = null;
    const end = addPlanDays(start, plan.cycle_days);
    const restDates: string[] = [];
    for (const day of plan.days) {
      const date = addPlanDays(start, day.day_index);
      if (!day.slot) {
        restDates.push(date);
        continue;
      }
      const slot = day.slot;
      const template = slot.source_template_id ? templates.get(slot.source_template_id) : undefined;
      const occurrenceKey = `${id}:${state.next_cycle_index}:${day.day_index}:${slot.id}`;
      const exercises = structuredClone(template?.exercises ?? slot.exercises).map((exercise) => ({
        ...exercise,
        ...(restSettings?.[exercise.exercise_id] ?? {}),
        sets: exercise.sets.map((set) => ({ ...set, completed: false, rest_durations_seconds: [] })),
      }));
      workouts.push({
        id: uuidV5(id, occurrenceKey),
        payload: {
          name: template?.name ?? slot.name,
          scheduled_date: date,
          source_kind: 'plan',
          source_plan_id: id,
          source_plan_name: plan.name,
          source_template_id: slot.source_template_id,
          occurrence_key: occurrenceKey,
          exercises,
          status: 'scheduled',
          run_segments: [],
          rest_timer: null,
          created_at: now,
          updated_at: now,
        },
      });
    }
    state.generated_cycles.push({
      cycle_index: state.next_cycle_index,
      start_date: start,
      cycle_days: plan.cycle_days,
      generated_from_date: start,
      rest_dates: restDates,
    });
    state.next_cycle_index++;
    state.next_cycle_start_date = end;
    start = end;
    first = false;
    count++;
  }
  plan.updated_at = [now, plan.updated_at].sort().at(-1)!;
  return { plan, workouts, hasMore: start <= today };
}
