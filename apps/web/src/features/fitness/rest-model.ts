import type { FitnessPreferences, WorkoutPayload } from './fitness-types';

type RestTimer = NonNullable<WorkoutPayload['rest_timer']>;
const maxSeconds = 2147483647;
/** 倒计时由绝对结束时间推算，页面后台暂停不影响云端状态。 */
export function restRemaining(timer: RestTimer | null, now = Date.now()): number {
  if (!timer) return 0;
  return timer.status === 'paused'
    ? timer.remaining_seconds
    : Math.min(maxSeconds, Math.max(0, Math.ceil((Date.parse(timer.ends_at!) - now) / 1000)));
}
/** 只累计真实倒计时运行秒数，暂停与延长目标不会凭空增加休息历史。 */
export function restElapsed(timer: RestTimer, now = Date.now()): number {
  const running =
    timer.status === 'paused'
      ? 0
      : timer.remaining_seconds - Math.min(timer.remaining_seconds, restRemaining(timer, now));
  return Math.min(maxSeconds, Math.max(0, (timer.elapsed_seconds ?? 0) + running));
}
/** 结束前将本轮已运行休息写入触发组；清除计时器使重试不会重复累计。 */
export function settleRest(payload: WorkoutPayload, now = Date.now()): WorkoutPayload {
  const result = structuredClone(payload);
  const timer = result.rest_timer;
  result.rest_timer = null;
  if (!timer) return result;
  const group = result.exercises
    .find((exercise) => exercise.id === timer.exercise_id)
    ?.sets.find((set) => set.id === timer.set_id);
  if (group?.completed) {
    if ((group.rest_durations_seconds?.length ?? 0) >= 1000)
      throw new Error('该组休息历史已达上限，请先保存当前记录。');
    group.rest_durations_seconds = [...(group.rest_durations_seconds ?? []), restElapsed(timer, now)];
  }
  return result;
}
/** 与手机同一计时语义：新休息先结算旧休息，暂停保存累计值，调整只改变剩余目标。 */
export function changeRest(
  payload: WorkoutPayload,
  action: 'start' | 'pause' | 'resume' | 'finish' | 'adjust',
  seconds = 90,
  now = Date.now(),
): WorkoutPayload {
  if (payload.status !== 'in_progress') throw new Error('请先开始训练。');
  if (!Number.isInteger(seconds) || Math.abs(seconds) > maxSeconds) throw new Error('请输入有效的休息秒数。');
  let result = structuredClone(payload);
  const timer = result.rest_timer;
  if (action === 'start' || action === 'finish') {
    result = settleRest(result, now);
    if (action === 'start') {
      if (seconds < 0) throw new Error('休息时间不能为负数。');
      result.rest_timer =
        seconds === 0
          ? null
          : {
              status: 'running',
              ends_at: new Date(now + seconds * 1000).toISOString(),
              remaining_seconds: seconds,
              duration_seconds: seconds,
              elapsed_seconds: 0,
              exercise_id: timer?.exercise_id ?? null,
              set_id: timer?.set_id ?? null,
            };
    }
  } else {
    if (!timer) throw new Error('没有正在进行的休息。');
    if (action === 'pause')
      result.rest_timer = {
        ...timer,
        status: 'paused',
        ends_at: null,
        remaining_seconds: restRemaining(timer, now),
        elapsed_seconds: restElapsed(timer, now),
      };
    if (action === 'resume')
      result.rest_timer =
        timer.status === 'running'
          ? timer
          : { ...timer, status: 'running', ends_at: new Date(now + timer.remaining_seconds * 1000).toISOString() };
    if (action === 'adjust') {
      const remaining = Math.min(maxSeconds, Math.max(0, restRemaining(timer, now) + seconds));
      result.rest_timer = {
        ...timer,
        remaining_seconds: remaining,
        elapsed_seconds: restElapsed(timer, now),
        ends_at: timer.status === 'running' ? new Date(now + remaining * 1000).toISOString() : null,
      };
    }
  }
  result.updated_at = new Date(Math.max(now, Date.parse(result.updated_at))).toISOString();
  return result;
}
/** 勾选有效组可启动训练，并按组类型应用空间休息设置；取消时保留独立运行计时。 */
export function completeSet(
  payload: WorkoutPayload,
  exerciseId: string,
  setId: string,
  completed: boolean,
  preferences?: FitnessPreferences,
  now = Date.now(),
): WorkoutPayload {
  let result = structuredClone(payload);
  let exercise = result.exercises.find((entry) => entry.id === exerciseId);
  let set = exercise?.sets.find((entry) => entry.id === setId);
  if (!exercise || !set) throw new Error('训练组不存在，请刷新。');
  if (set.completed === completed) return result;
  if (
    completed &&
    (!Number.isInteger(set.reps) ||
      !set.reps ||
      set.reps < 1 ||
      (set.weight_left === null) !== (set.weight_right === null))
  )
    throw new Error('请先填写有效次数，左右重量需要成对填写。');
  if (completed) {
    if (result.status === 'scheduled') {
      result.status = 'in_progress';
      result.run_segments.push({ started_at: new Date(now).toISOString(), ended_at: null });
    }
    result = settleRest(result, now);
    exercise = result.exercises.find((entry) => entry.id === exerciseId)!;
    set = exercise.sets.find((entry) => entry.id === setId)!;
  } else if (result.rest_timer?.exercise_id === exerciseId && result.rest_timer.set_id === setId) {
    result.rest_timer = { ...result.rest_timer, exercise_id: null, set_id: null };
  }
  set.completed = completed;
  if (!completed) set.rest_durations_seconds = [];
  if (completed && result.status === 'in_progress') {
    const setting = preferences?.exercise_rest_settings?.[exercise.exercise_id];
    const seconds =
      set.kind === 'warmup'
        ? (setting?.warmup_rest_seconds ?? exercise.warmup_rest_seconds ?? exercise.rest_seconds)
        : (setting?.rest_seconds ?? exercise.rest_seconds);
    result.rest_timer =
      seconds === 0
        ? null
        : {
            status: 'running',
            ends_at: new Date(now + seconds * 1000).toISOString(),
            remaining_seconds: seconds,
            duration_seconds: seconds,
            elapsed_seconds: 0,
            exercise_id: exerciseId,
            set_id: setId,
          };
  }
  result.updated_at = new Date(Math.max(now, Date.parse(result.updated_at))).toISOString();
  return result;
}
