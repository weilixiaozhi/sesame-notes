import { randomUUID } from 'node:crypto';
import { uuidV5 } from '../src/shared/uuid.js';

export const fitnessTime = '2026-09-11T01:02:03.789Z';
export const fitnessTimes = { created_at: fitnessTime, updated_at: fitnessTime };

export function fitnessExercise(completed?: boolean) {
  return {
    id: randomUUID(),
    exercise_id: '0025',
    rest_seconds: 90,
    warmup_rest_seconds: null,
    sets: [
      {
        id: randomUUID(),
        kind: 'working',
        weight: '62.5000000001',
        weight_left: null,
        weight_right: null,
        reps: 8,
        ...(completed === undefined ? {} : { completed }),
      },
    ],
  };
}
export function fitnessTemplate() {
  return { name: '胸部训练', exercises: [fitnessExercise()], ...fitnessTimes };
}
export function fitnessPlan() {
  return {
    name: '独立计划',
    start_date: '2026-09-11',
    status: 'in_progress',
    cycle_days: 2,
    days: [
      {
        day_index: 0,
        slot: { id: randomUUID(), source_template_id: null, name: '训练', exercises: [fitnessExercise()] },
      },
      { day_index: 1, slot: null },
    ],
    generation_state: {
      next_cycle_start_date: '2026-09-13',
      next_cycle_index: 1,

      generated_cycles: [
        {
          cycle_index: 0,
          start_date: '2026-09-11',
          cycle_days: 2,
          generated_from_date: '2026-09-11',
          rest_dates: ['2026-09-12'],
        },
      ],
    },
    pending_schedule: null,
    ...fitnessTimes,
  };
}
export function fitnessWorkout() {
  return {
    name: '空白训练',
    scheduled_date: '2026-09-11',
    source_kind: 'blank',
    source_plan_id: null,
    source_plan_name: null,
    source_template_id: null,
    occurrence_key: null,
    exercises: [],
    status: 'scheduled',
    run_segments: [],
    rest_timer: null,
    ...fitnessTimes,
  };
}
export function plannedWorkout(planId: string, slotId: string) {
  const occurrence = `${planId}:0:0:${slotId}`;
  return {
    id: uuidV5(planId, occurrence),
    payload: {
      ...fitnessWorkout(),
      source_kind: 'plan',
      source_plan_id: planId,
      source_plan_name: '生成时名称',
      occurrence_key: occurrence,
    },
  };
}
export function fitnessPreferences() {
  return {
    default_rest_seconds: 90,
    sound_enabled: true,
    vibration_enabled: true,
    custom_exercises: [],
    pinned_exercise_ids: [],
    exercise_weight_modes: {},
    ...fitnessTimes,
  };
}
