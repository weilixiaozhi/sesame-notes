import { settleRest } from './rest-model';
import { setWeightMode } from './weight-mode';
import type { Workout, WorkoutPayload, OfficialTemplate, TemplatePayload, FitnessTemplate } from './fitness-types';
export type * from './fitness-types';

export const workoutLabels: Record<Workout['status'], string> = {
  scheduled: '待训练',
  in_progress: '进行中',
  completed: '已完成',
};

/** 将本地年月日转为纯日期，不经 UTC 转换改变用户选择的日期。 */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 日期与重量使用 wire 原值校验，避免宽松日期和浮点数隐式改写。 */
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 重量仍以十进制字符串保存，允许自重的空值，拒绝指数形式和负值。 */
export function validWeight(value: string | null): boolean {
  return value === null || /^(?:0|[1-9]\d{0,17})(?:\.\d{1,10})?$/.test(value);
}

/** 从服务端快照取回唯一允许写入的业务字段，保留历史和复杂重量数据。 */
export function workoutPayload(workout: Workout): WorkoutPayload {
  return {
    name: workout.name,
    scheduled_date: workout.scheduled_date,
    source_kind: workout.source_kind,
    source_plan_id: workout.source_plan_id,
    source_plan_name: workout.source_plan_name,
    source_template_id: workout.source_template_id,
    occurrence_key: workout.occurrence_key,
    exercises: structuredClone(workout.exercises),
    status: workout.status,
    run_segments: structuredClone(workout.run_segments),
    rest_timer: structuredClone(workout.rest_timer),
    created_at: workout.created_at,
    updated_at: workout.updated_at,
  };
}

/** 模板展开时为动作和组生成新的身份，训练完成状态不与模板共享。 */
export function newWorkout(
  name: string,
  date: string,
  template?: FitnessTemplate,
  now = new Date().toISOString(),
): WorkoutPayload {
  return {
    name: name.trim(),
    scheduled_date: date,
    source_kind: template ? 'template' : 'blank',
    source_plan_id: null,
    source_plan_name: null,
    source_template_id: template?.id ?? null,
    occurrence_key: null,
    status: 'scheduled',
    run_segments: [],
    rest_timer: null,
    exercises:
      template?.exercises.map((exercise) => ({
        ...exercise,
        id: crypto.randomUUID(),
        sets: exercise.sets.map((set) => ({
          ...set,
          id: crypto.randomUUID(),
          completed: false,
          rest_durations_seconds: [],
        })),
      })) ?? [],
    created_at: now,
    updated_at: now,
  };
}

/** 官方处方复制为独立用户模板，保留总重、单侧和自重三种口径。 */
export function importTemplate(template: OfficialTemplate, now = new Date().toISOString()): TemplatePayload {
  return {
    name: template.name.zh,
    catalog_origin: { source: 'official', item_id: template.id, revision: template.revision },
    exercises: template.exercises.map((exercise) => ({
      id: crypto.randomUUID(),
      exercise_id: exercise.exercise_id,
      rest_seconds: exercise.rest_seconds,
      warmup_rest_seconds: null,
      sets: Array.from({ length: exercise.sets }, () => ({
        id: crypto.randomUUID(),
        kind: 'working' as const,
        reps: exercise.reps,
        weight: exercise.weight_mode === 'total' ? exercise.weight_kg : null,
        weight_left: exercise.weight_mode === 'per_side' ? exercise.weight_kg : null,
        weight_right: exercise.weight_mode === 'per_side' ? exercise.weight_kg : null,
      })),
    })),
    created_at: now,
    updated_at: now,
  };
}

/** 训练状态只前进或暂停，已关闭时段绝不重写；结束训练时结算休息历史。 */
export function transitionWorkout(
  workout: Workout,
  action: 'start' | 'pause' | 'resume' | 'complete',
  now = new Date().toISOString(),
): WorkoutPayload {
  const payload =
    action === 'complete' ? settleRest(workoutPayload(workout), Date.parse(now)) : workoutPayload(workout);
  const last = payload.run_segments.at(-1);
  const instant = [now, payload.updated_at, last?.started_at ?? '', last?.ended_at ?? ''].sort().at(-1)!;
  if (action === 'start' && (workout.status === 'scheduled' || workout.status === 'completed')) {
    payload.status = 'in_progress';
    payload.run_segments.push({ started_at: instant, ended_at: null });
  } else if (action === 'resume' && workout.status === 'in_progress' && last?.ended_at !== null && last) {
    payload.run_segments.push({ started_at: instant, ended_at: null });
  } else if ((action === 'pause' || action === 'complete') && workout.status === 'in_progress' && last) {
    if (last.ended_at === null) last.ended_at = instant;
    if (action === 'complete') payload.status = 'completed';
    else if (workout.run_segments.at(-1)?.ended_at !== null) throw new Error('训练已经暂停，请刷新后重试。');
  } else throw new Error('训练状态已变化，请刷新后重试。');
  payload.updated_at = instant;
  return payload;
}

/** 保存前检查各组的互斥重量与完成条件，错误保留编辑器中的草稿。 */
export function validateWorkout(payload: WorkoutPayload): string | null {
  if (!payload.name.trim() || [...payload.name.trim()].length > 100 || payload.name.includes('\u0000'))
    return '训练名称需为 1–100 个字符。';
  if (!validDate(payload.scheduled_date)) return '请选择有效的训练日期。';
  const modes = new Map<string, boolean>();
  for (const exercise of payload.exercises) {
    if (
      ![exercise.rest_seconds, exercise.warmup_rest_seconds].every(
        (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 2147483647),
      )
    )
      return '休息秒数请输入有效的非负整数。';
    for (const set of exercise.sets) {
      if (![set.weight, set.weight_left, set.weight_right].every(validWeight))
        return '重量请输入非负十进制数，最多 18 位整数和 10 位小数。';
      if (set.weight !== null && (set.weight_left !== null || set.weight_right !== null))
        return '一组训练只能使用总重或左右重量。';
      const mode = setWeightMode(set);
      if (mode !== null) {
        if (modes.has(exercise.exercise_id) && modes.get(exercise.exercise_id) !== mode)
          return '同一动作的全部组请使用相同的重量口径。';
        modes.set(exercise.exercise_id, mode);
      }
      if (set.reps !== null && (!Number.isSafeInteger(set.reps) || set.reps < 1 || set.reps > 2147483647))
        return '次数请输入有效的正整数。';
      if (set.completed && (set.reps === null || (set.weight_left === null) !== (set.weight_right === null)))
        return '已完成的组需要有效次数；左右重量需成对填写。';
    }
  }
  return null;
}

/** 显示用累计执行时长：暂停不继续计时，开启段按当前绝对时间推算。 */
export function workoutElapsed(workout: Pick<Workout, 'run_segments'>, now = Date.now()): number {
  return workout.run_segments.reduce(
    (sum, segment) =>
      sum + Math.max(0, (segment.ended_at ? Date.parse(segment.ended_at) : now) - Date.parse(segment.started_at)),
    0,
  );
}
