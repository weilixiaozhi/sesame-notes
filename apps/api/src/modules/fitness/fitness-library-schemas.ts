import { Type, type Static, type TSchema } from '@sinclair/typebox';

import { AnyUuidSchema } from '../../shared/contracts/scalars.js';

const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const localizedText = object({
  zh: Type.String({ minLength: 1, maxLength: 500 }),
  zh_hant: Type.String({ minLength: 1, maxLength: 500 }),
  en: Type.String({ minLength: 1, maxLength: 1000 }),
});
const localizedGoals = object({
  zh: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }),
  zh_hant: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }),
  en: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 20 }),
});
const decimalWeight = Type.String({ pattern: '^(0|[1-9][0-9]{0,5})(\\.[0-9]{1,3})?$' });

const OfficialFitnessExerciseSchema = object({
  exercise_id: Type.String({ minLength: 1, maxLength: 128 }),
  sets: Type.Integer({ minimum: 1, maximum: 1000 }),
  reps: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  weight_kg: Type.Union([decimalWeight, Type.Null()]),
  weight_mode: Type.Union([Type.Literal('total'), Type.Literal('per_side'), Type.Literal('body_weight')]),
  rest_seconds: Type.Integer({ minimum: 0, maximum: 2147483647 }),
});

export const OfficialFitnessTemplateSchema = object({
  id: AnyUuidSchema,
  revision: Type.Integer({ minimum: 1 }),
  name: localizedText,
  description: localizedText,
  difficulty: Type.Union([Type.Literal('beginner'), Type.Literal('intermediate'), Type.Literal('advanced')]),
  goals: localizedGoals,
  duration_minutes: Type.Integer({ minimum: 1, maximum: 1440 }),
  equipment: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
  }),
  exercises: Type.Array(OfficialFitnessExerciseSchema, { minItems: 1, maxItems: 1000 }),
});

export const OfficialFitnessPlanSchema = object({
  id: AnyUuidSchema,
  revision: Type.Integer({ minimum: 1 }),
  name: localizedText,
  description: localizedText,
  difficulty: Type.Union([Type.Literal('beginner'), Type.Literal('intermediate'), Type.Literal('advanced')]),
  goals: localizedGoals,
  cycle_days: Type.Integer({ minimum: 1, maximum: 36500 }),
  days: Type.Array(
    object({
      day_index: Type.Integer({ minimum: 0, maximum: 2147483647 }),
      template_id: Type.Union([AnyUuidSchema, Type.Null()]),
    }),
    { minItems: 1, maxItems: 36500 },
  ),
});

export const FitnessLibrarySchema = object({
  schema_version: Type.Integer({ minimum: 1, maximum: 1 }),
  content_version: Type.Integer({ minimum: 1 }),
  templates: Type.Array(OfficialFitnessTemplateSchema, { maxItems: 1000 }),
  plans: Type.Array(OfficialFitnessPlanSchema, { maxItems: 1000 }),
});

export type FitnessLibrary = Static<typeof FitnessLibrarySchema>;
