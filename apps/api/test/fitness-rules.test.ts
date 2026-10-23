import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  fitnessPayloadSchemas,
  prepareFitnessImport,
  validateFitnessPayload,
  validateFitnessTransition,
} from '../src/modules/fitness/testing.js';
import {
  fitnessExercise,
  fitnessPlan,
  fitnessPreferences,
  fitnessTemplate,
  fitnessTime,
  fitnessWorkout,
  plannedWorkout,
} from './fitness-fixtures.js';

// 路由校验由 ajv 提供 date-time 格式；这里补齐同一格式表，才能用 Value.Check 校验完整载荷。
FormatRegistry.Set('date-time', (value) => !Number.isNaN(Date.parse(value)));

describe('健身严格 wire 与业务规则', () => {
  it('训练、模板和计划槽拒绝同动作混合口径，空白组与不同动作仍可保存', () => {
    const total = fitnessExercise();
    const side = {
      ...fitnessExercise(),
      sets: fitnessExercise().sets.map((set) => ({ ...set, weight: null, weight_left: '10', weight_right: '10' })),
    };
    const template = { ...fitnessTemplate(), exercises: [total, side] };
    expect(() => validateFitnessPayload('fitness_template', template)).toThrow('同一动作的全部组');
    expect(() =>
      validateFitnessPayload('fitness_template', {
        ...template,
        exercises: [{ ...total, sets: [...total.sets, ...side.sets] }],
      }),
    ).toThrow('同一动作的全部组');
    expect(() =>
      validateFitnessPayload('fitness_workout', {
        ...fitnessWorkout(),
        exercises: [total, side].map((item) => ({
          ...item,
          sets: item.sets.map((set) => ({ ...set, completed: false })),
        })),
      }),
    ).toThrow('同一动作的全部组');
    const plan = fitnessPlan();
    expect(() =>
      validateFitnessPayload('fitness_plan', {
        ...plan,
        days: plan.days.map((day) => (day.slot ? { ...day, slot: { ...day.slot, exercises: [total, side] } } : day)),
      }),
    ).toThrow('同一动作的全部组');
    expect(() =>
      validateFitnessPayload('fitness_template', {
        ...template,
        exercises: [total, { ...side, exercise_id: '0001' }],
      }),
    ).not.toThrow();
    expect(() =>
      validateFitnessPayload('fitness_template', {
        ...template,
        exercises: [{ ...total, sets: total.sets.map((set) => ({ ...set, weight: null })) }, side],
      }),
    ).not.toThrow();
  });
  it('官方来源标识只接受 v4/v5 目录身份，与数据库约束同宽', () => {
    const origin = { source: 'official', item_id: '11111111-1111-4111-8111-000000000001', revision: 1 };
    expect(Value.Check(fitnessPayloadSchemas.fitness_template, { ...fitnessTemplate(), catalog_origin: origin })).toBe(
      true,
    );
    expect(Value.Check(fitnessPayloadSchemas.fitness_plan, { ...fitnessPlan(), catalog_origin: origin })).toBe(true);
    // 形状合法但版本位或变体位非法的身份由数据库拒绝，接口必须提前返回 400。
    for (const itemId of [
      '11111111-1111-1111-1111-111111111111',
      '11111111-1111-4111-1111-111111111111',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      expect(
        Value.Check(fitnessPayloadSchemas.fitness_template, {
          ...fitnessTemplate(),
          catalog_origin: { ...origin, item_id: itemId },
        }),
      ).toBe(false);
    }
  });

  it('动作级重量口径数量上限与数据库不变量一致', () => {
    const modes = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`exercise-${index}`, true]));
    expect(
      Value.Check(fitnessPayloadSchemas.fitness_preferences, { ...fitnessPreferences(), exercise_weight_modes: modes }),
    ).toBe(false);
    expect(
      Value.Check(fitnessPayloadSchemas.fitness_preferences, {
        ...fitnessPreferences(),
        exercise_weight_modes: { '0314': true, '0001': false },
      }),
    ).toBe(true);
  });

  it('默认热身休息兼容旧偏好并校验整数范围', () => {
    expect(() => validateFitnessPayload('fitness_preferences', fitnessPreferences())).not.toThrow();
    for (const seconds of [0, 30, 2147483647]) {
      expect(() =>
        validateFitnessPayload('fitness_preferences', {
          ...fitnessPreferences(),
          default_warmup_rest_seconds: seconds,
        }),
      ).not.toThrow();
    }
    for (const seconds of [-1, 0.5, 2147483648, '30', null]) {
      expect(() =>
        validateFitnessPayload('fitness_preferences', {
          ...fitnessPreferences(),
          default_warmup_rest_seconds: seconds,
        }),
      ).toThrow();
    }
  });

  it('自定义动作首版字段、引用、图片与重复标识校验', () => {
    const custom = {
      id: 'custom:11111111-1111-4111-8111-111111111111',
      name: '自定义深蹲',
      body_part: 'upper legs',
      equipment: 'body weight',
      icon: 'dumbbell',
      image: null,
      deleted: false,
    };
    const payload = {
      ...fitnessPreferences(),
      custom_exercises: [custom],
      pinned_exercise_ids: [custom.id],
      exercise_rest_settings: { [custom.id]: { rest_seconds: 90, warmup_rest_seconds: 30 } },
    };
    expect(() => validateFitnessPayload('fitness_preferences', payload)).not.toThrow();
    const template = fitnessTemplate();
    template.exercises[0]!.exercise_id = custom.id;
    expect(() => validateFitnessPayload('fitness_template', template)).not.toThrow();
    for (const invalid of [
      { ...custom, id: 'custom:invalid' },
      { ...custom, name: ' ' },
      { ...custom, body_part: '' },
      { ...custom, body_part: '\t\n' },
      { ...custom, body_part: 'x'.repeat(101) },
      { ...custom, equipment: '' },
      { ...custom, equipment: '   ' },
      { ...custom, equipment: '\u0000' },
      { ...custom, equipment: '\uD800' },
      { ...custom, image: '!!!!' },
      { ...custom, image: 'A'.repeat(65540) },
      { ...custom, icon: '' },
      { ...custom, extra: true },
    ])
      expect(() =>
        validateFitnessPayload('fitness_preferences', { ...payload, custom_exercises: [invalid] }),
      ).toThrow();
    expect(() =>
      validateFitnessPayload('fitness_preferences', { ...payload, custom_exercises: [custom, custom] }),
    ).toThrow();
    const { custom_exercises: _custom, ...missing } = payload;
    expect(() => validateFitnessPayload('fitness_preferences', missing)).toThrow();
  });

  it('自定义动作同步与导入保留未知或已删除分类的稳定身份', () => {
    const historical = {
      id: 'custom:11111111-1111-4111-8111-111111111111',
      name: '历史动作',
      body_part: '22222222-2222-4222-8222-222222222222',
      equipment: 'unknown',
      icon: 'dumbbell',
      image: null,
      deleted: false,
    };
    const payload = { ...fitnessPreferences(), custom_exercises: [historical] };
    expect(() => validateFitnessPayload('fitness_preferences', payload)).not.toThrow();
    const imported = prepareFitnessImport(
      [{ id: '33333333-3333-4333-8333-333333333333', entity_type: 'fitness_preferences', payload }],
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      null,
    );
    expect(imported.records[0]!.payload.custom_exercises).toEqual([
      {
        ...historical,
        id: expect.stringMatching(/^custom:/),
      },
    ]);
  });

  it('计划每天只接受一个安排或休息，当前和待生效周期均拒绝旧列表', () => {
    const plan = fitnessPlan();
    expect(() => validateFitnessPayload('fitness_plan', plan)).not.toThrow();
    const slot = plan.days[0]!.slot!;
    for (const day of [
      { day_index: 0, slots: [slot, { ...slot, id: plan.days[0]!.slot!.id }] },
      { day_index: 0, slot: [slot] },
      { day_index: 0 },
    ]) {
      const schedule = { cycle_days: 2, days: [day, plan.days[1]!] };
      expect(() => validateFitnessPayload('fitness_plan', { ...plan, ...schedule })).toThrow();
      expect(() => validateFitnessPayload('fitness_plan', { ...plan, pending_schedule: schedule })).toThrow();
    }
  });

  it('模板和偏好拒绝已删除的排序与精选计划收藏字段', () => {
    expect(() => validateFitnessPayload('fitness_template', fitnessTemplate())).not.toThrow();
    expect(() => validateFitnessPayload('fitness_preferences', fitnessPreferences())).not.toThrow();
    expect(() => validateFitnessPayload('fitness_template', { ...fitnessTemplate(), sort_order: 0 })).toThrow();
    expect(() =>
      validateFitnessPayload('fitness_preferences', { ...fitnessPreferences(), favorite_plan_ids: [] }),
    ).toThrow();
  });

  it('训练安排日期创建后不可修改，普通内容仍可编辑', () => {
    const before = fitnessWorkout();
    expect(() => validateFitnessTransition('fitness_workout', before, { ...before, name: '新名称' })).not.toThrow();
    expect(() =>
      validateFitnessTransition('fitness_workout', before, { ...before, scheduled_date: '2026-09-12' }),
    ).toThrow();
  });
  it('计划只使用进行中和已关闭状态，拒绝旧开关及缺失状态', () => {
    const plan = fitnessPlan();
    for (const status of ['in_progress', 'closed']) {
      expect(() => validateFitnessPayload('fitness_plan', { ...plan, status })).not.toThrow();
    }
    for (const status of ['paused', 'enabled', 'completed', '', null, true]) {
      expect(() => validateFitnessPayload('fitness_plan', { ...plan, status })).toThrow();
    }
    const { status: _status, ...withoutStatus } = plan;
    expect(() => validateFitnessPayload('fitness_plan', { ...withoutStatus, enabled: true })).toThrow();
  });
  it('暂停保留进行中状态，关闭的历史时段恢复时只能追加', () => {
    const paused = {
      ...fitnessWorkout(),
      status: 'in_progress',
      run_segments: [{ started_at: fitnessTime, ended_at: fitnessTime }],
    };
    expect(() => validateFitnessPayload('fitness_workout', paused)).not.toThrow();
    const resumed = { ...paused, run_segments: [...paused.run_segments, { started_at: fitnessTime, ended_at: null }] };
    expect(() => validateFitnessPayload('fitness_workout', resumed)).not.toThrow();
    expect(() => validateFitnessTransition('fitness_workout', paused, resumed)).not.toThrow();
    expect(() =>
      validateFitnessTransition('fitness_workout', paused, {
        ...paused,
        run_segments: [{ started_at: fitnessTime, ended_at: null }],
      }),
    ).toThrow();
    expect(() => validateFitnessPayload('fitness_workout', { ...resumed, status: 'completed' })).toThrow();
  });
  it('统一动作休息配置校验目录、热身和正式组整数边界，仍接受旧偏好', () => {
    expect(() => validateFitnessPayload('fitness_preferences', fitnessPreferences())).not.toThrow();
    const payload = {
      ...fitnessPreferences(),
      exercise_rest_settings: { '0025': { rest_seconds: 90, warmup_rest_seconds: 0 } },
    };
    expect(() => validateFitnessPayload('fitness_preferences', payload)).not.toThrow();
    for (const settings of [
      { bad: { rest_seconds: 90, warmup_rest_seconds: 0 } },
      { '0025': { rest_seconds: -1, warmup_rest_seconds: 0 } },
      { '0025': { rest_seconds: 1, warmup_rest_seconds: 1.5 } },
      { '0025': { rest_seconds: 1 } },
    ]) {
      expect(() =>
        validateFitnessPayload('fitness_preferences', { ...payload, exercise_rest_settings: settings }),
      ).toThrow();
    }
  });
  it.each([
    '\uD800',
    '\uDFFF',
    '\u0000',
    '\u200B\u2060',
    '\u0085\u00AD',
    '\u0001\u001F',
    '\u2800\u3164',
    '\uFE00\uFE0F',
  ])('名称拒绝孤立代理项和纯不可见字符：%j', (name) => {
    expect(() => validateFitnessPayload('fitness_template', { ...fitnessTemplate(), name })).toThrow();
    expect(() => validateFitnessPayload('fitness_workout', { ...fitnessWorkout(), name })).toThrow();
  });
  it('服务端内置动作与主仓冻结契约完全一致，全部动作均可记录', () => {
    const artifact = JSON.parse(
      readFileSync(new URL('../../../packages/api-contract/fitness-catalog.json', import.meta.url), 'utf8'),
    ) as {
      source_commit: string;
      exercises: Array<{ id: string; body_part: string }>;
    };
    const runtime = JSON.parse(
      readFileSync(new URL('../src/modules/fitness/fitness-catalog.json', import.meta.url), 'utf8'),
    );
    expect(runtime).toEqual(artifact);
    expect(artifact.source_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(artifact.exercises.length).toBe(1324);
    expect(new Set(artifact.exercises.map((exercise) => exercise.body_part))).toEqual(
      new Set([
        'chest',
        'back',
        'shoulders',
        'upper arms',
        'lower arms',
        'upper legs',
        'lower legs',
        'waist',
        'neck',
        'cardio',
      ]),
    );
    expect(new Set(artifact.exercises.map((exercise) => exercise.id)).size).toBe(artifact.exercises.length);
    for (const exercise of artifact.exercises) {
      expect(() =>
        validateFitnessPayload('fitness_template', {
          ...fitnessTemplate(),
          exercises: [
            {
              ...fitnessExercise(),
              exercise_id: exercise.id,
              sets: [],
            },
          ],
        }),
      ).not.toThrow();
    }
  });

  it.each([null, '0', '10.125'])('所有动作完成组统一 kg 与次数，允许重量 %s', (weight) => {
    for (const id of ['2135', '0274', '0662', '0289']) {
      const exercise = fitnessExercise(true);
      const payload = {
        ...fitnessWorkout(),
        status: 'completed',
        run_segments: [{ started_at: fitnessTime, ended_at: fitnessTime }],
        exercises: [{ ...exercise, exercise_id: id, sets: [{ ...exercise.sets[0], weight, reps: 8 }] }],
      };
      expect(() => validateFitnessPayload('fitness_workout', payload)).not.toThrow();
      for (const field of ['record_type', 'weight_mode']) {
        expect(() =>
          validateFitnessPayload('fitness_workout', {
            ...payload,
            exercises: [{ ...payload.exercises[0], [field]: 'old' }],
          }),
        ).toThrow();
      }
      for (const field of ['weight_unit', 'reps_min', 'reps_max', 'duration_seconds']) {
        expect(() =>
          validateFitnessPayload('fitness_workout', {
            ...payload,
            exercises: [{ ...payload.exercises[0], sets: [{ ...payload.exercises[0]!.sets[0], [field]: null }] }],
          }),
        ).toThrow();
      }
      expect(() => validateFitnessPayload('fitness_workout', { ...payload, archive_date: '2026-09-11' })).toThrow();
    }
  });
  it('空组模板、空训练、精确重量与偏好有效', () => {
    const template = fitnessTemplate();
    template.exercises[0]!.sets = [];
    expect(() => validateFitnessPayload('fitness_template', template)).not.toThrow();
    expect(() => validateFitnessPayload('fitness_workout', fitnessWorkout())).not.toThrow();
    expect(() => validateFitnessPayload('fitness_plan', fitnessPlan())).not.toThrow();
    expect(() => validateFitnessPayload('fitness_preferences', fitnessPreferences())).not.toThrow();
  });

  it('已完成组必须填写次数，未完成允许留空，模板不能带完成状态', () => {
    const exercise = fitnessExercise(true);
    const workout = {
      ...fitnessWorkout(),
      status: 'completed',
      exercises: [exercise],
      run_segments: [{ started_at: fitnessTime, ended_at: fitnessTime }],
    };
    expect(() => validateFitnessPayload('fitness_workout', workout)).not.toThrow();
    expect(() => validateFitnessPayload('fitness_template', { ...fitnessTemplate(), exercises: [exercise] })).toThrow();
    expect(() =>
      validateFitnessPayload('fitness_workout', {
        ...workout,
        exercises: [{ ...exercise, sets: [{ ...exercise.sets[0], reps: null }] }],
      }),
    ).toThrow();
    expect(() =>
      validateFitnessPayload('fitness_workout', {
        ...workout,
        exercises: [{ ...exercise, sets: [{ ...exercise.sets[0], weight: null, reps: null, completed: false }] }],
      }),
    ).not.toThrow();
    expect(() =>
      validateFitnessPayload('fitness_workout', { ...workout, exercises: [{ ...exercise, record_type: 'reps' }] }),
    ).toThrow();
  });

  it('一组只使用一种重量口径：总重或左右成对的单侧重量', () => {
    const set = fitnessExercise(true).sets[0]!;
    const workout = (payload: Record<string, unknown>) => ({
      ...fitnessWorkout(),
      status: 'completed',
      run_segments: [{ started_at: fitnessTime, ended_at: fitnessTime }],
      exercises: [{ ...fitnessExercise(true), sets: [payload] }],
    });
    // 左右成对填写是完整口径，两侧数值允许不同
    for (const [left, right] of [
      ['5', '5'],
      ['0', '12.5'],
      ['10.0000000001', '9'],
    ]) {
      expect(() =>
        validateFitnessPayload(
          'fitness_workout',
          workout({ ...set, weight: null, weight_left: left, weight_right: right }),
        ),
      ).not.toThrow();
    }
    // 三种重量都留空表示自重
    expect(() =>
      validateFitnessPayload(
        'fitness_workout',
        workout({ ...set, weight: null, weight_left: null, weight_right: null }),
      ),
    ).not.toThrow();
    // 编辑中的草稿允许只填单边
    const draft = (payload: Record<string, unknown>) => ({
      ...fitnessWorkout(),
      status: 'in_progress',
      run_segments: [{ started_at: fitnessTime, ended_at: null }],
      exercises: [{ ...fitnessExercise(false), sets: [payload] }],
    });
    for (const left of ['5', null]) {
      expect(() =>
        validateFitnessPayload(
          'fitness_workout',
          draft({ ...set, completed: false, weight: null, weight_left: left, weight_right: null }),
        ),
      ).not.toThrow();
    }
    for (const invalid of [
      // 两种口径同时存在
      { ...set, weight: '10', weight_left: '5', weight_right: '5' },
      // 完成组必须成对
      { ...set, weight: null, weight_left: '5', weight_right: null },
      { ...set, weight: null, weight_left: null, weight_right: '5' },
      // 重量必须满足 decimal 契约
      { ...set, weight: null, weight_left: '5.', weight_right: '5' },
      { ...set, weight: null, weight_left: '05', weight_right: '5' },
      { ...set, weight: null, weight_left: 5, weight_right: 5 },
    ]) {
      expect(() => validateFitnessPayload('fitness_workout', workout(invalid))).toThrow();
    }
    // 契约字段必须存在：左右重量缺失同样非法
    const { weight_left, weight_right, ...withoutSides } = set;
    expect(weight_left).toBeNull();
    expect(weight_right).toBeNull();
    expect(() => validateFitnessPayload('fitness_workout', workout(withoutSides))).toThrow();
  });

  it('动作级重量口径是布尔映射，键必须是目录动作或自定义动作', () => {
    const custom = 'custom:11111111-1111-4111-8111-111111111111';
    for (const modes of [{}, { '0025': true }, { [custom]: false }, { '0025': true, [custom]: false }]) {
      expect(() =>
        validateFitnessPayload('fitness_preferences', { ...fitnessPreferences(), exercise_weight_modes: modes }),
      ).not.toThrow();
    }
    for (const invalid of [{ unknown: true }, { '0025': 'true' }, { '0025': 1 }, { '': true }, { '0025': null }]) {
      expect(() =>
        validateFitnessPayload('fitness_preferences', { ...fitnessPreferences(), exercise_weight_modes: invalid }),
      ).toThrow();
    }
    // 条目数受偏好容量上限约束
    const tooMany = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [
        `custom:11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        true,
      ]),
    );
    expect(() =>
      validateFitnessPayload('fitness_preferences', { ...fitnessPreferences(), exercise_weight_modes: tooMany }),
    ).toThrow();
    const { exercise_weight_modes, ...withoutField } = fitnessPreferences();
    expect(exercise_weight_modes).toEqual({});
    expect(() => validateFitnessPayload('fitness_preferences', withoutField)).toThrow();
  });

  it('零完成也能结束和重新开始，不能重写历史运行区间', () => {
    const completed = {
      ...fitnessWorkout(),
      status: 'completed',
      run_segments: [{ started_at: fitnessTime, ended_at: '2026-09-11T01:12:03.789Z' }],
    };
    const restarted = {
      ...completed,
      status: 'in_progress',
      run_segments: [...completed.run_segments, { started_at: '2026-09-11T02:00:00.000Z', ended_at: null }],
    };
    expect(() => validateFitnessPayload('fitness_workout', completed)).not.toThrow();
    expect(() => validateFitnessPayload('fitness_workout', restarted)).not.toThrow();
    expect(() => validateFitnessTransition('fitness_workout', completed, restarted)).not.toThrow();
    expect(() => validateFitnessTransition('fitness_workout', completed, { ...completed, run_segments: [] })).toThrow();
    expect(() =>
      validateFitnessTransition('fitness_workout', completed, {
        ...completed,
        run_segments: [{ started_at: fitnessTime, ended_at: fitnessTime }],
      }),
    ).toThrow();
    expect(() =>
      validateFitnessPayload('fitness_workout', {
        ...completed,
        rest_timer: { status: 'paused', ends_at: null, remaining_seconds: 10, duration_seconds: 90 },
      }),
    ).toThrow();
  });

  it('计划覆盖所有日、至少一天训练，已生成周期不重排', () => {
    // 独立 Python uuid.uuid5 黄金向量，与移动端共用发生身份。
    expect(plannedWorkout('22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666').id).toBe(
      '842be7db-6cec-593a-97b0-3ae8fb35e0ee',
    );
    const plan = fitnessPlan();
    expect(() =>
      validateFitnessPayload('fitness_plan', {
        ...plan,
        days: [
          { day_index: 0, slot: null },
          { day_index: 1, slot: null },
        ],
      }),
    ).toThrow();
    expect(() => validateFitnessPayload('fitness_plan', { ...plan, start_date: '2026-02-30' })).toThrow();
    expect(() => validateFitnessPayload('fitness_plan', { ...plan, days: [plan.days[0], plan.days[0]] })).toThrow();
    expect(() => validateFitnessTransition('fitness_plan', plan, { ...plan, start_date: '2026-09-12' })).toThrow();
    expect(() =>
      validateFitnessTransition('fitness_plan', plan, { ...plan, status: 'closed', start_date: '2026-09-12' }),
    ).not.toThrow();
    expect(() => validateFitnessPayload('fitness_plan', { ...plan, start_date: null })).toThrow();
    expect(() => validateFitnessPayload('fitness_plan', { ...plan, start_date: null, status: 'closed' })).not.toThrow();
    expect(() => validateFitnessPayload('fitness_plan', { ...plan, status: 'closed' })).not.toThrow();
    expect(() =>
      validateFitnessTransition('fitness_plan', plan, {
        ...plan,
        generation_state: { ...plan.generation_state, generated_cycles: [] },
      }),
    ).toThrow();
    expect(() => validateFitnessTransition('fitness_plan', plan, { ...plan, status: 'closed' })).not.toThrow();
  });
});
