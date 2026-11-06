import { describe, expect, it } from 'vitest';
import { newWorkout, transitionWorkout, validWeight, workoutPayload, type Workout } from './fitness-model';

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
});
