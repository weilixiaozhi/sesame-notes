import { Prisma, type PrismaClient } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { analyticsRange } from './analytics-service.js';
import type { ANALYTICS_BANNER_PAGES, BannerStatisticsQuery } from './analytics-banner-contract.js';

type BannerCountRow = {
  banner_id: string;
  slot: keyof typeof ANALYTICS_BANNER_PAGES;
  source: 'builtin' | 'remote';
  version: number;
  impressions: bigint;
  clicks: bigint;
};

/** 同一数据库快照同时确定当前素材和事件范围，换图前的历史不会计入新版本。 */
export async function readBannerStatistics(prisma: PrismaClient, query: BannerStatisticsQuery, now = new Date()) {
  try {
    const { start, end } = analyticsRange(query, now);
    return await prisma.$transaction(
      async (tx) => {
        const state = await tx.productAnalyticsState.findUnique({ where: { id: 1 } });
        if (!state?.bannerStartedAt)
          throw new ApiError(503, 'ANALYTICS_NOT_READY', 'Banner 采集尚未初始化，请稍后再试');
        const rows = await tx.$queryRaw<BannerCountRow[]>(Prisma.sql`
        WITH positions(slot) AS (VALUES ('fitness-plan-library'), ('fitness-template-library')),
        current_banners AS (
          SELECT b.id::text AS banner_id,b.slot,'remote' AS source,b.version,b.sort_order
          FROM app_banners b WHERE b.deleted_at IS NULL AND b.is_enabled
          UNION ALL
          SELECT 'builtin:' || p.slot,p.slot,'builtin',0,0 FROM positions p
          WHERE NOT EXISTS (SELECT 1 FROM app_banners b WHERE b.slot=p.slot AND b.deleted_at IS NULL AND b.is_enabled)
        )
        SELECT b.banner_id,b.slot,b.source,b.version,
          COUNT(e.event_id) FILTER (WHERE e.event_name='banner_impression') AS impressions,
          COUNT(e.event_id) FILTER (WHERE e.event_name='banner_click') AS clicks
        FROM current_banners b LEFT JOIN product_analytics_events e
          ON e.banner_id=b.banner_id AND e.banner_slot=b.slot AND e.banner_source=b.source AND e.banner_version=b.version
          AND e.kind='action' AND e.platform='app' AND e.occurred_at>=${start} AND e.occurred_at<${end}
          AND e.event_name IN ('banner_impression','banner_click')
        GROUP BY b.banner_id,b.slot,b.source,b.version,b.sort_order ORDER BY b.slot,b.sort_order,b.banner_id
      `);
        return {
          range: { start_date: query.start_date, end_date: query.end_date, timezone: 'Asia/Shanghai' as const },
          scope: 'current' as const,
          items: rows.map((row) => ({
            banner_id: row.banner_id,
            slot: row.slot,
            source: row.source,
            version: row.version,
            impressions: Number(row.impressions),
            clicks: Number(row.clicks),
            // 零曝光没有可计算的比率；重复真实点击可以使点击次数高于曝光，不人为截断。
            ctr: row.impressions > 0n ? Number(row.clicks) / Number(row.impressions) : null,
          })),
          coverage: {
            collection_started_at: state.bannerStartedAt.toISOString(),
            complete: start.getTime() >= state.bannerStartedAt.getTime(),
            audience: 'authenticated_users' as const,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('查询 Banner 统计失败', { cause });
  }
}
