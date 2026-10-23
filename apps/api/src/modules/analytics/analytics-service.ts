import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import type { AnalyticsEventInput, AnalyticsQuery } from './analytics-contract.js';
import { ANALYTICS_DEFINITION_MAP, ANALYTICS_PAGE_DEFINITION_MAP } from './analytics-catalog.js';

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const ANALYTICS_MAX_EVENT_AGE_MS = 90 * DAY_MS;
type Bucket = 'hour' | 'day' | 'month';
type Metrics = { new_users: number; active_users: number; page_views: number };
type AggregateRow = { period_start: Date | null; new_users: bigint; active_users: bigint; page_views: bigint };

/** 仅从已验证账号派生跨客户端一致的统计标识，不接受客户端声明的用户身份。 */
export function analyticsActorKey(userId: string): string {
  return createHash('sha256').update(`sesame-analytics-user:${userId}`).digest('hex');
}

/** 按上海自然日解析并反查，拒绝自动进位的无效日期。 */
function parseShanghaiDay(value: string): Date {
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp) || new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'ANALYTICS_RANGE_INVALID', '请选择有效的起止日期');
  }
  return new Date(timestamp);
}

/** 日期范围与本次读取时刻共同限定事实边界；保留当前毫秒，尚未发生的时间不产生零值桶。 */
export function analyticsRange(query: AnalyticsQuery, now = new Date()) {
  const start = parseShanghaiDay(query.start_date);
  const end = new Date(parseShanghaiDay(query.end_date).getTime() + DAY_MS);
  const days = (end.getTime() - start.getTime()) / DAY_MS;
  if (days < 1 || days > 3660) {
    throw new ApiError(400, 'ANALYTICS_RANGE_INVALID', '结束日期不能早于开始日期，单次查询最长为十年');
  }
  const today = new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  if (query.end_date > today) {
    throw new ApiError(400, 'ANALYTICS_RANGE_FUTURE', '结束日期不能晚于北京时间今天');
  }
  const bucket: Bucket =
    !query.bucket || query.bucket === 'auto' ? (days === 1 ? 'hour' : days > 366 ? 'month' : 'day') : query.bucket;
  if (bucket === 'hour' && days > 31) {
    throw new ApiError(400, 'ANALYTICS_BUCKET_INVALID', '按小时查看时请选择不超过 31 天的范围，较长范围可按日或月查看');
  }
  return { start, end: new Date(Math.min(end.getTime(), now.getTime() + 1)), bucket };
}

/** 批量重报按账号和事件标识幂等；活动与访问由同一登录账号跨端合并。 */
export async function ingestAnalyticsEvents(
  prisma: PrismaClient,
  userId: string,
  events: AnalyticsEventInput[],
  now = new Date(),
) {
  try {
    const actorKey = analyticsActorKey(userId);
    const data = events.map((event) => {
      const occurredAt = new Date(event.occurred_at);
      if (
        !Number.isFinite(occurredAt.getTime()) ||
        occurredAt.getTime() < now.getTime() - ANALYTICS_MAX_EVENT_AGE_MS ||
        occurredAt.getTime() > now.getTime() + 5 * 60_000
      ) {
        throw new ApiError(400, 'ANALYTICS_EVENT_TIME_INVALID', '使用记录时间无效，请校准设备时间后重试');
      }
      if ((event.kind === 'page_view' || event.kind === 'action') && !event.page_id) {
        throw new ApiError(400, 'ANALYTICS_PAGE_REQUIRED', '页面访问记录缺少页面标识');
      }
      if (event.kind === 'page_view' || event.kind === 'action') {
        const definition = ANALYTICS_DEFINITION_MAP.get(event.event_name ?? '');
        // 页面访问和操作都以事件名确定身份，页面位置只验证事件真实发生的上下文。
        if (
          !definition ||
          definition.kind !== event.kind ||
          !definition.platforms.includes(event.platform) ||
          (definition.kind === 'page_view'
            ? definition.page_id !== event.page_id
            : !definition.source_pages.some(
                (source) => source.page_id === event.page_id && source.platforms.includes(event.platform),
              ))
        ) {
          throw new ApiError(400, 'ANALYTICS_EVENT_INVALID', '事件标识、发生页面或采集端不匹配，请更新客户端后重试');
        }
      } else if (event.event_name !== undefined) {
        throw new ApiError(400, 'ANALYTICS_EVENT_NAME_INVALID', '活跃记录不能携带事件名');
      }
      if (event.page_id) {
        const page = ANALYTICS_PAGE_DEFINITION_MAP.get(event.page_id);
        if (!page?.platforms.includes(event.platform)) {
          throw new ApiError(400, 'ANALYTICS_PAGE_INVALID', '页面标识未定义或采集端不匹配，请更新客户端后重试');
        }
      }
      return {
        actorKey,
        eventId: event.event_id,
        kind: event.kind,
        occurredAt,
        platform: event.platform,
        pageId: event.page_id ?? null,
        appVersion: event.app_version ?? null,
        eventName: event.event_name ?? null,
        sessionId: event.session_id,
        eventSequence: event.event_sequence,
        flowId: event.flow_id ?? null,
      };
    });
    const result = await prisma.productAnalyticsEvent.createMany({ data, skipDuplicates: true });
    return { accepted: result.count, duplicates: events.length - result.count };
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('记录产品使用情况失败', { cause });
  }
}

