import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { execute } from '../../shared/execute.js';
import { createMultiKeyRateLimit } from '../../shared/rate-limit.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { authenticateAdmin, verifyAdminWriteRequest } from '../admin/index.js';
import {
  AnalyticsEventSchema,
  AnalyticsQuerySchema,
  AnalyticsReportSchema,
  AnalyticsDetailsQuerySchema,
  AnalyticsDetailsSchema,
  AnalyticsCatalogSchema,
  AnalyticsFunnelQuerySchema,
  AnalyticsFunnelSchema,
  type AnalyticsEventInput,
  type AnalyticsQuery,
  type AnalyticsDetailsQuery,
  type AnalyticsFunnelQuery,
} from './analytics-contract.js';
import { ANALYTICS_DEFINITIONS } from './analytics-catalog.js';
import { analyticsActorKey, ingestAnalyticsEvents, readAnalyticsReport } from './analytics-service.js';
import { readAnalyticsDetails } from './analytics-details.js';
import { readAnalyticsFunnel } from './analytics-funnel.js';
import { BannerStatisticsSchema } from './analytics-banner-contract.js';
import { readBannerStatistics } from './analytics-banner-statistics.js';

/** 产品事件只从真实登录账号采集；后台只读查询固定目录、整体指标与行为分析。 */
export function registerAnalyticsRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  try {
    app.get(
      '/api/v1/admin/banners/statistics',
      {
        onRequest: verifyAdminWriteRequest(config),
        preHandler: authenticateAdmin(config, prisma, 'banners:read'),
        schema: {
          tags: ['admin-banners'],
          operationId: 'getAdminBannerStatistics',
          querystring: Type.Object({}, { additionalProperties: false }),
          response: { 200: BannerStatisticsSchema },
        },
      },
      async (request) => execute(request, '查询 Banner 统计', async () => readBannerStatistics(prisma)),
    );
    app.post(
      '/api/v1/analytics/events',
      {
        bodyLimit: 65_536,
        preHandler: [
          authenticate(config, prisma),
          requireScopes('profile:read', 'profile:write'),
          createMultiKeyRateLimit(120, 60_000, (request) => analyticsActorKey(requireAuth(request).userId)),
        ],
        schema: {
          tags: ['analytics'],
          body: Type.Object(
            { events: Type.Array(AnalyticsEventSchema, { minItems: 1, maxItems: 100 }) },
            { additionalProperties: false },
          ),
          response: { 200: Type.Object({ accepted: Type.Integer(), duplicates: Type.Integer() }) },
        },
      },
      async (request) =>
        execute(request, '记录产品使用情况', async () => {
          const { events } = request.body as { events: AnalyticsEventInput[] };
          return ingestAnalyticsEvents(prisma, requireAuth(request).userId, events);
        }),
    );
    const guarded = {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'analytics:read'),
    };
    app.get(
      '/api/v1/admin/analytics',
      {
        ...guarded,
        schema: { tags: ['admin'], querystring: AnalyticsQuerySchema, response: { 200: AnalyticsReportSchema } },
      },
      async (request) =>
        execute(request, '查询数据统计', async () => readAnalyticsReport(prisma, request.query as AnalyticsQuery)),
    );
    app.get(
      '/api/v1/admin/analytics/details',
      {
        ...guarded,
        schema: {
          tags: ['admin'],
          querystring: AnalyticsDetailsQuerySchema,
          response: { 200: AnalyticsDetailsSchema },
        },
      },
      async (request) =>
        execute(request, '查询事件分析', async () =>
          readAnalyticsDetails(prisma, request.query as AnalyticsDetailsQuery),
        ),
    );
    app.get(
      '/api/v1/admin/analytics/catalog',
      {
        ...guarded,
        schema: { tags: ['admin'], response: { 200: AnalyticsCatalogSchema } },
      },
      async () => ({ events: ANALYTICS_DEFINITIONS }),
    );
    app.post(
      '/api/v1/admin/analytics/funnel',
      {
        ...guarded,
        bodyLimit: 16_384,
        schema: { tags: ['admin'], body: AnalyticsFunnelQuerySchema, response: { 200: AnalyticsFunnelSchema } },
      },
      async (request) =>
        execute(request, '查询漏斗转化', async () => readAnalyticsFunnel(prisma, request.body as AnalyticsFunnelQuery)),
    );
  } catch (cause) {
    throw new Error('数据统计接口注册失败', { cause });
  }
}
