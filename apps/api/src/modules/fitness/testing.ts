import { Value } from '@sinclair/typebox/value';
import exerciseCatalog from './fitness-catalog.json' with { type: 'json' };
import librarySource from './fitness-library.json' with { type: 'json' };
import { FitnessLibrarySchema, type FitnessLibrary } from './fitness-library-schemas.js';

/** 校验官方内容基线的封闭结构、稳定身份、计划引用和动作目录引用。 */
export function validateFitnessLibrary(value: unknown): asserts value is FitnessLibrary {
  try {
    if (!Value.Check(FitnessLibrarySchema, value)) throw new Error('官方训练内容结构无效');
    const templateIds = new Set<string>();
    // 模板身份与动作引用共同约束基线，重量空值只允许自重口径。
    for (const template of value.templates) {
      if (templateIds.has(template.id)) throw new Error(`官方训练模板标识重复：${template.id}`);
      templateIds.add(template.id);
      for (const exercise of template.exercises) {
        if (!exerciseCatalog.exercises.some((entry) => entry.id === exercise.exercise_id))
          throw new Error(`官方训练模板 ${template.id} 引用了未知动作：${exercise.exercise_id}`);
        if ((exercise.weight_mode === 'body_weight') !== (exercise.weight_kg === null))
          throw new Error(`官方训练模板 ${template.id} 的重量口径无效`);
      }
    }
    const planIds = new Set<string>();
    for (const plan of value.plans) {
      if (planIds.has(plan.id)) throw new Error(`官方训练计划标识重复：${plan.id}`);
      planIds.add(plan.id);
      // 每个周期日只出现一次，周期内至少有训练日，模板引用必须来自同一份基线。
      if (
        plan.days.length !== plan.cycle_days ||
        new Set(plan.days.map((day) => day.day_index)).size !== plan.cycle_days ||
        plan.days.some((day) => day.day_index >= plan.cycle_days) ||
        !plan.days.some((day) => day.template_id !== null)
      )
        throw new Error(`官方训练计划 ${plan.id} 的周期安排无效`);
      for (const day of plan.days) {
        if (day.template_id !== null && !templateIds.has(day.template_id))
          throw new Error(`官方训练计划 ${plan.id} 引用了未知模板：${day.template_id}`);
      }
    }
  } catch (error) {
    throw new Error('官方训练内容库校验失败', { cause: error });
  }
}

// 测试与显式基线检查使用同一份冻结内容；线上目录路由读取数据库权威快照。
validateFitnessLibrary(librarySource);
export const fitnessLibrary: FitnessLibrary = librarySource;

export { addPlanDays, generatePlanCycles, preparePlanSave } from './fitness-plan-generation.js';
export { validateFitnessPayload, validateFitnessTransition } from './fitness-rules.js';
export { fitnessPayloadSchemas } from './fitness-schemas.js';
export type { FitnessPlanPayload } from './fitness-schemas.js';
export { fitnessDateContext, summarizeFitness, fitnessCalendar } from './fitness-statistics.js';
export type { StatisticsWorkout, CalendarPlan } from './fitness-statistics.js';
export { prepareFitnessImport } from './fitness-transfer-rules.js';
