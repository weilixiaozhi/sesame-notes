import { Type, type Static } from '@sinclair/typebox';

export const BANNER_SLOTS = ['fitness-plan-library', 'fitness-template-library'] as const;
export const BANNER_TARGETS = [...BANNER_SLOTS, 'fitness-exercises', 'fitness-plans', 'fitness-templates'] as const;
export const BannerSlotSchema = Type.Union(BANNER_SLOTS.map((value) => Type.Literal(value)));
export const BannerTargetSchema = Type.Union(BANNER_TARGETS.map((value) => Type.Literal(value)));
export const BannerMediaIdSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const BannerEntrySchema = Type.Object({
  slot: BannerSlotSchema,
  image_path: Type.Union([Type.String({ pattern: '^/api/v1/banners/media/[a-f0-9]{64}$' }), Type.Null()]),
  target: BannerTargetSchema,
  is_enabled: Type.Boolean(),
  version: Type.Integer({ minimum: 0 }),
  updated_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});
export const BannerListSchema = Type.Object({
  items: Type.Array(BannerEntrySchema, { maxItems: BANNER_SLOTS.length }),
});
export const BannerUpdateSchema = Type.Object(
  {
    version: Type.Integer({ minimum: 0, maximum: 2_147_483_646 }),
    image_id: Type.Union([BannerMediaIdSchema, Type.Null()]),
    target: BannerTargetSchema,
    is_enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const BannerUploadResponseSchema = Type.Object({
  id: BannerMediaIdSchema,
  image_path: Type.String({ pattern: '^/api/v1/banners/media/[a-f0-9]{64}$' }),
  width: Type.Integer({ minimum: 1, maximum: 4096 }),
  height: Type.Integer({ minimum: 1, maximum: 4096 }),
});
export type BannerSlot = (typeof BANNER_SLOTS)[number];
export type BannerUpdate = Static<typeof BannerUpdateSchema>;
