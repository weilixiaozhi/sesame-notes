import { describe, expect, it, vi } from 'vitest';
import { buildOfficialPlanImport } from './official-plan-import';
import type { FitnessSpace, FitnessTemplate, Library } from '../fitness-model';

vi.mock('../../../lib/session', () => ({ api: {}, queryClient: {}, useSession: vi.fn() }));
const now = '2026-09-30T10:00:00.000Z';
const sourceId = 'b97d2f7c-f2a4-41ca-9759-7aab88f35d91';
const space: FitnessSpace = {
  id: 'space',
  name: 'home',
  sync_id: 'sync',
  revision: 1,
  entity_count: 0,
  created_at: now,
  updated_at: now,
  deleted_at: null,
};
const library: Library = {
  schema_version: 1,
  content_version: 1,
  templates: [
    {
      id: sourceId,
      revision: 2,
      name: { zh: '官方力量', zh_hant: '官方力量', en: 'Strength' },
      description: { zh: '', zh_hant: '', en: '' },
      difficulty: 'beginner',
      goals: { zh: [], zh_hant: [], en: [] },
      duration_minutes: 30,
      equipment: ['dumbbell'],
      exercises: [
        {
          exercise_id: '0025',
          sets: 3,
          reps: 8,
          weight_mode: 'per_side',
          weight_kg: '12.1234567891',
          rest_seconds: 120,
        },
      ],
    },
  ],
  plans: [
    {
      id: '54d91376-8d07-44e8-a0e2-5c6d78925c07',
      revision: 3,
      name: { zh: '官方计划', zh_hant: '官方計劃', en: 'Official plan' },
      description: { zh: '', zh_hant: '', en: '' },
      difficulty: 'beginner',
      goals: { zh: [], zh_hant: [], en: [] },
      cycle_days: 3,
      days: [
        { day_index: 0, template_id: sourceId },
        { day_index: 1, template_id: null },
        { day_index: 2, template_id: sourceId },
      ],
    },
  ],
};

describe('official plan copying', () => {
  it('creates one independent template per referenced source and a closed editable plan', () => {
    const body = buildOfficialPlanImport(library.plans[0]!, library, space, new Map(), now, '2026-09-30');
    expect(body.template_copies).toHaveLength(1);
    expect(body.plan?.status).toBe('closed');
    expect(body.plan?.catalog_origin).toEqual({ source: 'official', item_id: library.plans[0]!.id, revision: 3 });
    const first = body.plan!.days[0]!.slot!;
    const second = body.plan!.days[2]!.slot!;
    expect(first.source_template_id).toBe(body.template_copies![0]!.id);
    expect(first.source_template_id).not.toBe(sourceId);
    expect(first.id).not.toBe(second.id);
    expect(first.exercises[0]!.id).not.toBe(second.exercises[0]!.id);
    expect(first.exercises[0]!.sets[0]).toMatchObject({
      weight: null,
      weight_left: '12.1234567891',
      weight_right: '12.1234567891',
      reps: 8,
    });
    expect(body.plan!.days[1]!.slot).toBeNull();
    expect(body.plan?.generation_state.generated_cycles).toHaveLength(0);
  });
  it('reuses a user-modified same-origin copy without adding or overwriting it', () => {
    const newCopy = buildOfficialPlanImport(library.plans[0]!, library, space, new Map(), now, '2026-09-30')
      .template_copies![0]!;
    const existing: FitnessTemplate = {
      ...newCopy.payload,
      id: 'user-copy',
      fitness_space_id: space.id,
      sync_id: 'sync',
      revision: 9,
      deleted_at: null,
    };
    existing.name = '我的定制力量';
    existing.exercises[0]!.sets[0]!.reps = 15;
    const body = buildOfficialPlanImport(
      library.plans[0]!,
      library,
      space,
      new Map([[sourceId, existing]]),
      now,
      '2026-09-30',
    );
    expect(body.template_copies).toHaveLength(0);
    expect(body.plan!.days[0]!.slot).toMatchObject({ name: '我的定制力量', source_template_id: 'user-copy' });
    expect(body.plan!.days[0]!.slot!.exercises[0]!.sets[0]!.reps).toBe(15);
    expect(existing.revision).toBe(9);
  });
  it('rejects a missing official source and prevents cross-space copy reuse', () => {
    expect(() =>
      buildOfficialPlanImport(library.plans[0]!, { ...library, templates: [] }, space, new Map(), now, '2026-09-30'),
    ).toThrow('暂不可用');
    const copy = buildOfficialPlanImport(library.plans[0]!, library, space, new Map(), now, '2026-09-30')
      .template_copies![0]!;
    const wrong: FitnessTemplate = {
      ...copy.payload,
      id: 'copy',
      fitness_space_id: 'other-space',
      sync_id: 'other',
      revision: 1,
      deleted_at: null,
    };
    expect(() =>
      buildOfficialPlanImport(library.plans[0]!, library, space, new Map([[sourceId, wrong]]), now, '2026-09-30'),
    ).toThrow('不属于');
  });
});
