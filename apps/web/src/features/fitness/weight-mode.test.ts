import { describe, expect, it } from 'vitest';
import type { WorkoutExercise } from './fitness-model';
import { setExerciseWeightMode } from './weight-mode';

/** 构造带成绩和执行历史的动作，检查切换只改变重量字段。 */
function exercise(id: string, exerciseId = '0025'): WorkoutExercise {
  return {
    id,
    exercise_id: exerciseId,
    rest_seconds: 90,
    warmup_rest_seconds: 45,
    sets: [
      {
        id: `${id}-set`,
        kind: 'working',
        weight: '20.1234567890',
        weight_left: null,
        weight_right: null,
        reps: 8,
        completed: true,
        rest_durations_seconds: [90],
      },
    ],
  };
}

describe('动作重量口径', () => {
  it('切换统一影响同动作全部实例，精确保留成绩、身份和其他动作', () => {
    const before = [exercise('first'), exercise('second'), exercise('other', '0001')];
    const sides = setExerciseWeightMode(before, '0025', true);
    for (const item of sides.slice(0, 2)) {
      expect(item.sets[0]).toMatchObject({
        weight: null,
        weight_left: '20.1234567890',
        weight_right: '20.1234567890',
        reps: 8,
        completed: true,
        rest_durations_seconds: [90],
      });
    }
    expect(sides[2]).toBe(before[2]);
    expect(before[0]!.sets[0]!.weight).toBe('20.1234567890');
    const total = setExerciseWeightMode(sides, '0025', false);
    expect(total[0]!.sets[0]).toMatchObject({ weight: null, weight_left: null, weight_right: null });
  });
});
