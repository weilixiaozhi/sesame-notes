import { z } from 'zod';

const count = z.number().int().nonnegative();
const metrics = z.object({
  page_views: count,
  visitors: count,
  clicks: count,
  click_users: count,
  completions: count,
  completion_users: count,
});
const ratio = z.number().min(0).max(1).nullable();
export const analyticsCatalogSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      event_name: z.string().min(1),
      page_id: z.string().nullable(),
      kind: z.enum(['page_view', 'action']),
      behavior: z.enum(['view', 'click', 'complete']),
      location: z.string(),
      source_pages: z.array(
        z.object({
          page_id: z.string(),
          platforms: z
            .array(z.enum(['app', 'web']))
            .min(1)
            .max(2),
        }),
      ),
      platforms: z
        .array(z.enum(['app', 'web']))
        .min(1)
        .max(2),
    }),
  ),
});
export const analyticsDetailsSchema = z.object({
  range: z.object({
    start_date: z.string(),
    end_date: z.string(),
    timezone: z.literal('Asia/Shanghai'),
    platform: z.enum(['all', 'app', 'web']),
    bucket: z.enum(['hour', 'day', 'month']),
  }),
  summary: metrics,
  series: z.array(metrics.extend({ period_start: z.iso.datetime() })),
  pages: z.array(
    z.object({
      event_name: z.string().min(1),
      page_id: z.string(),
      name: z.string(),
      page_views: count,
      visitors: count,
    }),
  ),
  events: z.array(
    z.object({
      event_name: z.string(),
      name: z.string(),
      behavior: z.enum(['click', 'complete']),
      total: count,
      users: count,
    }),
  ),
  exposures: z.array(z.object({ event_name: z.string(), name: z.string(), total: count, users: count })).optional(),
  coverage: z.object({
    collection_started_at: z.iso.datetime(),
    complete: z.boolean(),
  }),
});

export const analyticsFunnelSchema = z.object({
  range: z.object({
    start_date: z.string(),
    end_date: z.string(),
    timezone: z.literal('Asia/Shanghai'),
    platform: z.enum(['all', 'app', 'web']),
  }),
  scope: z.enum(['user', 'session', 'flow']),
  window_minutes: z.number().int().min(1).max(10080),
  steps: z
    .array(z.object({ id: z.string(), name: z.string(), users: count, conversion_rate: ratio, drop_off: count }))
    .min(2)
    .max(8),
  completion_rate: ratio,
  coverage: z.object({ collection_started_at: z.iso.datetime(), complete: z.boolean(), missing_context_events: count }),
});
