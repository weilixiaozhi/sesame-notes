import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { OfficialFitnessPlanSchema, OfficialFitnessTemplateSchema } from './fitness-library-schemas.js';
import { FitnessTaxonomiesSchema } from './official-fitness-taxonomy-schemas.js';

/** 官方动作资料使用跨端一致的字段，媒体仅引用受控文件标识。 */
const OfficialExerciseSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    name_zh: Type.String({ minLength: 1, maxLength: 200 }),
    name_zh_hant: Type.String({ minLength: 1, maxLength: 200 }),
    name_en: Type.String({ minLength: 1, maxLength: 300 }),
    body_part: Type.String({ minLength: 1, maxLength: 100 }),
    equipment: Type.String({ minLength: 1, maxLength: 100 }),
    target: Type.String({ minLength: 1, maxLength: 100 }),
    secondary_muscles: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 100 }),
    instructions_zh: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 100 }),
    instructions_zh_hant: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 100 }),
    instructions_en: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 100 }),
    attribution: Type.String({ maxLength: 2000 }),
    gif_asset: Type.String({ maxLength: 300 }),
    media_id: Type.Optional(Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()])),
  },
  { additionalProperties: false },
);

/** 公开动作资料附带受控媒体地址和当前启用状态。 */
const PublicOfficialExerciseSchema = Type.Composite([
  OfficialExerciseSchema,
  Type.Object({
    media_url: Type.String(),
    is_enabled: Type.Boolean(),
  }),
]);

export const FitnessCatalogSchema = Type.Object({
  schema_version: Type.Literal(1),
  content_version: Type.Integer({ minimum: 1 }),
  exercises: Type.Array(PublicOfficialExerciseSchema),
  taxonomies: Type.Optional(FitnessTaxonomiesSchema),
});

export const officialSchemas = {
  exercise: OfficialExerciseSchema,
  template: OfficialFitnessTemplateSchema,
  plan: OfficialFitnessPlanSchema,
} as const;
export type OfficialKind = keyof typeof officialSchemas;
export type OfficialExercise = Static<typeof OfficialExerciseSchema>;

/** 各管理页面使用相同版本信封，正文保持自身的封闭业务结构。 */
export function officialRowSchema(content: TSchema) {
  return Type.Object({
    id: Type.String(),
    kind: Type.Union([Type.Literal('exercise'), Type.Literal('template'), Type.Literal('plan')]),
    version: Type.Integer(),
    content,
    is_enabled: Type.Boolean(),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
    updated_by: Type.Union([Type.String(), Type.Null()]),
  });
}

export const FitnessMediaResponseSchema = Type.Object({
  id: Type.String(),
  url: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
  frames: Type.Integer(),
  byte_size: Type.Integer(),
});
