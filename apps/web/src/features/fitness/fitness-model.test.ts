import { describe, expect, it } from 'vitest';
import {
  workoutElapsed,
  importTemplate,
  localToday,
  newWorkout,
  transitionWorkout,
  validateWorkout,
  validDate,
  validWeight,
  workoutPayload,
  type OfficialTemplate,
  type Workout,
} from './fitness-model';

/** 建立包含真实同步身份和版本字段的训练快照。 */
function snapshot(): Workout {
  return {
    ...newWorkout('上肢训练', '2026-10-01', undefined, '2026-10-01T08:00:00.000Z'),
    id: '3a0b7ad9-29cd-4af6-b96a-cc0cbf794264',
    fitness_space_id: '2c6e986b-9e53-4d5b-a93a-0b46ad2f1b9f',
    sync_id: '905b0f7f-79a3-499f-b0c9-978cf1b9653d',
    revision: 3,
    deleted_at: null,
  };
}

describe('健身 Web 与移动端载荷兼容', () => {
  it('不接受自动滚动日期，也不将本地日期经 UTC 改日', () => {
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2024-02-29')).toBe(true);
    expect(validDate('0000-01-01')).toBe(false);
    expect(localToday(new Date(2026, 9, 1, 23, 59))).toBe('2026-10-01');
  });
  it('保留高精度重量，不接受指数、负值或前导零', () => {
    expect(validWeight('999999999999999999.1234567890')).toBe(true);
    expect(validWeight(null)).toBe(true);
    expect(validWeight('01')).toBe(false);
    expect(validWeight('1e3')).toBe(false);
    expect(validWeight('-1')).toBe(false);
    expect(validWeight('0.12345678901')).toBe(false);
  });
  it('编辑快照保留训练历史，且不把快照元数据写回业务载荷', () => {
    const before = snapshot();
    before.exercises = [
      {
        id: crypto.randomUUID(),
        exercise_id: '0025',
        rest_seconds: 90,
        warmup_rest_seconds: 45,
        sets: [
          {
            id: crypto.randomUUID(),
            kind: 'working',
            weight: null,
            weight_left: '20.1234567890',
            weight_right: '21.2',
            reps: 8,
            completed: true,
            rest_durations_seconds: [84, 91],
          },
        ],
      },
    ];
    const payload = workoutPayload(before);
    expect(payload.exercises).toEqual(before.exercises);
    expect(payload).not.toHaveProperty('revision');
    expect(payload).not.toHaveProperty('fitness_space_id');
    payload.exercises[0]!.sets[0]!.weight_left = '25';
    expect(before.exercises[0]!.sets[0]!.weight_left).toBe('20.1234567890');
  });
  it('开始、暂停、继续、完成只追加或结束运行时段', () => {
    const first = snapshot();
    const running = { ...first, ...transitionWorkout(first, 'start', '2026-10-01T08:01:00.000Z') };
    const paused = { ...running, ...transitionWorkout(running, 'pause', '2026-10-01T08:11:00.000Z') };
    const resumed = { ...paused, ...transitionWorkout(paused, 'resume', '2026-10-01T08:20:00.000Z') };
    const complete = transitionWorkout(resumed, 'complete', '2026-10-01T08:25:00.000Z');
    expect(complete.status).toBe('completed');
    expect(complete.run_segments).toEqual([
      { started_at: '2026-10-01T08:01:00.000Z', ended_at: '2026-10-01T08:11:00.000Z' },
      { started_at: '2026-10-01T08:20:00.000Z', ended_at: '2026-10-01T08:25:00.000Z' },
    ]);
    expect(workoutElapsed(complete)).toBe(15 * 60000);
    expect(first.run_segments).toEqual([]);
    expect(() => transitionWorkout({ ...first, ...complete }, 'pause')).toThrow('训练状态已变化');
  });
  it('客户端时钟回退不能破坏训练时段，完成训练结算并清除休息', () => {
    const running = {
      ...snapshot(),
      status: 'in_progress' as const,
      run_segments: [{ started_at: '2026-10-01T08:01:00.000Z', ended_at: null }],
    };
    expect(transitionWorkout(running, 'complete', '2026-10-01T07:00:00.000Z').run_segments[0]?.ended_at).toBe(
      '2026-10-01T08:01:00.000Z',
    );
    running.rest_timer = null;
    const timed = {
      ...running,
      rest_timer: { status: 'paused' as const, ends_at: null, remaining_seconds: 30, duration_seconds: 90 },
    };
    expect(transitionWorkout(timed, 'complete').rest_timer).toBeNull();
  });
  it('已完成组需有效次数和成对左右重量', () => {
    const payload = workoutPayload(snapshot());
    payload.exercises = [
      {
        id: crypto.randomUUID(),
        exercise_id: '0025',
        rest_seconds: 90,
        warmup_rest_seconds: null,
        sets: [
          {
            id: crypto.randomUUID(),
            kind: 'working',
            weight: null,
            weight_left: '20',
            weight_right: null,
            reps: 8,
            completed: true,
          },
        ],
      },
    ];
    expect(validateWorkout(payload)).toContain('成对');
    payload.exercises[0]!.sets[0]!.weight_right = '20';
    expect(validateWorkout(payload)).toBeNull();
    payload.exercises[0]!.sets[0]!.reps = 0;
    expect(validateWorkout(payload)).toContain('正整数');
  });
  it('导入官方模板创建独立身份并保存每侧重量和来源版本', () => {
    const template: OfficialTemplate = {
      id: crypto.randomUUID(),
      revision: 2,
      name: { zh: '力量入门', zh_hant: '力量入門', en: 'Strength' },
      description: { zh: '', zh_hant: '', en: '' },
      difficulty: 'beginner',
      duration_minutes: 30,
      goals: { zh: [], zh_hant: [], en: [] },
      equipment: ['dumbbell'],
      exercises: [
        { exercise_id: '0025', sets: 2, reps: 8, weight_kg: '12.25', weight_mode: 'per_side', rest_seconds: 90 },
      ],
    };
    const imported = importTemplate(template);
    expect(imported.catalog_origin).toEqual({ source: 'official', item_id: template.id, revision: 2 });
    expect(imported.exercises[0]!.sets[0]).toMatchObject({
      weight: null,
      weight_left: '12.25',
      weight_right: '12.25',
      reps: 8,
    });
    expect(imported.exercises[0]!.sets[0]!.id).not.toBe(imported.exercises[0]!.sets[1]!.id);
    expect(imported.exercises[0]!.sets[0]).not.toHaveProperty('completed');
  });
  it('累计训练计时包含开启段，暂停间隔和回拨时间不增加时长', () => {
    const workout = snapshot();
    workout.run_segments = [
      { started_at: '2026-10-01T08:00:00Z', ended_at: '2026-10-01T08:10:00Z' },
      { started_at: '2026-10-01T08:20:00Z', ended_at: null },
    ];
    expect(workoutElapsed(workout, Date.parse('2026-10-01T08:25:30Z'))).toBe(930000);
    expect(workoutElapsed(workout, Date.parse('2026-10-01T08:19:00Z'))).toBe(600000);
    workout.run_segments[1]!.ended_at = '2026-10-01T08:21:00Z';
    expect(workoutElapsed(workout, Date.parse('2026-10-01T09:00:00Z'))).toBe(660000);
  });
});
