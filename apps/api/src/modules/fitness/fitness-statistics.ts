import { Value } from '@sinclair/typebox/value';
import { ApiError } from '../../shared/errors.js';
import { addPlanDays } from './fitness-plan-generation.js';
import { validateCompletedFitnessSet } from './fitness-rules.js';
import { fitnessPayloadSchemas, type FitnessPlanPayload, type FitnessWorkoutPayload } from './fitness-schemas.js';

export type StatisticsWorkout = FitnessWorkoutPayload & { id: string; revision: number };
export type CalendarPlan = FitnessPlanPayload & { id: string };
type DateContext = { start: string; end: string; localDate: (value: string) => string };

/** 使用明确 IANA 时区确定归档日期，包含夏令时，不把服务器本地时区当作用户时区。 */
export function fitnessDateContext(start: string, end: string, timeZone: string): DateContext {
  try {
    addPlanDays(start, 0);
    addPlanDays(end, 0);
    if (start > end) throw new Error('INVALID_RANGE');
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    return {
      start,
      end,
      localDate: (value) => {
        const parts = formatter.formatToParts(new Date(value));
        const get = (type: string) => parts.find((part) => part.type === type)!.value;
        return `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
      },
    };
  } catch {
    throw new ApiError(400, 'INVALID_FITNESS_DATE_RANGE', '日期范围或时区无效');
  }
}

/** 训练归档日与移动端一致：首段开始日期；尚未开始才使用计划日期。 */
function workoutDate(workout: FitnessWorkoutPayload, context: DateContext): string {
  return workout.run_segments[0] ? context.localDate(workout.run_segments[0].started_at) : workout.scheduled_date;
}

/** 保留完整数据范围的训练统计；热身计入训练日与组数，但不计入工作组训练量。 */
export function summarizeFitness(workouts: StatisticsWorkout[], context: DateContext) {
  const dates = new Map<
    string,
    { date: string; completed_workouts: number; completed_sets: number; duration_ms: number; volume: bigint }
  >();
  const exercises = new Map<
    string,
    { exercise_id: string; completed_sets: number; working_sets: number; volume: bigint }
  >();
  const trainingDays = new Set<string>();
  let totalDuration = 0;
  let completedWorkouts = 0;
  let completedSets = 0;
  let volume = 0n;
  for (const workout of new Map(workouts.map((item) => [item.id, item])).values()) {
    const date = workoutDate(workout, context);
    if (workout.status !== 'completed' || date < context.start || date > context.end) continue;
    const duration = workout.run_segments.reduce(
      (sum, segment) =>
        sum + (segment.ended_at ? Math.max(0, Date.parse(segment.ended_at) - Date.parse(segment.started_at)) : 0),
      0,
    );
    const day = dates.get(date) ?? { date, completed_workouts: 0, completed_sets: 0, duration_ms: 0, volume: 0n };
    completedWorkouts += 1;
    totalDuration += duration;
    day.completed_workouts += 1;
    day.duration_ms += duration;
    for (const exercise of workout.exercises) {
      for (const set of exercise.sets) {
        try {
          // 存储查询返回 JSON，进入计算前复用 wire 结构；写入路径已整体校验，仅复用下方业务规则。
          if (!Value.Check(fitnessPayloadSchemas.fitness_workout.properties.exercises.items.properties.sets.items, set))
            throw new Error('训练组字段无效');
          if (!set.completed) continue;
          validateCompletedFitnessSet(set);
        } catch (cause) {
          // 持久化的完成事实违反契约属于服务端数据错误，HTTP 边界保留原因并统一记录。
          throw new Error(`健身统计数据无效：训练 ${workout.id}`, { cause });
        }
        trainingDays.add(date);
        completedSets += 1;
        day.completed_sets += 1;
        const value = exercises.get(exercise.exercise_id) ?? {
          exercise_id: exercise.exercise_id,
          completed_sets: 0,
          working_sets: 0,
          volume: 0n,
        };
        value.completed_sets += 1;
        if (set.kind === 'working') {
          const amount =
            (set.weight !== null
              ? weightUnits(set.weight)
              : weightUnits(set.weight_left) + weightUnits(set.weight_right)) * BigInt(set.reps!);
          value.working_sets += 1;
          value.volume += amount;
          day.volume += amount;
          volume += amount;
        }
        exercises.set(exercise.exercise_id, value);
      }
    }
    dates.set(date, day);
  }
  return {
    training_days: trainingDays.size,
    completed_workouts: completedWorkouts,
    completed_sets: completedSets,
    total_duration_ms: totalDuration,
    volume_kg: formatVolume(volume),
    by_date: [...dates.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(({ volume: dayVolume, ...day }) => ({ ...day, volume_kg: formatVolume(dayVolume) })),
    by_exercise: [...exercises.values()]
      .sort((a, b) =>
        a.volume === b.volume ? a.exercise_id.localeCompare(b.exercise_id) : a.volume > b.volume ? -1 : 1,
      )
      .map(({ volume: exerciseVolume, ...exercise }) => ({ ...exercise, volume_kg: formatVolume(exerciseVolume) })),
  };
}

/** 汇总完整日历范围，保留跨日训练以及后续计划周期对旧休息日的覆盖规则。 */
export function fitnessCalendar(
  workouts: StatisticsWorkout[],
  plans: CalendarPlan[],
  context: DateContext,
  now = new Date(),
) {
  const length =
    (Date.parse(`${context.end}T00:00:00.000Z`) - Date.parse(`${context.start}T00:00:00.000Z`)) / 86400000 + 1;
  if (length > 366) throw new ApiError(400, 'FITNESS_CALENDAR_RANGE_LIMIT', '单次日历查询最多一年');
  const restDays: Array<{ date: string; source_plan_id: string; source_plan_name: string }> = [];
  for (const plan of plans) {
    const dates = new Set<string>();
    for (const cycle of [...plan.generation_state.generated_cycles].sort((a, b) => a.cycle_index - b.cycle_index)) {
      const end = addPlanDays(cycle.start_date, cycle.cycle_days);
      for (const date of dates) if (date >= cycle.generated_from_date && date < end) dates.delete(date);
      for (const date of cycle.rest_dates) dates.add(date);
    }
    for (const date of dates)
      if (date >= context.start && date <= context.end)
        restDays.push({ date, source_plan_id: plan.id, source_plan_name: plan.name });
  }
  // 日期换算只做一次，年度视图不重复执行 days × workouts × segments 次 Intl 转换。
  const nowIso = now.toISOString();
  const unique = [...new Map(workouts.map((item) => [item.id, item])).values()].map((workout) => ({
    workout,
    workout_date: workoutDate(workout, context),
    segments: workout.run_segments.map((segment) => ({
      start: context.localDate(segment.started_at),
      end: context.localDate(segment.ended_at ?? nowIso),
    })),
  }));
  const rank: Record<string, number> = { in_progress: 0, completed: 1, scheduled: 2 };
  return {
    days: Array.from({ length }, (_, index) => {
      const date = addPlanDays(context.start, index);
      const matches = unique.filter(
        ({ workout, workout_date: archiveDate, segments }) =>
          workout.scheduled_date === date ||
          archiveDate === date ||
          segments.some((segment) => segment.start <= date && segment.end >= date),
      );
      matches.sort(
        (a, b) =>
          (rank[a.workout.status] ?? 3) - (rank[b.workout.status] ?? 3) || a.workout.id.localeCompare(b.workout.id),
      );
      return {
        date,
        workouts: matches.map(({ workout, workout_date: archiveDate }) => ({
          id: workout.id,
          name: workout.name,
          status: workout.status,
          scheduled_date: workout.scheduled_date,
          workout_date: archiveDate,
          source_plan_id: workout.source_plan_id,
          source_plan_name: workout.source_plan_name,
          revision: workout.revision,
        })),
        rest_days: restDays.filter((day) => day.date === date).map(({ date: _date, ...day }) => day),
      };
    }),
  };
}

/** 以固定十位小数保存重量，乘次数及求和全过程使用整数。 */
function weightUnits(weight: string | null): bigint {
  if (weight === null) return 0n;
  const [integer = '0', fraction = ''] = weight.split('.');
  return BigInt(integer + fraction.padEnd(10, '0'));
}

/** 训练量独立于记账金额上限，输出不丢精度的规范十进制字符串。 */
function formatVolume(volume: bigint): string {
  const whole = volume / 10000000000n;
  const fraction = (volume % 10000000000n).toString().padStart(10, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
