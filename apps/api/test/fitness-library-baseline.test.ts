import { describe, expect, it } from 'vitest';

import { fitnessLibrary, validateFitnessLibrary } from '../src/modules/fitness/testing.js';

describe('官方训练内容基线', () => {
  it('拒绝重复模板和重复计划身份', () => {
    const templates = structuredClone(fitnessLibrary);
    templates.templates.push(structuredClone(templates.templates[0]!));
    expect(() => validateFitnessLibrary(templates)).toThrow();
    const plans = structuredClone(fitnessLibrary);
    plans.plans.push(structuredClone(plans.plans[0]!));
    expect(() => validateFitnessLibrary(plans)).toThrow();
  });

  it('拒绝不存在的模板引用和动作引用', () => {
    const invalidPlan = structuredClone(fitnessLibrary);
    invalidPlan.plans[0]!.days[0]!.template_id = '99999999-9999-4999-8999-999999999999';
    expect(() => validateFitnessLibrary(invalidPlan)).toThrow('官方训练内容库校验失败');

    const invalidExercise = structuredClone(fitnessLibrary);
    invalidExercise.templates[0]!.exercises[0]!.exercise_id = 'missing';
    expect(() => validateFitnessLibrary(invalidExercise)).toThrow('官方训练内容库校验失败');
  });
});
