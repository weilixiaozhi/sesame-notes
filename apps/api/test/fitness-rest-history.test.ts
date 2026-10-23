import { expect, it } from 'vitest';
import { validateFitnessPayload } from '../src/modules/fitness/testing.js';
import { fitnessExercise, fitnessTime, fitnessWorkout } from './fitness-fixtures.js';

it('按组休息历史只接受非负整数，计时关联必须属于当前训练的完成组', () => {
  const exercise = fitnessExercise(true);
  const set = { ...exercise.sets[0]!, rest_durations_seconds: [0, 17, 42] };
  const payload = {
    ...fitnessWorkout(),
    status: 'in_progress',
    run_segments: [{ started_at: fitnessTime, ended_at: null }],
    exercises: [{ ...exercise, sets: [set] }],
    rest_timer: {
      status: 'paused',
      ends_at: null,
      remaining_seconds: 30,
      duration_seconds: 90,
      elapsed_seconds: 17,
      exercise_id: exercise.id,
      set_id: set.id,
    },
  };
  expect(() => validateFitnessPayload('fitness_workout', payload)).not.toThrow();
  for (const rest of [[-1], [0.5], ['17'], null, Array.from({ length: 1001 }).fill(1)]) {
    expect(() =>
      validateFitnessPayload('fitness_workout', {
        ...payload,
        exercises: [{ ...exercise, sets: [{ ...set, rest_durations_seconds: rest }] }],
      }),
    ).toThrow();
  }
  expect(() =>
    validateFitnessPayload('fitness_workout', {
      ...payload,
      exercises: [{ ...exercise, sets: [{ ...set, completed: false }] }],
    }),
  ).toThrow();
  for (const timer of [
    { ...payload.rest_timer, elapsed_seconds: -1 },
    { ...payload.rest_timer, elapsed_seconds: null },
    { ...payload.rest_timer, exercise_id: null },
    { ...payload.rest_timer, set_id: exercise.id },
  ])
    expect(() => validateFitnessPayload('fitness_workout', { ...payload, rest_timer: timer })).toThrow();
});
