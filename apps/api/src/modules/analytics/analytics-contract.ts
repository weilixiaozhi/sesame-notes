import { Type, type Static } from '@sinclair/typebox';
import { ANALYTICS_EVENT_NAMES, ANALYTICS_PAGE_IDS } from './analytics-catalog.js';
import {
  AnalyticsBannerSlotSchema,
  AnalyticsBannerIdSchema,
  AnalyticsBannerSourceSchema,
  AnalyticsBannerVersionSchema,
} from './analytics-banner-contract.js';

export const AnalyticsEventSchema = Type.Object(
  {
    event_id: Type.String({ format: 'uuid' }),
    occurred_at: Type.String({ format: 'date-time' }),
    kind: Type.Union([Type.Literal('active'), Type.Literal('page_view'), Type.Literal('action')]),
    page_id: Type.Optional(Type.Union(ANALYTICS_PAGE_IDS.map((page) => Type.Literal(page)))),
    platform: Type.Union([Type.Literal('app'), Type.Literal('web')]),
    app_version: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    event_name: Type.Optional(Type.Union(ANALYTICS_EVENT_NAMES.map((name) => Type.Literal(name)))),
    session_id: Type.String({ format: 'uuid' }),
    event_sequence: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
    flow_id: Type.Optional(Type.String({ format: 'uuid' })),
    banner_slot: Type.Optional(AnalyticsBannerSlotSchema),
    banner_id: Type.Optional(AnalyticsBannerIdSchema),
    banner_source: Type.Optional(AnalyticsBannerSourceSchema),
    banner_version: Type.Optional(AnalyticsBannerVersionSchema),
  },
  { additionalProperties: false },
);

export type AnalyticsEventInput = Static<typeof AnalyticsEventSchema>;
const AnalyticsPlatformSchema = Type.Union([Type.Literal('all'), Type.Literal('app'), Type.Literal('web')]);
export const AnalyticsQuerySchema = Type.Object(
  {
    start_date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    end_date: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    platform: Type.Optional(AnalyticsPlatformSchema),
    bucket: Type.Optional(
      Type.Union([Type.Literal('auto'), Type.Literal('hour'), Type.Literal('day'), Type.Literal('month')]),
    ),
  },
  { additionalProperties: false },
);
export type AnalyticsQuery = Static<typeof AnalyticsQuerySchema>;

const MetricsSchema = Type.Object({
  new_users: Type.Integer({ minimum: 0 }),
  active_users: Type.Integer({ minimum: 0 }),
  page_views: Type.Integer({ minimum: 0 }),
});
export const AnalyticsReportSchema = Type.Object({
  range: Type.Object({
    start_date: Type.String(),
    end_date: Type.String(),
    timezone: Type.Literal('Asia/Shanghai'),
    platform: AnalyticsPlatformSchema,
    bucket: Type.Union([Type.Literal('hour'), Type.Literal('day'), Type.Literal('month')]),
  }),
  summary: MetricsSchema,
  series: Type.Array(
    Type.Intersect([Type.Object({ period_start: Type.String({ format: 'date-time' }) }), MetricsSchema]),
  ),
  coverage: Type.Object({
    collection_started_at: Type.String({ format: 'date-time' }),
    complete: Type.Boolean(),
  }),
});

