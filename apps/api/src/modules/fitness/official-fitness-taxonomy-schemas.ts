import { Type, type Static } from '@sinclair/typebox';

export const FitnessTaxonKindSchema = Type.Union([Type.Literal('body_part'), Type.Literal('equipment')]);
export const FitnessTaxonNameSchema = Type.Object(
  {
    zh: Type.String({ minLength: 1, maxLength: 100 }),
    zh_hant: Type.String({ minLength: 1, maxLength: 100 }),
    en: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
const PublicFitnessTaxonSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  name: FitnessTaxonNameSchema,
  is_deleted: Type.Boolean(),
});
export const FitnessTaxonomiesSchema = Type.Object({
  body_parts: Type.Array(PublicFitnessTaxonSchema),
  equipment: Type.Array(PublicFitnessTaxonSchema),
});
export const AdminFitnessTaxonSchema = Type.Composite([
  PublicFitnessTaxonSchema,
  Type.Object({
    kind: FitnessTaxonKindSchema,
    sort_order: Type.Integer({ minimum: 0 }),
    version: Type.Integer({ minimum: 1 }),
    exercise_count: Type.Integer({ minimum: 0 }),
    template_count: Type.Integer({ minimum: 0 }),
  }),
]);
export type FitnessTaxonKind = Static<typeof FitnessTaxonKindSchema>;
export type FitnessTaxonName = Static<typeof FitnessTaxonNameSchema>;
