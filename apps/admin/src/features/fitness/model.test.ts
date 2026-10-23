import { describe, expect, it } from 'vitest';
import {
  contentError,
  editableContent,
  exerciseMedia,
  newContent,
  resizePlanDays,
  type ExerciseContent,
  type PlanContent,
  type TemplateContent,
} from './model';

/** 构造填写完整的共同字段，测试关注编排关系而非逐个必填提示。 */
function named<T extends PlanContent | TemplateContent>(value: T): T {
  return {
    ...value,
    name: { zh: '训练', zh_hant: '訓練', en: 'Training' },
    description: { zh: '说明', zh_hant: '說明', en: 'Description' },
    goals: { zh: ['健康'], zh_hant: ['健康'], en: ['Health'] },
  };
}

describe('官方健身内容表单', () => {
  it('保存既有会话中的动作时只提交当前可编辑字段', () => {
    const exercise = {
      ...(newContent('exercise') as ExerciseContent),
      name_zh: '俯卧撑',
      aliases: ['掌上压'],
      media_url: '/api/v1/fitness/media/builtin-0001',
    };
    const body = editableContent(exercise);
    expect(body).not.toHaveProperty('aliases');
    expect(body).not.toHaveProperty('media_url');
    expect(body.name_zh).toBe('俯卧撑');
  });
  it('增加周期保留安排、补齐休息，缩短不保留范围外引用', () => {
    const plan = newContent('plan') as PlanContent;
    plan.days[0]!.template_id = 'first';
    plan.days[6]!.template_id = 'last';
    const extended = resizePlanDays(plan, 9);
    expect(extended.days[0]!.template_id).toBe('first');
    expect(extended.days[8]).toEqual({ day_index: 8, template_id: null });
    expect(resizePlanDays(extended, 3).days).toHaveLength(3);
    expect(plan.days).toHaveLength(7);
  });

  it('长周期按天序恢复乱序安排，缺失日期补休息并保留原计划', () => {
    try {
      const plan = newContent('plan') as PlanContent;
      plan.cycle_days = 36500;
      plan.days = Array.from({ length: 36500 }, (_, index) => ({
        day_index: 36499 - index,
        template_id: index === 0 ? '最后一天训练' : null,
      })).filter((day) => day.day_index !== 10);
      const result = resizePlanDays(plan, 36500);
      expect(result.days).toHaveLength(36500);
      expect(result.days[10]).toEqual({ day_index: 10, template_id: null });
      expect(result.days[36499]).toEqual({ day_index: 36499, template_id: '最后一天训练' });
      expect(plan.days[0]!.day_index).toBe(36499);
      expect(plan.days).toHaveLength(36499);
    } catch (cause) {
      throw new Error('长周期训练安排重建验证失败', { cause });
    }
  });

  it('模板自重不带重量，组数和重量格式在提交前校验', () => {
    const template = named(newContent('template') as TemplateContent);
    template.equipment = ['body weight'];
    template.exercises = [
      { exercise_id: '0025', sets: 3, reps: 12, rest_seconds: 90, weight_mode: 'body_weight', weight_kg: null },
    ];
    expect(contentError('template', template)).toBeNull();
    template.exercises[0]!.weight_mode = 'total';
    expect(contentError('template', template)).toContain('重量');
    template.exercises[0]!.weight_kg = '12.5';
    expect(contentError('template', template)).toBeNull();
    template.exercises[0]!.sets = 0;
    expect(contentError('template', template)).toContain('组数');
  });

  it('全休息计划不能保存，编辑正文不发送内部身份与内容修订', () => {
    const plan = named(newContent('plan') as PlanContent);
    expect(contentError('plan', plan)).toContain('至少');
    plan.days[0]!.template_id = 'template';
    expect(contentError('plan', plan)).toBeNull();
    const body = editableContent({
      ...plan,
      id: 'private-id',
      revision: 99,
      goals: { ...plan.goals, zh: ['健康 ', ''] },
    });
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('revision');
    expect((body.goals as PlanContent['goals']).zh).toEqual(['健康']);
  });

  it('教学步骤保留输入顺序，预览媒体只指向受控来源', () => {
    const exercise = newContent('exercise') as ExerciseContent;
    exercise.instructions_zh = [' 步骤一 ', '', '步骤二'];
    expect(editableContent(exercise).instructions_zh).toEqual(['步骤一', '步骤二']);
    expect(exerciseMedia({ ...exercise, gif_asset: 'https://unknown.test/m.gif' })).toBeUndefined();
    expect(exerciseMedia({ ...exercise, gif_asset: 'assets/fitness/videos/0025-EIeI8Vf.gif' })).toBe(
      '/api/v1/fitness/media/builtin-0025',
    );
    expect(exerciseMedia({ ...exercise, media_id: 'a'.repeat(64) })).toBe(
      `/api/v1/admin/fitness/media/${'a'.repeat(64)}`,
    );
  });
});
