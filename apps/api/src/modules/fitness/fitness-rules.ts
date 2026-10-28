import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { ApiError } from '../../shared/errors.js';
import { isStrictTimestamp } from '../../shared/contracts/scalars.js';
import { structuralSchema } from '../../shared/contracts/structural-schema.js';
import { normalizeName } from '../../shared/text-validation.js';
import catalog from './fitness-catalog.json' with { type: 'json' };
import {
  fitnessPayloadSchemas,
  type FitnessEntityType,
  type FitnessPlanPayload,
  type FitnessWorkoutPayload,
  type FitnessPreferencesPayload,
} from './fitness-schemas.js';

function fail(message = '健身字段无效'): never {
  throw new ApiError(400, 'INVALID_FITNESS_PAYLOAD', message);
}

const strictSchemas = Object.fromEntries(
  Object.entries(fitnessPayloadSchemas).map(([key, schema]) => [key, structuralSchema(schema)]),
);

function validateTextAndDates(value: unknown, key = ''): void {
  if (typeof value === 'string') {
    if (!value.isWellFormed() || value.includes('\u0000')) fail();
    if (key.endsWith('_at') && !isStrictTimestamp(value)) fail('健身时间无效');
    if (key.endsWith('_date') || key === 'rest_dates') {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000'))
        fail('健身日期无效');
    }
    if (key === 'name' || key.endsWith('_name')) normalizeName(value);
  } else if (Array.isArray(value)) {
    for (const child of value) validateTextAndDates(child, key);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      if (typeof child === 'string' && (childKey === 'name' || childKey.endsWith('_name')))
        (value as Record<string, unknown>)[childKey] = normalizeName(child);
      validateTextAndDates(child, childKey);
    }
  }
}

function uniqueIds(rows: Array<{ id: string }>): void {
  if (new Set(rows.map((row) => row.id)).size !== rows.length) fail('动作、组或安排标识重复');
}

const builtinExerciseIds: ReadonlySet<string> = new Set(catalog.exercises.map((entry) => entry.id));

/** 同步接收方只接受实际发布的官方身份，自定义身份继续使用独立命名空间。 */
function validExerciseId(id: string, officialIds: ReadonlySet<string>): boolean {
  return (
    officialIds.has(id) || /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
  );
}

/** 已通过字段结构校验的完成组必须具有次数及完整重量口径；不依赖当前动作目录。 */
export function validateCompletedFitnessSet(set: FitnessWorkoutPayload['exercises'][number]['sets'][number]): void {
  if (
    set.reps === null ||
    (set.weight !== null && (set.weight_left !== null || set.weight_right !== null)) ||
    (set.weight_left === null) !== (set.weight_right === null)
  )
    fail('完成组必须填写有效次数与完整重量口径');
}

function exercisesValid(
  exercises: FitnessWorkoutPayload['exercises'] | NonNullable<FitnessPlanPayload['days'][number]['slot']>['exercises'],
  officialIds: ReadonlySet<string>,
): void {
  uniqueIds(exercises);
  const modes = new Map<string, boolean>();
  for (const exercise of exercises) {
    if (!validExerciseId(exercise.exercise_id, officialIds)) fail('动作标识无效');
    uniqueIds(exercise.sets);
    for (const set of exercise.sets) {
      if ('completed' in set && set.completed) validateCompletedFitnessSet(set);
      // 未完成组与处方允许单边草稿，但总重与左右重量仍只能选择一种口径。
      else if (set.weight !== null && (set.weight_left !== null || set.weight_right !== null))
        fail('一组只能填写总重或左右重量');
      // 同一目录动作的全部实例共用口径；空白或自重组不参与口径判定。
      const side = set.weight_left !== null || set.weight_right !== null;
      if (side || set.weight !== null) {
        if (modes.has(exercise.exercise_id) && modes.get(exercise.exercise_id) !== side)
          fail('同一动作的全部组请使用相同的重量口径');
        modes.set(exercise.exercise_id, side);
      }
      if ('rest_durations_seconds' in set && set.rest_durations_seconds?.length && !set.completed)
        fail('休息历史必须属于已完成组');
    }
  }
}

