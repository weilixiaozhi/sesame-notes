import { Type, type Static } from '@sinclair/typebox';

export const ANALYTICS_BANNER_PAGES = {
  'fitness-plan-library': 'fitness.plans',
  'fitness-template-library': 'fitness.templates',
} as const;
export const AnalyticsBannerSlotSchema = Type.Union([
  Type.Literal('fitness-plan-library'),
  Type.Literal('fitness-template-library'),
]);
export const AnalyticsBannerSourceSchema = Type.Union([Type.Literal('builtin'), Type.Literal('remote')]);
export const AnalyticsBannerIdSchema = Type.Union([
  Type.String({ format: 'uuid' }),
  Type.Literal('builtin:fitness-plan-library'),
  Type.Literal('builtin:fitness-template-library'),
]);
export const AnalyticsBannerVersionSchema = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });
export const BannerStatisticsQuerySchema = Type.Object(
  {
    start_date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    end_date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  },
  { additionalProperties: false },
);
export const BannerStatisticsSchema = Type.Object({
  range: Type.Object({
    start_date: Type.String(),
    end_date: Type.String(),
    timezone: Type.Literal('Asia/Shanghai'),
  }),
  scope: Type.Literal('current'),
  items: Type.Array(
    Type.Object({
      banner_id: AnalyticsBannerIdSchema,
      slot: AnalyticsBannerSlotSchema,
      source: AnalyticsBannerSourceSchema,
      version: AnalyticsBannerVersionSchema,
      impressions: Type.Integer({ minimum: 0 }),
      clicks: Type.Integer({ minimum: 0 }),
      ctr: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    }),
    { minItems: 2 },
  ),
  coverage: Type.Object({
    collection_started_at: Type.String({ format: 'date-time' }),
    complete: Type.Boolean(),
    audience: Type.Literal('authenticated_users'),
  }),
});
export type BannerStatisticsQuery = Static<typeof BannerStatisticsQuerySchema>;
