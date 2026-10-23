export type FitnessKind = 'exercise' | 'template' | 'plan';
export type Localized = { zh: string; zh_hant: string; en: string };
export type ExerciseContent = {
  id: string;
  name_zh: string;
  name_zh_hant: string;
  name_en: string;
  body_part: string;
  equipment: string;
  target: string;
  secondary_muscles: string[];
  instructions_zh: string[];
  instructions_zh_hant: string[];
  instructions_en: string[];
  attribution: string;
  gif_asset: string;
  media_id?: string | null;
};
export type TemplateExercise = {
  exercise_id: string;
  sets: number;
  reps: number;
  weight_kg: string | null;
  weight_mode: 'total' | 'per_side' | 'body_weight';
  rest_seconds: number;
};
export type CommonContent = {
  id: string;
  revision: number;
  name: Localized;
  description: Localized;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  goals: { zh: string[]; zh_hant: string[]; en: string[] };
};
export type TemplateContent = CommonContent & {
  duration_minutes: number;
  equipment: string[];
  exercises: TemplateExercise[];
};
export type PlanContent = CommonContent & {
  cycle_days: number;
  days: Array<{ day_index: number; template_id: string | null }>;
};
export type FitnessContent = ExerciseContent | TemplateContent | PlanContent;
export type FitnessRow = {
  id: string;
  kind: FitnessKind;
  version: number;
  content: FitnessContent;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};
export type References = {
  exercises: Array<{ id: string; name: string; is_enabled: boolean }>;
  templates: Array<{ id: string; name: string; is_enabled: boolean }>;
};
export const kindLabels = { exercise: '动作', template: '训练模板', plan: '训练计划' };
export const pageLabels = { exercise: '动作库', template: '训练模板', plan: '训练计划' };
export const difficultyLabels = { beginner: '初级', intermediate: '中级', advanced: '高级' };
/** 表单只分配输入默认值，稳定身份和内容修订由服务端生成。 */
export function newContent(kind: FitnessKind): FitnessContent {
  if (kind === 'exercise')
    return {
      id: '',
      name_zh: '',
      name_zh_hant: '',
      name_en: '',
      body_part: '',
      equipment: '',
      target: '',
      secondary_muscles: [],
      instructions_zh: [],
      instructions_zh_hant: [],
      instructions_en: [],
      attribution: '',
      gif_asset: '',
      media_id: null,
    };
  const common: CommonContent = {
    id: '',
    revision: 1,
    name: { zh: '', zh_hant: '', en: '' },
    description: { zh: '', zh_hant: '', en: '' },
    difficulty: 'beginner',
    goals: { zh: [], zh_hant: [], en: [] },
  };
  return kind === 'template'
    ? { ...common, duration_minutes: 30, equipment: [], exercises: [] }
    : {
        ...common,
        cycle_days: 7,
        days: Array.from({ length: 7 }, (_, day_index) => ({ day_index, template_id: null })),
      };
}

/** 名称按业务字段读取，界面不把内部身份作为名称兜底。 */
export function contentName(value: FitnessContent): string {
  return 'name_zh' in value ? value.name_zh : value.name.zh;
}

/** 增减周期保留相同天序的安排，超出周期的安排由确认后的表单变更移除。 */
export function resizePlanDays(plan: PlanContent, count: number): PlanContent {
  // 按天序建立一次索引，完整长周期的重建成本随天数线性增长。
  const templatesByDay = new Map(plan.days.map((day) => [day.day_index, day.template_id]));
  return {
    ...plan,
    cycle_days: count,
    days: Array.from({ length: count }, (_, day_index) => ({
      day_index,
      template_id: templatesByDay.get(day_index) ?? null,
    })),
  };
}

/** 表单校验集中处理跨字段关系，网络失败不会丢弃当前输入。 */
export function contentError(kind: FitnessKind, value: FitnessContent): string | null {
  if (kind === 'exercise') {
    const exercise = value as ExerciseContent;
    if (![exercise.name_zh, exercise.name_zh_hant, exercise.name_en].every((name) => name.trim()))
      return '请填写三种语言的动作标题。';
    if (!exercise.target.trim()) return '请填写主要肌群。';
    if (
      ![exercise.instructions_zh, exercise.instructions_zh_hant, exercise.instructions_en].every((steps) =>
        steps.some((step) => step.trim()),
      )
    )
      return '请填写三种语言的教学步骤。';
    return null;
  }
  const common = value as CommonContent;
  if (!Object.values(common.name).every((name) => name.trim())) return '请填写三种语言的标题。';
  if (!Object.values(common.description).every((text) => text.trim())) return '请填写三种语言的说明。';
  if (!Object.values(common.goals).every((goals) => goals.some((goal) => goal.trim())))
    return '请填写三种语言的训练目标。';
  if (kind === 'template') {
    const template = value as TemplateContent;
    if (!template.equipment.length) return '请至少选择一种器械。';
    if (!template.exercises.length) return '请至少添加一个动作。';
    if (
      template.exercises.some(
        (entry) =>
          !Number.isInteger(entry.sets) ||
          entry.sets < 1 ||
          !Number.isInteger(entry.reps) ||
          entry.reps < 1 ||
          !Number.isInteger(entry.rest_seconds) ||
          entry.rest_seconds < 0 ||
          (entry.weight_mode !== 'body_weight' && !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/.test(entry.weight_kg ?? '')),
      )
    )
      return '请检查动作组数、次数、休息与重量。';
  } else {
    const plan = value as PlanContent;
    if (!Number.isInteger(plan.cycle_days) || plan.cycle_days < 1 || plan.days.length !== plan.cycle_days)
      return '请填写有效的周期天数。';
    if (!plan.days.some((day) => day.template_id)) return '计划至少需要安排一天训练。';
  }
  return null;
}

/** 服务端只接收可编辑字段，清除行末空白后不发送身份及内容修订。 */
export function editableContent(value: FitnessContent) {
  const fields = Object.keys(newContent('name_zh' in value ? 'exercise' : 'exercises' in value ? 'template' : 'plan'));
  // 请求只包含表单定义的可编辑字段，读取响应中的额外资料不随保存重新写入。
  const result = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'id' && key !== 'revision' && fields.includes(key)),
  );
  for (const [key, field] of Object.entries(result)) {
    if (Array.isArray(field) && field.every((entry) => typeof entry === 'string'))
      result[key] = (field as string[]).map((entry) => entry.trim()).filter(Boolean);
  }
  if ('goals' in result)
    result.goals = Object.fromEntries(
      Object.entries(result.goals as CommonContent['goals']).map(([key, goals]) => [
        key,
        goals.map((goal) => goal.trim()).filter(Boolean),
      ]),
    );
  return result;
}

/** 内置媒体与上传素材分别使用审核映射和内容摘要，浏览器不解释任意文件路径。 */
export function exerciseMedia(value: ExerciseContent): string | undefined {
  if (value.media_id) return `/api/v1/admin/fitness/media/${value.media_id}`;
  const match = /^assets\/fitness\/videos\/([\w-]+)\.gif$/.exec(value.gif_asset);
  return match ? `/api/v1/fitness/media/builtin-${match[1]!.split('-')[0]}` : undefined;
}
