import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fitnessCalendar,
  fitnessDateContext,
  summarizeFitness,
  validateFitnessPayload,
  type StatisticsWorkout,
  type CalendarPlan,
} from '../src/modules/fitness/testing.js';
import { fitnessWorkout, fitnessExercise, fitnessPlan } from './fitness-fixtures.js';

/** 构造合法完成训练，以精确小数和跨日时间覆盖移动端统计规则。 */
function workout(overrides: Partial<StatisticsWorkout> = {}): StatisticsWorkout {
  return {
    ...fitnessWorkout(),
    id: randomUUID(),
    revision: 1,
    status: 'completed',
    exercises: [fitnessExercise(true) as StatisticsWorkout['exercises'][number]],
    run_segments: [{ started_at: '2026-09-11T01:00:00.000Z', ended_at: '2026-09-11T01:30:00.000Z' }],
    ...overrides,
  };
}
describe('健身完整统计规则', () => {
  it('包含热身训练天数、零组时长，训练量仅计有效完成正式组并精确去重', () => {
    const main = workout();
    main.exercises[0]!.sets.push({
      ...main.exercises[0]!.sets[0]!,
      id: randomUUID(),
      weight: null,
      weight_left: '1.0000000001',
      weight_right: '2.0000000002',
      reps: 3,
    });
    const warmup = workout({
      scheduled_date: '2026-09-12',
      run_segments: [{ started_at: '2026-09-12T01:00:00.000Z', ended_at: '2026-09-12T01:30:00.000Z' }],
    });
    warmup.exercises[0]!.sets[0]!.kind = 'warmup';
    const empty = workout({
      exercises: [],
      run_segments: [{ started_at: '2026-09-13T01:00:00.000Z', ended_at: '2026-09-13T01:30:00.000Z' }],
    });
    const result = summarizeFitness(
      [main, main, warmup, empty, workout({ status: 'in_progress' })],
      fitnessDateContext('2026-09-01', '2026-09-30', 'UTC'),
    );
    expect(result).toMatchObject({
      training_days: 2,
      completed_workouts: 3,
      completed_sets: 3,
      total_duration_ms: 5400000,
      volume_kg: '509.0000000017',
    });
    expect(result.by_exercise).toEqual([
      { exercise_id: '0025', completed_sets: 3, working_sets: 2, volume_kg: '509.0000000017' },
    ]);
  });
  it('使用用户 IANA 时区第一段开始日归档，正确经过夏令时切换', () => {
    const a = workout({
      scheduled_date: '2026-03-10',
      run_segments: [{ started_at: '2026-03-08T07:30:00.000Z', ended_at: '2026-03-08T10:30:00.000Z' }],
    });
    const result = summarizeFitness([a], fitnessDateContext('2026-03-07', '2026-03-07', 'America/Los_Angeles'));
    expect(result.by_date[0]).toMatchObject({ date: '2026-03-07', duration_ms: 10800000 });
    expect(summarizeFitness([a], fitnessDateContext('2026-03-08', '2026-03-08', 'UTC')).completed_workouts).toBe(1);
  });
  it('未完成草稿不参与统计，自重完成组保留训练天数与零训练量', () => {
    const a = workout();
    const set = a.exercises[0]!.sets[0]!;
    set.completed = false;
    set.reps = null;
    set.weight = null;
    set.weight_left = '5';
    const body = workout();
    body.exercises[0]!.sets[0]!.weight = null;
    const result = summarizeFitness([a, body], fitnessDateContext('2026-09-11', '2026-09-11', 'UTC'));
    expect(result).toMatchObject({ completed_sets: 1, training_days: 1, volume_kg: '0' });
  });
  it.each([
    { reps: null },
    { reps: 0 },
    { weight: null, weight_left: '5', weight_right: null },
    { weight: 'NaN' },
    { kind: 'warmup', reps: null },
  ])('非法完成组在写入与统计中明确失败，不能静默少算：%j', (fields) => {
    const invalid = workout();
    Object.assign(invalid.exercises[0]!.sets[0]!, fields);
    const { id: _id, revision: _revision, ...payload } = invalid;
    expect(() => validateFitnessPayload('fitness_workout', payload)).toThrow();
    expect(() => summarizeFitness([workout(), invalid], fitnessDateContext('2026-09-11', '2026-09-11', 'UTC'))).toThrow(
      '健身统计数据无效',
    );
  });
  it.each([
    ['2026-02-30', '2026-03-01', 'UTC'],
    ['2026-10-01', '2026-09-01', 'UTC'],
    ['2026-09-01', '2026-10-01', 'invalid/time'],
  ])('拒绝无效范围或时区 %s %s %s', (start, end, zone) =>
    expect(() => fitnessDateContext(start!, end!, zone!)).toThrow(),
  );
});
describe('完整训练日历', () => {
  it('计划日、归档日和跨日运行区间均可显示，同一日去重', () => {
    const a = workout({
      scheduled_date: '2026-09-09',
      run_segments: [{ started_at: '2026-09-11T23:00:00.000Z', ended_at: '2026-09-12T01:00:00.000Z' }],
    });
    const result = fitnessCalendar([a, a], [], fitnessDateContext('2026-09-09', '2026-09-12', 'UTC'));
    expect(result.days.map((day) => day.workouts.length)).toEqual([1, 0, 1, 1]);
    expect(result.days[0]!.workouts[0]!.workout_date).toBe('2026-09-11');
  });
  it('新生成周期覆盖旧休息日，并限制单次日历跨度', () => {
    const plan = { ...fitnessPlan(), id: randomUUID() } as CalendarPlan;
    plan.generation_state.generated_cycles.push({
      cycle_index: 1,
      start_date: '2026-09-12',
      cycle_days: 2,
      generated_from_date: '2026-09-12',
      rest_dates: ['2026-09-13'],
    });
    const result = fitnessCalendar([], [plan], fitnessDateContext('2026-09-11', '2026-09-13', 'UTC'));
    expect(result.days.map((day) => day.rest_days.length)).toEqual([0, 0, 1]);
    expect(() => fitnessCalendar([], [], fitnessDateContext('2025-01-01', '2026-12-31', 'UTC'))).toThrow();
  });
});
