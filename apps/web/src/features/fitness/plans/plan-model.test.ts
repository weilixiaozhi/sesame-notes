import { describe, expect, it } from 'vitest';
import {
  assignPlanDay,
  movePlanDay,
  newPlanDraft,
  planDateOffset,
  resizePlan,
  submissionPayload,
  validatePlanDraft,
} from './plan-model';
import type { FitnessPlan, FitnessTemplate } from '../fitness-model';
const now = '2026-09-30T10:00:00.000Z';
const template: FitnessTemplate = {
  id: 'd0e7a5cf-b4ae-4302-9771-ad953f28f7ed',
  fitness_space_id: 'space',
  sync_id: 'sync',
  revision: 1,
  deleted_at: null,
  name: '自定义力量',
  created_at: now,
  updated_at: now,
  exercises: [
    {
      id: 'exercise',
      exercise_id: 'custom:bdc36c25-6b7d-493b-9262-c447c869b1e3',
      rest_seconds: 120,
      warmup_rest_seconds: 30,
      sets: [
        {
          id: 'set',
          kind: 'warmup',
          reps: 8,
          weight: null,
          weight_left: '12.1234567891',
          weight_right: '13.1234567891',
        },
      ],
    },
  ],
};

/** 创建已经明确训练与休息的两天排班。 */
function filled() {
  let draft = resizePlan(newPlanDraft(undefined, '2026-09-30', now), 2);
  draft.payload.name = '周期计划';
  draft = assignPlanDay(draft, 0, template);
  return assignPlanDay(draft, 1, null);
}

/** 给领域草稿补上生成契约的快照元数据。 */
function saved(): FitnessPlan {
  return { ...filled().payload, id: 'plan', fitness_space_id: 'space', sync_id: 'sync', revision: 2, deleted_at: null };
}

describe('plan editor domain boundaries', () => {
  it('requires explicit rest days and never silently saves blank schedule positions', () => {
    const draft = newPlanDraft(undefined, '2026-09-30', now);
    draft.payload.name = '计划';
    expect(validatePlanDraft(draft, undefined, '2026-09-30')).toContain('第 1 天');
    const resting = { ...draft, filled: new Set(draft.payload.days.map((day) => day.day_index)) };
    expect(validatePlanDraft(resting, undefined, '2026-09-30')).toContain('至少');
  });
  it('copies template snapshots without changing asymmetric weights, warmup type or custom exercise IDs', () => {
    const draft = filled();
    expect(draft.payload.days[0]!.slot!.exercises).toEqual(template.exercises);
    draft.payload.days[0]!.slot!.exercises[0]!.sets[0]!.weight_left = '1';
    expect(template.exercises[0]!.sets[0]!.weight_left).toBe('12.1234567891');
    expect(draft.payload.days[0]!.slot!.source_template_id).toBe(template.id);
  });
  it('resizes without changing identities and marks added days unfilled', () => {
    const original = filled();
    const expanded = resizePlan(original, 4);
    expect(expanded.payload.days[0]!.slot!.id).toBe(original.payload.days[0]!.slot!.id);
    expect(expanded.filled.size).toBe(2);
    expect(validatePlanDraft(expanded, undefined, '2026-09-30')).toContain('第 3 天');
    expect(resizePlan(expanded, 1).filled.size).toBe(1);
  });
  it.each([0, -1, 1.5, 36501, Number.NaN])('rejects invalid cycle size %s', (value) => {
    expect(() => resizePlan(filled(), value)).toThrow();
  });
  it('moves both slot identity and explicit-fill marker, keeping contiguous day indices', () => {
    const draft = resizePlan(filled(), 3);
    const moved = movePlanDay(draft, 0, 2);
    expect(moved.payload.days.map((day) => day.day_index)).toEqual([0, 1, 2]);
    expect(moved.filled.has(0)).toBe(true);
    expect(moved.filled.has(1)).toBe(false);
    expect(moved.filled.has(2)).toBe(true);
    expect(moved.payload.days[2]!.slot!.id).toBe(draft.payload.days[0]!.slot!.id);
  });
  it('loads pending schedule for editing while preserving generated history and official source', () => {
    const plan = saved();
    plan.catalog_origin = { source: 'official', item_id: crypto.randomUUID(), revision: 4 };
    plan.pending_schedule = { cycle_days: 3, days: [...plan.days, { day_index: 2, slot: null }] };
    plan.generation_state = {
      next_cycle_index: 1,
      next_cycle_start_date: '2026-10-02',
      generated_cycles: [
        {
          cycle_index: 0,
          cycle_days: 2,
          start_date: '2026-09-30',
          generated_from_date: '2026-09-30',
          rest_dates: ['2026-10-01'],
        },
      ],
    };
    const draft = newPlanDraft(plan);
    expect(draft.payload.cycle_days).toBe(3);
    const payload = submissionPayload(draft, plan, '2026-10-01', now);
    expect(payload.catalog_origin).toEqual(plan.catalog_origin);
    expect(payload.generation_state).toEqual(plan.generation_state);
    expect(payload.pending_schedule).toEqual(plan.pending_schedule);
  });
  it('rejects past restart dates and active generated start changes', () => {
    const plan = saved();
    plan.generation_state.next_cycle_start_date = '2026-10-02';
    const draft = newPlanDraft(plan);
    draft.payload.start_date = '2026-10-05';
    expect(validatePlanDraft(draft, plan, '2026-10-01')).toContain('不能修改');
    plan.status = 'closed';
    draft.payload.start_date = '2026-09-30';
    expect(validatePlanDraft(draft, plan, '2026-10-01')).toContain('不能早于今天');
  });
  it('maintains local calendar days through leap years and rejects overflow', () => {
    expect(planDateOffset('2024-02-28', 2)).toBe('2024-03-01');
    expect(planDateOffset('2026-03-08', 1)).toBe('2026-03-09');
    expect(() => planDateOffset('2025-02-29', 1)).toThrow();
    expect(() => planDateOffset('9999-12-31', 1)).toThrow();
  });
});
