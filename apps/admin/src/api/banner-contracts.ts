import { z } from 'zod';

export const bannerSlotSchema = z.enum(['fitness-plan-library', 'fitness-template-library']);
export const bannerTargetSchema = z.enum([
  'fitness-plan-library',
  'fitness-template-library',
  'fitness-exercises',
  'fitness-plans',
  'fitness-templates',
]);
export const bannerImagePathSchema = z.string().regex(/^\/api\/v1\/banners\/media\/[a-f0-9]{64}$/);
export const bannerEntrySchema = z.object({
  slot: bannerSlotSchema,
  image_path: bannerImagePathSchema.nullable(),
  target: bannerTargetSchema,
  is_enabled: z.boolean(),
  version: z.number().int().nonnegative(),
  updated_at: z.iso.datetime().nullable(),
});
export const bannerListSchema = z.object({
  items: z
    .array(bannerEntrySchema)
    .length(2)
    .refine((items) => new Set(items.map((item) => item.slot)).size === 2),
});
export const bannerUploadSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    image_path: bannerImagePathSchema,
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
  })
  .refine((media) => media.image_path.endsWith(`/${media.id}`));