function scheduleValid(
  schedule: Pick<FitnessPlanPayload, 'cycle_days' | 'days'>,
  officialIds: ReadonlySet<string>,
): void {
  if (
    schedule.days.length !== schedule.cycle_days ||
    new Set(schedule.days.map((day) => day.day_index)).size !== schedule.cycle_days ||
    !schedule.days.some((day) => day.slot !== null)
  )
    fail('计划必须覆盖整个周期并至少安排一次训练');
  const slots = schedule.days.flatMap((day) => (day.slot ? [day.slot] : []));
  uniqueIds(slots);
  for (const day of schedule.days) {
    if (day.day_index >= schedule.cycle_days) fail();
    if (day.slot) exercisesValid(day.slot.exercises, officialIds);
  }
}

export function validateFitnessPayload(
  type: FitnessEntityType,
  value: Record<string, unknown>,
  officialIds: ReadonlySet<string> = builtinExerciseIds,
): void {
  if (!Value.Check(strictSchemas[type]!, value)) fail();
  validateTextAndDates(value);
  if ((value.updated_at as string) < (value.created_at as string)) fail('修改时间不能早于创建时间');
  if (type === 'fitness_template') exercisesValid(value.exercises as FitnessWorkoutPayload['exercises'], officialIds);
  if (
    type === 'fitness_preferences' &&
    (value.pinned_exercise_ids as string[]).some((id) => !validExerciseId(id, officialIds))
  )
    fail('置顶动作标识无效');
  if (
    type === 'fitness_preferences' &&
    Object.keys((value.exercise_rest_settings as object | undefined) ?? {}).some(
      (id) => !validExerciseId(id, officialIds),
    )
  )
    fail('休息设置动作标识无效');
  if (type === 'fitness_preferences') {
    const modes = (value.exercise_weight_modes ?? {}) as Record<string, boolean>;
    if (Object.keys(modes).some((id) => !validExerciseId(id, officialIds))) fail('重量口径动作标识无效');
    if (Object.keys(modes).length > 1000) fail('重量口径条目过多');
  }
  if (type === 'fitness_preferences') {
    const preferences = value as FitnessPreferencesPayload;
    uniqueIds(preferences.custom_exercises);
    // 自定义动作及其图片随偏好同步，序列化后的总容量上限为 256 KiB。
    if (Buffer.byteLength(JSON.stringify(preferences.custom_exercises), 'utf8') > 256 * 1024)
      fail('自定义动作容量已满');
    for (const exercise of preferences.custom_exercises) {
      if (exercise.image !== null && Buffer.from(exercise.image, 'base64').toString('base64') !== exercise.image)
        fail('动作图片无效');
    }
  }
  if (type === 'fitness_plan') {
    const plan = value as FitnessPlanPayload;
    if (plan.status === 'in_progress' && plan.start_date === null) fail('开启计划必须选择开始日期');
    scheduleValid(plan, officialIds);
    if (plan.pending_schedule) scheduleValid(plan.pending_schedule, officialIds);
    const state = plan.generation_state;
    if (new Set(state.generated_cycles.map((cycle) => cycle.cycle_index)).size !== state.generated_cycles.length)
      fail();
    for (const cycle of state.generated_cycles) {
      const end = new Date(`${cycle.start_date}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + cycle.cycle_days - 1);
      const endDate = end.toISOString().slice(0, 10);
      if (
        cycle.cycle_index >= state.next_cycle_index ||
        cycle.generated_from_date < cycle.start_date ||
        cycle.generated_from_date > endDate ||
        new Set(cycle.rest_dates).size !== cycle.rest_dates.length ||
        cycle.rest_dates.some((day) => day < cycle.generated_from_date || day > endDate)
      )
        fail();
    }
    if (state.generated_cycles.length && state.next_cycle_start_date === null) fail();
  }
  if (type === 'fitness_workout') {
    const workout = value as FitnessWorkoutPayload;
    exercisesValid(workout.exercises, officialIds);
    const segments = workout.run_segments;
    if (
      workout.source_kind === 'plan'
        ? !workout.source_plan_id || !workout.source_plan_name || !workout.occurrence_key
        : [workout.source_plan_id, workout.source_plan_name, workout.occurrence_key].some((field) => field !== null)
    )
      fail();
    if (workout.source_kind === 'blank' && workout.source_template_id !== null) fail();
    if (workout.source_kind === 'template' && workout.source_template_id === null) fail();
    if (workout.status === 'scheduled') {
      if (
        segments.length ||
        workout.rest_timer !== null ||
        workout.exercises.some((exercise) => exercise.sets.some((set) => set.completed))
      )
        fail();
    } else {
      if (!segments.length) fail();
      if (workout.status === 'completed' && segments.at(-1)!.ended_at === null) fail();
    }
    for (const [index, segment] of segments.entries()) {
      if (segment.ended_at !== null && segment.ended_at < segment.started_at) fail();
      if (index > 0 && (segments[index - 1]!.ended_at === null || segments[index - 1]!.ended_at! > segment.started_at))
        fail();
      if (index < segments.length - 1 && segment.ended_at === null) fail();
    }
    const timer = workout.rest_timer;
    if (timer && (workout.status !== 'in_progress' || (timer.status === 'running') !== (timer.ends_at !== null)))
      fail();
    if (
      timer &&
      ((timer.exercise_id == null) !== (timer.set_id == null) ||
        (timer.exercise_id != null &&
          !workout.exercises.some(
            (exercise) =>
              exercise.id === timer.exercise_id &&
              exercise.sets.some((set) => set.id === timer.set_id && set.completed),
          )))
    )
      fail('休息计时必须关联当前训练的已完成组');
  }
}

/** 已生成周期和已运行时段都是事实；普通编辑只能追加或结束当前时段。 */
export function validateFitnessTransition(
  type: FitnessEntityType,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  if (previous.created_at !== next.created_at) fail('创建时间不可修改');
  if (type === 'fitness_workout') {
    const before = previous as FitnessWorkoutPayload;
    const after = next as FitnessWorkoutPayload;
    for (const key of [
      'scheduled_date',
      'source_kind',
      'source_plan_id',
      'source_plan_name',
      'source_template_id',
      'occurrence_key',
    ] as const)
      if (before[key] !== after[key]) fail('训练来源或安排日期不可修改');
    if (after.run_segments.length < before.run_segments.length) fail('运行时段不可删除');
    for (const [index, segment] of before.run_segments.entries()) {
      const updated = after.run_segments[index]!;
      if (
        updated.started_at !== segment.started_at ||
        (segment.ended_at !== null && updated.ended_at !== segment.ended_at)
      )
        fail('历史运行时段不可修正');
    }
  }
  if (type === 'fitness_plan') {
    const before = previous as FitnessPlanPayload;
    const after = next as FitnessPlanPayload;
    if (
      after.status === 'in_progress' &&
      before.generation_state.generated_cycles.length &&
      before.start_date !== after.start_date &&
      !after.generation_state.generated_cycles.some(
        (cycle) =>
          cycle.cycle_index >= before.generation_state.next_cycle_index && cycle.start_date === after.start_date,
      )
    )
      fail('重选开始日期必须从该日期生成新周期');
    if (after.generation_state.next_cycle_index < before.generation_state.next_cycle_index) fail('周期进度不可回退');
    for (const cycle of before.generation_state.generated_cycles) {
      const updated = after.generation_state.generated_cycles.find((item) => item.cycle_index === cycle.cycle_index);
      if (!isDeepStrictEqual(cycle, updated)) fail('已生成周期不可重排');
    }
  }
}
