import { Prisma, type PrismaClient } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import type { ANALYTICS_BANNER_PAGES } from './analytics-banner-contract.js';

type BannerCountRow = {
  banner_id: string;
  slot: keyof typeof ANALYTICS_BANNER_PAGES;
  source: 'remote';
  version: number;
  impressions: bigint;
  clicks: bigint;
};

/** 在同一快照中按图片稳定身份汇总已发生的全部记录，版本和位置只标识当前配置。 */
export async function readBannerStatistics(prisma: PrismaClient, now = new Date()) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const state = await tx.productAnalyticsState.findUnique({ where: { id: 1 } });
        if (!state?.bannerStartedAt)
          throw new ApiError(503, 'ANALYTICS_NOT_READY', 'Banner 采集尚未初始化，请稍后再试');
        const rows = await tx.$queryRaw<BannerCountRow[]>(Prisma.sql`
        WITH current_banners AS (
          SELECT b.id::text AS banner_id,b.slot,'remote' AS source,b.version,b.sort_order
          FROM app_banners b WHERE b.deleted_at IS NULL AND b.is_enabled
        )
        SELECT b.banner_id,b.slot,b.source,b.version,
          COUNT(e.event_id) FILTER (WHERE e.event_name='banner_impression') AS impressions,
          COUNT(e.event_id) FILTER (WHERE e.event_name='banner_click') AS clicks
        FROM current_banners b LEFT JOIN product_analytics_events e
          ON e.banner_id=b.banner_id AND e.banner_source='remote'
          AND e.kind='action' AND e.platform='app' AND e.occurred_at<=${now}
          AND e.event_name IN ('banner_impression','banner_click')
        GROUP BY b.banner_id,b.slot,b.source,b.version,b.sort_order ORDER BY b.slot,b.sort_order,b.banner_id
      `);
        return {
          scope: 'total' as const,
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
            complete: true as const,
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
