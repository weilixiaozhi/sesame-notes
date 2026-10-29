import { Type } from '@sinclair/typebox';

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
export const BannerStatisticsSchema = Type.Object({
  scope: Type.Literal('total'),
  items: Type.Array(
    Type.Object({
      banner_id: Type.String({ format: 'uuid' }),
      slot: AnalyticsBannerSlotSchema,
      source: Type.Literal('remote'),
      version: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
      impressions: Type.Integer({ minimum: 0 }),
      clicks: Type.Integer({ minimum: 0 }),
      ctr: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    }),
  ),
  coverage: Type.Object({
    collection_started_at: Type.String({ format: 'date-time' }),
    complete: Type.Literal(true),
    audience: Type.Literal('authenticated_users'),
  }),
});