/** 转换 SQL 聚合整数；客户端不接触统计主体标识和原始行为记录。 */
function metrics(row?: AggregateRow): Metrics {
  return {
    new_users: Number(row?.new_users ?? 0),
    active_users: Number(row?.active_users ?? 0),
    page_views: Number(row?.page_views ?? 0),
  };
}

/** 补齐没有事件的时间段，趋势与列表共用这一份连续序列。 */
export function fillAnalyticsSeries(start: Date, end: Date, bucket: Bucket, rows: AggregateRow[]) {
  const byPeriod = new Map(rows.filter((row) => row.period_start).map((row) => [row.period_start!.toISOString(), row]));
  const current = new Date(start.getTime() + SHANGHAI_OFFSET_MS);
  if (bucket === 'month') current.setUTCDate(1);
  const series: Array<Metrics & { period_start: string }> = [];
  while (current.getTime() - SHANGHAI_OFFSET_MS < end.getTime()) {
    const period = new Date(current.getTime() - SHANGHAI_OFFSET_MS).toISOString();
    series.push({ period_start: period, ...metrics(byPeriod.get(period)) });
    if (bucket === 'month') current.setUTCMonth(current.getUTCMonth() + 1);
    else current.setTime(current.getTime() + (bucket === 'hour' ? 3_600_000 : DAY_MS));
  }
  return series;
}

/** 在同一快照内独立聚合全范围去重人数与趋势，不能将逐日活跃相加作为范围活跃。 */
export async function readAnalyticsReport(prisma: PrismaClient, query: AnalyticsQuery) {
  const { start, end, bucket } = analyticsRange(query);
  const platform = query.platform ?? 'all';
  const platformFilter = platform === 'all' ? Prisma.empty : Prisma.sql`AND platform = ${platform}`;
  return prisma.$transaction(
    async (tx) => {
      const state = await tx.productAnalyticsState.findUnique({ where: { id: 1 } });
      if (!state) throw new ApiError(503, 'ANALYTICS_NOT_READY', '数据采集尚未初始化，请稍后再试');
      // GROUPING SETS 同时查询全区间与分桶数据，全区间 DISTINCT 不受客户端、日期分组影响。
      const rows = await tx.$queryRaw<AggregateRow[]>(Prisma.sql`
      WITH scoped_events AS (
        SELECT actor_key, kind,
          date_trunc(${bucket}, occurred_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS period_start
        FROM product_analytics_events WHERE occurred_at >= ${start} AND occurred_at < ${end}
          ${platformFilter}
      )
      SELECT period_start,
        COUNT(*) FILTER (WHERE kind = 'registration') AS new_users,
        COUNT(DISTINCT actor_key) FILTER (WHERE kind IN ('active', 'page_view', 'action')) AS active_users,
        COUNT(*) FILTER (WHERE kind = 'page_view') AS page_views
      FROM scoped_events
      GROUP BY GROUPING SETS ((period_start), ())
      ORDER BY period_start NULLS FIRST
    `);
      return {
        range: {
          start_date: query.start_date,
          end_date: query.end_date,
          timezone: 'Asia/Shanghai' as const,
          platform,
          bucket,
        },
        summary: metrics(rows.find((row) => row.period_start === null)),
        series: fillAnalyticsSeries(start, end, bucket, rows),
        coverage: {
          collection_started_at: state.startedAt.toISOString(),
          complete: start.getTime() >= state.startedAt.getTime(),
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
