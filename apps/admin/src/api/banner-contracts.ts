import { z } from 'zod';

export const bannerSlotSchema = z.enum(['fitness-plan-library', 'fitness-template-library']);
export const bannerTargetSchema = z.enum([
  'fitness-plan-library',
  'fitness-template-library',
  'fitness-exercises',
  'fitness-plans',
  'fitness-templates',
  'official-plan',
  'official-template',
]);
export const bannerImagePathSchema = z.string().regex(/^\/api\/v1\/banners\/media\/[a-f0-9]{64}$/);
export const bannerEntrySchema = z.object({
  id: z.uuid(),
  slot: bannerSlotSchema,
  image_path: bannerImagePathSchema.nullable(),
  target: bannerTargetSchema,
  source: z.literal('remote'),
  target_id: z.string().nullable(),
  target_name: z.string().nullable(),
  sort_order: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  updated_at: z.iso.datetime().nullable(),
  updated_by: z.string().nullable(),
});
export const bannerListSchema = z.object({
  items: z.array(bannerEntrySchema).refine((items) => new Set(items.map((item) => item.id)).size === items.length),
});
export const bannerUploadSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    image_path: bannerImagePathSchema,
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
  })
  .refine((media) => media.image_path.endsWith(`/${media.id}`));

export const bannerStatisticsSchema = z.object({
  range: z.object({ start_date: z.string(), end_date: z.string(), timezone: z.literal('Asia/Shanghai') }),
  scope: z.literal('current'),
  items: z
    .array(
      z.object({
        banner_id: z.string(),
        slot: bannerSlotSchema,
        source: z.enum(['builtin', 'remote']),
        version: z.number().int().nonnegative(),
        impressions: z.number().int().nonnegative(),
        clicks: z.number().int().nonnegative(),
        ctr: z.number().nonnegative().nullable(),
      }),
    )
    .refine((items) => new Set(items.map((item) => item.banner_id)).size === items.length),
  coverage: z.object({
    collection_started_at: z.iso.datetime(),
    complete: z.boolean(),
    audience: z.literal('authenticated_users'),
  }),
});

export const bannerTargetsSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.object({ zh: z.string(), zh_hant: z.string(), en: z.string() }) })),
});