export const AnalyticsDetailsQuerySchema = Type.Object(
  {
    ...AnalyticsQuerySchema.properties,
    page_id: Type.Optional(Type.Union(ANALYTICS_PAGE_IDS.map((page) => Type.Literal(page)))),
    event_name: Type.Optional(Type.Union(ANALYTICS_EVENT_NAMES.map((name) => Type.Literal(name)))),
    behavior: Type.Optional(Type.Union([Type.Literal('view'), Type.Literal('click'), Type.Literal('complete')])),
  },
  { additionalProperties: false },
);
export type AnalyticsDetailsQuery = Static<typeof AnalyticsDetailsQuerySchema>;
const AnalyticsBehaviorMetricsSchema = Type.Object({
  page_views: Type.Integer({ minimum: 0 }),
  visitors: Type.Integer({ minimum: 0 }),
  clicks: Type.Integer({ minimum: 0 }),
  click_users: Type.Integer({ minimum: 0 }),
  completions: Type.Integer({ minimum: 0 }),
  completion_users: Type.Integer({ minimum: 0 }),
});
const NullableNumber = Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);
export const AnalyticsDetailsSchema = Type.Object({
  range: AnalyticsReportSchema.properties.range,
  summary: AnalyticsBehaviorMetricsSchema,
  series: Type.Array(
    Type.Object({ period_start: Type.String({ format: 'date-time' }), ...AnalyticsBehaviorMetricsSchema.properties }),
  ),
  pages: Type.Array(
    Type.Object({
      page_id: Type.String(),
      event_name: Type.String(),
      name: Type.String(),
      page_views: Type.Integer({ minimum: 0 }),
      visitors: Type.Integer({ minimum: 0 }),
    }),
  ),
  events: Type.Array(
    Type.Object({
      event_name: Type.String(),
      name: Type.String(),
      behavior: Type.Union([Type.Literal('click'), Type.Literal('complete')]),
      total: Type.Integer({ minimum: 0 }),
      users: Type.Integer({ minimum: 0 }),
    }),
  ),
  exposures: Type.Optional(
    Type.Array(
      Type.Object({
        event_name: Type.String(),
        name: Type.String(),
        total: Type.Integer({ minimum: 0 }),
        users: Type.Integer({ minimum: 0 }),
      }),
    ),
  ),
  coverage: Type.Object({
    collection_started_at: Type.String({ format: 'date-time' }),
    complete: Type.Boolean(),
  }),
});
export const AnalyticsDefinitionSchema = Type.Object({
  id: Type.String(),
  event_name: Type.String(),
  page_id: Type.Union([Type.String(), Type.Null()]),
  kind: Type.Union([Type.Literal('page_view'), Type.Literal('action')]),
  behavior: Type.Union([Type.Literal('view'), Type.Literal('click'), Type.Literal('complete')]),
  name: Type.String(),
  location: Type.String(),
  platforms: Type.Array(Type.Union([Type.Literal('app'), Type.Literal('web')]), {
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
  }),
  source_pages: Type.Array(
    Type.Object({
      page_id: Type.String(),
      platforms: Type.Array(Type.Union([Type.Literal('app'), Type.Literal('web')]), {
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
      }),
    }),
  ),
});
export const AnalyticsCatalogSchema = Type.Object({
  events: Type.Array(AnalyticsDefinitionSchema),
});
export const AnalyticsFunnelQuerySchema = Type.Object(
  {
    start_date: AnalyticsQuerySchema.properties.start_date,
    end_date: AnalyticsQuerySchema.properties.end_date,
    platform: Type.Optional(AnalyticsPlatformSchema),
    steps: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 2, maxItems: 8 }),
    scope: Type.Union([Type.Literal('user'), Type.Literal('session'), Type.Literal('flow')]),
    window_minutes: Type.Integer({ minimum: 1, maximum: 10080 }),
  },
  { additionalProperties: false },
);
export type AnalyticsFunnelQuery = Static<typeof AnalyticsFunnelQuerySchema>;
export const AnalyticsFunnelSchema = Type.Object({
  range: Type.Object({
    start_date: Type.String(),
    end_date: Type.String(),
    timezone: Type.Literal('Asia/Shanghai'),
    platform: AnalyticsPlatformSchema,
  }),
  scope: AnalyticsFunnelQuerySchema.properties.scope,
  window_minutes: Type.Integer({ minimum: 1, maximum: 10080 }),
  steps: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      users: Type.Integer({ minimum: 0 }),
      conversion_rate: NullableNumber,
      drop_off: Type.Integer({ minimum: 0 }),
    }),
  ),
  completion_rate: NullableNumber,
  coverage: Type.Object({
    collection_started_at: Type.String({ format: 'date-time' }),
    complete: Type.Boolean(),
    missing_context_events: Type.Integer({ minimum: 0 }),
  }),
});
