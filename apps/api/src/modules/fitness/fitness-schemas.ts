import { NameSchema, AnyUuidSchema, TimestampSchema, VersionedUuidSchema } from '../../shared/contracts/scalars.js';
import { Type, type Static, type TSchema } from '@sinclair/typebox';

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const enumeration = <T extends string>(values: T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const integer = Type.Integer({ minimum: 0, maximum: 2147483647 });
const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const weight = Type.String({ pattern: '^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,10})?$', maxLength: 29 });
const name = NameSchema;
const times = { created_at: TimestampSchema, updated_at: TimestampSchema };
// 来源仅用于识别官方副本，不建立外键，也不参与读取或覆盖用户内容。
const FitnessCatalogOriginSchema = object({
  source: Type.Literal('official'),
  item_id: VersionedUuidSchema,
  revision: Type.Integer({ minimum: 1, maximum: 2147483647 }),
});
// 重量二选一：weight 记总重，weight_left/weight_right 记左右单侧重量；完成组必须成对。
const setFields = {
  id: AnyUuidSchema,
  kind: enumeration(['warmup', 'working']),
  weight: nullable(weight),
  weight_left: nullable(weight),
  weight_right: nullable(weight),
  reps: nullable(Type.Integer({ minimum: 1, maximum: 2147483647 })),
};
const exerciseFields = {
  id: AnyUuidSchema,
  exercise_id: Type.String({ minLength: 1, maxLength: 128 }),
  rest_seconds: integer,
  warmup_rest_seconds: nullable(integer),
};
const FitnessTemplateExerciseSchema = object({
  ...exerciseFields,
  sets: Type.Array(object(setFields), { maxItems: 1000 }),
});
const FitnessWorkoutExerciseSchema = object({
  ...exerciseFields,
  sets: Type.Array(
    object({
      ...setFields,
      completed: Type.Boolean(),
      rest_durations_seconds: Type.Optional(Type.Array(integer, { maxItems: 1000 })),
    }),
    { maxItems: 1000 },
  ),
});
const FitnessTemplatePayloadSchema = object({
  name,
  exercises: Type.Array(FitnessTemplateExerciseSchema, { minItems: 1, maxItems: 1000 }),
  catalog_origin: Type.Optional(FitnessCatalogOriginSchema),
  ...times,
});
const scheduleFields = {
  cycle_days: Type.Integer({ minimum: 1, maximum: 36500 }),
  days: Type.Array(
    object({
      day_index: integer,
      slot: nullable(
        object({
          id: AnyUuidSchema,
          source_template_id: nullable(AnyUuidSchema),
          name,
          exercises: Type.Array(FitnessTemplateExerciseSchema, { minItems: 1, maxItems: 1000 }),
        }),
      ),
    }),
    { minItems: 1, maxItems: 36500 },
  ),
};
const FitnessPlanPayloadSchema = object({
  name,
  catalog_origin: Type.Optional(FitnessCatalogOriginSchema),
  start_date: nullable(date),
  status: enumeration(['in_progress', 'closed']),
  ...scheduleFields,
  generation_state: object({
    next_cycle_start_date: nullable(date),
    next_cycle_index: integer,
    generated_cycles: Type.Array(
      object({
        cycle_index: integer,
        start_date: date,
        cycle_days: Type.Integer({ minimum: 1, maximum: 36500 }),
        generated_from_date: date,
        rest_dates: Type.Array(date),
      }),
    ),
  }),
  pending_schedule: nullable(object(scheduleFields)),
  ...times,
});
const FitnessWorkoutPayloadSchema = object({
  name,
  scheduled_date: date,
  source_kind: enumeration(['blank', 'template', 'plan']),
  source_plan_id: nullable(AnyUuidSchema),
  source_plan_name: nullable(name),
  source_template_id: nullable(AnyUuidSchema),
  occurrence_key: nullable(Type.String({ minLength: 1, maxLength: 255 })),
  exercises: Type.Array(FitnessWorkoutExerciseSchema, { maxItems: 1000 }),
  status: enumeration(['scheduled', 'in_progress', 'completed']),
  run_segments: Type.Array(object({ started_at: TimestampSchema, ended_at: nullable(TimestampSchema) })),
  rest_timer: nullable(
    object({
      status: enumeration(['running', 'paused']),
      ends_at: nullable(TimestampSchema),
      remaining_seconds: integer,
      duration_seconds: integer,
      elapsed_seconds: Type.Optional(integer),
      exercise_id: Type.Optional(nullable(AnyUuidSchema)),
      set_id: Type.Optional(nullable(AnyUuidSchema)),
    }),
  ),
  ...times,
});
const customExercise = object({
  id: Type.String({ pattern: '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }),
  name,
  // 自定义动作保留稳定分类标识，已删除分类的历史记录仍可跨设备同步。
  body_part: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  equipment: Type.String({ minLength: 1, maxLength: 100, pattern: '\\S' }),
  icon: Type.String({ pattern: '^[a-zA-Z][a-zA-Z0-9]{0,63}$' }),
  image: nullable(
    Type.String({
      minLength: 1,
      maxLength: 65536,
      pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$',
    }),
  ),
  deleted: Type.Boolean(),
});
const FitnessPreferencesPayloadSchema = object({
  custom_exercises: Type.Array(customExercise, { maxItems: 1000 }),
  default_rest_seconds: integer,
  default_warmup_rest_seconds: Type.Optional(integer),
  exercise_rest_settings: Type.Optional(
    Type.Record(
      Type.String({ minLength: 1, maxLength: 128 }),
      object({ rest_seconds: integer, warmup_rest_seconds: integer }),
    ),
  ),
  sound_enabled: Type.Boolean(),
  vibration_enabled: Type.Boolean(),
  pinned_exercise_ids: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { uniqueItems: true }),
  // 动作级重量口径：true 记录左右重量，false 只记录总重量；未列出的动作按器械推导默认值。
  exercise_weight_modes: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Boolean(), {
    maxProperties: 1000,
  }),
  ...times,
});
export const fitnessPayloadSchemas = {
  fitness_template: FitnessTemplatePayloadSchema,
  fitness_plan: FitnessPlanPayloadSchema,
  fitness_workout: FitnessWorkoutPayloadSchema,
  fitness_preferences: FitnessPreferencesPayloadSchema,
};
export type FitnessEntityType = keyof typeof fitnessPayloadSchemas;
export type FitnessPlanPayload = Static<typeof FitnessPlanPayloadSchema>;
export type FitnessWorkoutPayload = Static<typeof FitnessWorkoutPayloadSchema>;
export type FitnessPreferencesPayload = Static<typeof FitnessPreferencesPayloadSchema>;
