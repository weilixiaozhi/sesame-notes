import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addPlanDays,
  generatePlanCycles,
  preparePlanSave,
  validateFitnessPayload,
  validateFitnessTransition,
  type FitnessPlanPayload,
} from '../src/modules/fitness/testing.js';
import { fitnessPlan, fitnessTime } from './fitness-fixtures.js';
import { uuidV5 } from '../src/shared/uuid.js';

/** 复用协议测试样本，清空生成历史得到新建计划。 */
function fresh(): FitnessPlanPayload {
  return {
    ...fitnessPlan(),
    generation_state: { next_cycle_start_date: null, next_cycle_index: 0, generated_cycles: [] },
  } as FitnessPlanPayload;
}

describe('atomic plan generation rules', () => {
  it('generates the first complete cycle even for a future start and uses mobile UUIDv5 identities', () => {
    const id = randomUUID();
    const input = fresh();
    input.start_date = '2026-09-30';
    const result = generatePlanCycles(id, input, '2026-09-11', fitnessTime);
    expect(result.workouts).toHaveLength(1);
    expect(result.plan.generation_state.next_cycle_start_date).toBe('2026-10-02');
    const key = `${id}:0:0:${input.days[0]!.slot!.id}`;
    expect(result.workouts[0]!.id).toBe(uuidV5(id, key));
    expect(result.workouts[0]!.payload.occurrence_key).toBe(key);
    expect(result.workouts[0]!.payload.exercises[0]!.sets[0]!.weight).toBe('62.5000000001');
    expect(result.workouts[0]!.payload.exercises[0]!.sets[0]!.completed).toBe(false);
    expect(input.generation_state.generated_cycles).toHaveLength(0);
    validateFitnessPayload('fitness_plan', result.plan);
    validateFitnessPayload('fitness_workout', result.workouts[0]!.payload);
  });

  it('does not regenerate an existing current cycle and advances only due cycles', () => {
    const input = fitnessPlan() as FitnessPlanPayload;
    expect(generatePlanCycles(randomUUID(), input, '2026-09-12', fitnessTime).workouts).toHaveLength(0);
    const result = generatePlanCycles(randomUUID(), input, '2026-09-15', fitnessTime);
    expect(result.workouts.map((row) => row.payload.scheduled_date)).toEqual(['2026-09-13', '2026-09-15']);
    expect(result.plan.generation_state.generated_cycles[0]).toEqual(input.generation_state.generated_cycles[0]);
    expect(result.plan.generation_state.next_cycle_start_date).toBe('2026-09-17');
    validateFitnessTransition('fitness_plan', input, result.plan);
  });

  it('queues schedule edits after generated cycles and applies them exactly once', () => {
    const previous = fitnessPlan() as FitnessPlanPayload;
    const changed = structuredClone(previous);
    changed.cycle_days = 3;
    changed.days.push({ day_index: 2, slot: null });
    const { plan } = preparePlanSave(changed, previous, '2026-09-12', fitnessTime);
    expect(plan.cycle_days).toBe(2);
    expect(plan.pending_schedule?.cycle_days).toBe(3);
    expect(generatePlanCycles(randomUUID(), plan, '2026-09-12', fitnessTime).plan.pending_schedule).not.toBeNull();
    const generated = generatePlanCycles(randomUUID(), plan, '2026-09-13', fitnessTime);
    expect(generated.plan.cycle_days).toBe(3);
    expect(generated.plan.pending_schedule).toBeNull();
    expect(generated.plan.generation_state.next_cycle_start_date).toBe('2026-09-16');
    expect(generated.plan.generation_state.generated_cycles[0]).toEqual(previous.generation_state.generated_cycles[0]);
  });

  it('restores archived history on restart and keeps the cycle number increasing', () => {
    const previous = { ...fitnessPlan(), status: 'closed' } as FitnessPlanPayload;
    const input = { ...structuredClone(previous), status: 'in_progress' as const };
    expect(() => preparePlanSave(input, previous, '2026-09-20', fitnessTime)).toThrow('新的开始日期');
    const prepared = preparePlanSave(input, previous, '2026-09-20', fitnessTime, '2026-09-20');
    const result = generatePlanCycles(
      randomUUID(),
      prepared.plan,
      '2026-09-20',
      fitnessTime,
      undefined,
      undefined,
      prepared.restart,
    );
    expect(result.plan.generation_state.next_cycle_index).toBe(2);
    expect(result.plan.generation_state.generated_cycles[1]?.start_date).toBe('2026-09-20');
    expect(result.workouts[0]!.payload.occurrence_key).toContain(':1:0:');
    validateFitnessTransition('fitness_plan', previous, result.plan);
  });

  it('rejects past new starts and modification of an active generated start', () => {
    const previous = fitnessPlan() as FitnessPlanPayload;
    const changed = { ...structuredClone(previous), start_date: '2026-09-20' };
    expect(() => preparePlanSave(changed, previous, '2026-09-12', fitnessTime)).toThrow('不可修改');
    expect(() => preparePlanSave(fresh(), null, '2026-09-12', fitnessTime)).toThrow('不能早于今天');
  });

  it('ignores draft attempts to rewind or replace authoritative generation history', () => {
    const previous = fitnessPlan() as FitnessPlanPayload;
    const changed = { ...fresh(), days: previous.days };
    const result = preparePlanSave(changed, previous, '2026-09-12', fitnessTime);
    expect(result.plan.generation_state).toEqual(previous.generation_state);
  });

  it('uses the latest local template and per-exercise rest preferences without changing source snapshots', () => {
    const input = fresh();
    const templateId = randomUUID();
    input.days[0]!.slot!.source_template_id = templateId;
    const template = {
      name: 'updated template',
      exercises: structuredClone(input.days[0]!.slot!.exercises),
      created_at: fitnessTime,
      updated_at: fitnessTime,
    };
    template.exercises[0]!.sets[0]!.reps = 12;
    const result = generatePlanCycles(
      randomUUID(),
      input,
      '2026-09-11',
      fitnessTime,
      new Map([[templateId, template]]),
      { '0025': { rest_seconds: 120, warmup_rest_seconds: 30 } },
    );
    expect(result.workouts[0]!.payload.name).toBe('updated template');
    expect(result.workouts[0]!.payload.exercises[0]).toMatchObject({ rest_seconds: 120, warmup_rest_seconds: 30 });
    expect(result.workouts[0]!.payload.exercises[0]!.sets[0]!.reps).toBe(12);
    expect(input.days[0]!.slot!.exercises[0]!.sets[0]!.reps).toBe(8);
  });

  it('retains snapshots when a source template was deleted and never generates closed plans', () => {
    const input = fresh();
    input.days[0]!.slot!.source_template_id = randomUUID();
    expect(generatePlanCycles(randomUUID(), input, '2026-09-11', fitnessTime).workouts[0]!.payload.name).toBe(
      input.days[0]!.slot!.name,
    );
    input.status = 'closed';
    expect(generatePlanCycles(randomUUID(), input, '2026-09-11', fitnessTime).workouts).toHaveLength(0);
  });

  it('bounds catch-up at complete cycles and continues without duplicating any occurrence', () => {
    const id = randomUUID();
    const input = fresh();
    input.start_date = '2020-01-01';
    const first = generatePlanCycles(id, input, '2021-01-01', fitnessTime);
    expect(first.hasMore).toBe(true);
    expect(first.plan.generation_state.generated_cycles).toHaveLength(100);
    const second = generatePlanCycles(id, first.plan, '2021-01-01', fitnessTime);
    expect(second.hasMore).toBe(false);
    const ids = [...first.workouts, ...second.workouts].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    validateFitnessTransition('fitness_plan', first.plan, second.plan);
  });

  it('handles leap years and DST dates while rejecting invalid or overflowing dates', () => {
    expect(addPlanDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addPlanDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addPlanDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(() => addPlanDays('2025-02-29', 0)).toThrow();
    expect(() => addPlanDays('9999-12-31', 1)).toThrow();
  });
});
