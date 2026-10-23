import { describe, expect, it } from 'vitest';
import { newWorkout, validateWorkout, type FitnessPreferences, type WorkoutExercise } from './fitness-model';
import { preferencesPayload } from './preferences-model';
import { setExerciseWeightMode, usesSideWeight } from './weight-mode';

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

  it('同动作已有成绩决定全部实例口径，全部空白时采用偏好和器械默认值', () => {
    const item = exercise('blank');
    item.sets[0]!.weight = null;
    const preferences: FitnessPreferences = {
      ...preferencesPayload(),
      id: 'space',
      fitness_space_id: 'space',
      sync_id: 'sync',
      revision: 1,
      deleted_at: null,
      custom_exercises: [
        {
          id: '0025',
          name: '动作',
          body_part: 'chest',
          equipment: 'dumbbell',
          icon: 'dumbbell',
          image: null,
          deleted: false,
        },
      ],
    };
    expect(usesSideWeight([item], item.exercise_id, undefined, preferences)).toBe(true);
    expect(setExerciseWeightMode([item], '0025', true)[0]!.sets[0]!.weight_left).toBeNull();
    item.sets[0]!.weight = '20';
    expect(usesSideWeight([item], item.exercise_id, undefined, preferences)).toBe(false);
    const blank = { ...item, id: 'other', sets: item.sets.map((set) => ({ ...set, weight: null })) };
    expect(usesSideWeight([item, blank], item.exercise_id, undefined, preferences)).toBe(false);
    preferences.exercise_weight_modes['0025'] = true;
    expect(usesSideWeight([item, blank], item.exercise_id, undefined, preferences)).toBe(false);
    expect(usesSideWeight([blank], item.exercise_id, undefined, preferences)).toBe(true);
    item.sets[0]!.weight = null;
    item.sets[0]!.weight_left = '10';
    item.sets[0]!.weight_right = '10';
    preferences.exercise_weight_modes['0025'] = false;
    expect(usesSideWeight([item, blank], item.exercise_id, undefined, preferences)).toBe(true);
    expect(usesSideWeight([blank], item.exercise_id, undefined, preferences)).toBe(false);
  });

  it('禁止同动作跨组或跨实例混用重量口径，允许不同动作和空白组', () => {
    const payload = newWorkout('训练', '2026-10-19');
    const first = exercise('first');
    const second = setExerciseWeightMode([exercise('second')], '0025', true)[0]!;
    payload.exercises = [first, second];
    expect(validateWorkout(payload)).toBe('同一动作的全部组请使用相同的重量口径。');
    payload.exercises = [{ ...first, sets: [...first.sets, ...second.sets] }];
    expect(validateWorkout(payload)).toBe('同一动作的全部组请使用相同的重量口径。');
    second.exercise_id = '0001';
    payload.exercises = [first, second];
    expect(validateWorkout(payload)).toBeNull();
    first.sets[0]!.weight = null;
    second.exercise_id = '0025';
    expect(validateWorkout(payload)).toBeNull();
  });
});
