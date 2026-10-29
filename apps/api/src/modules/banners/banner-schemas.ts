import { Type, type Static } from '@sinclair/typebox';

export const BANNER_SLOTS = ['fitness-plan-library', 'fitness-template-library'] as const;
export const LEGACY_BANNER_TARGETS = [
  ...BANNER_SLOTS,
  'fitness-exercises',
  'fitness-plans',
  'fitness-templates',
] as const;
export const BANNER_TARGETS = [...LEGACY_BANNER_TARGETS, 'official-plan', 'official-template'] as const;
export const MAX_BANNER_SLIDES_PER_SLOT = 20;
export const BannerSlotSchema = Type.Union(BANNER_SLOTS.map((value) => Type.Literal(value)));
export const BannerTargetSchema = Type.Union(BANNER_TARGETS.map((value) => Type.Literal(value)));
export const BannerMediaIdSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const BannerIdSchema = Type.String({ format: 'uuid' });
export const BannerVersionSchema = Type.Integer({ minimum: 1, maximum: 2_147_483_646 });
const nullableImage = Type.Union([Type.String({ pattern: '^/api/v1/banners/media/[a-f0-9]{64}$' }), Type.Null()]);
const nullableDate = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
export const BannerEntrySchema = Type.Object({
  slot: BannerSlotSchema,
  image_path: nullableImage,
  target: Type.Union(LEGACY_BANNER_TARGETS.map((value) => Type.Literal(value))),
  is_enabled: Type.Boolean(),
  version: Type.Integer({ minimum: 0 }),
  updated_at: nullableDate,
});
export const BannerListSchema = Type.Object({
  items: Type.Array(BannerEntrySchema, { maxItems: BANNER_SLOTS.length }),
});
export const BannerSlideSchema = Type.Object({
  id: BannerIdSchema,
  slot: BannerSlotSchema,
  image_path: nullableImage,
  target: BannerTargetSchema,
  target_id: Type.Union([BannerIdSchema, Type.Null()]),
  target_name: Type.Union([Type.String(), Type.Null()]),
  version: BannerVersionSchema,
  sort_order: Type.Integer({ minimum: 0, maximum: 9999 }),
});
export const BannerCarouselSchema = Type.Object({
  items: Type.Array(BannerSlideSchema, { maxItems: BANNER_SLOTS.length * MAX_BANNER_SLIDES_PER_SLOT }),
});
export const AdminBannerEntrySchema = Type.Object({
  ...BannerSlideSchema.properties,
  id: Type.Union([BannerIdSchema, Type.String({ pattern: '^builtin:fitness-(?:plan|template)-library$' })]),
  version: Type.Integer({ minimum: 0 }),
  source: Type.Union([Type.Literal('builtin'), Type.Literal('remote')]),
  updated_at: nullableDate,
  updated_by: Type.Union([Type.String(), Type.Null()]),
});
export const AdminBannerListSchema = Type.Object({
  items: Type.Array(AdminBannerEntrySchema, { maxItems: BANNER_SLOTS.length * MAX_BANNER_SLIDES_PER_SLOT }),
});
const editable = {
  slot: BannerSlotSchema,
  image_id: BannerMediaIdSchema,
  target: BannerTargetSchema,
  target_id: Type.Union([BannerIdSchema, Type.Null()]),
  sort_order: Type.Integer({ minimum: 0, maximum: 9999 }),
};
export const BannerCreateSchema = Type.Object(editable, { additionalProperties: false });
export const BannerUpdateSchema = Type.Object(
  { ...editable, version: BannerVersionSchema },
  { additionalProperties: false },
);
export const BannerDeleteSchema = Type.Object({ version: BannerVersionSchema }, { additionalProperties: false });
export const BannerResetSchema = Type.Object(
  {
    revisions: Type.Array(
      Type.Object({ id: BannerIdSchema, version: BannerVersionSchema }, { additionalProperties: false }),
      { maxItems: MAX_BANNER_SLIDES_PER_SLOT, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);
export const BannerTargetOptionsSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: BannerIdSchema,
      name: Type.Object({ zh: Type.String(), zh_hant: Type.String(), en: Type.String() }),
    }),
    { maxItems: 100 },
  ),
});
export const BannerUploadResponseSchema = Type.Object({
  id: BannerMediaIdSchema,
  image_path: Type.String({ pattern: '^/api/v1/banners/media/[a-f0-9]{64}$' }),
  width: Type.Integer({ minimum: 1, maximum: 4096 }),
  height: Type.Integer({ minimum: 1, maximum: 4096 }),
});
export type BannerSlot = (typeof BANNER_SLOTS)[number];
export type BannerCreate = Static<typeof BannerCreateSchema>;
export type BannerUpdate = Static<typeof BannerUpdateSchema>;
export type BannerReset = Static<typeof BannerResetSchema>;
