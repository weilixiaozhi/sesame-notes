import { describe, expect, it } from 'vitest';
import { assignPlanDay, newPlanDraft, resizePlan, submissionPayload } from './plan-model';
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
});
