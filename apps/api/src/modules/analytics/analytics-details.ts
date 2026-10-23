import { Prisma, type PrismaClient } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { ANALYTICS_DEFINITIONS, ANALYTICS_DEFINITION_MAP, ANALYTICS_PAGE_DEFINITION_MAP } from './analytics-catalog.js';
import type { AnalyticsDetailsQuery } from './analytics-contract.js';
import { analyticsRange, fillAnalyticsSeries } from './analytics-service.js';

type MetricRow = {
  page_views: bigint;
  visitors: bigint;
  clicks: bigint;
  click_users: bigint;
  completions: bigint;
  completion_users: bigint;
};
type AggregateRow = MetricRow & {
  period_start: Date | null;
  event_name: string | null;
  dimension: string;
};

/** SQL 聚合以 bigint 返回，响应统一转换为普通计数；缺失组合明确为零。 */
function behaviorMetrics(row?: MetricRow) {
  return {
    page_views: Number(row?.page_views ?? 0),
    visitors: Number(row?.visitors ?? 0),
    clicks: Number(row?.clicks ?? 0),
    click_users: Number(row?.click_users ?? 0),
    completions: Number(row?.completions ?? 0),
    completion_users: Number(row?.completion_users ?? 0),
  };
}

/** 用固定代码目录构造行为类型关系；事件身份通过参数绑定传入数据库。 */
function definitionRelation() {
  return Prisma.join(ANALYTICS_DEFINITIONS.map((definition) => Prisma.sql`(${definition.id},${definition.behavior})`));
}

/** 在聚合前完成日期、来源、页面、动作和行为类型筛选，所有指标共用同一口径。 */
function scopedEvents(query: AnalyticsDetailsQuery, start: Date, end: Date) {
  const conditions = [Prisma.sql`e.occurred_at >= ${start}`, Prisma.sql`e.occurred_at < ${end}`];
  if (query.platform && query.platform !== 'all') conditions.push(Prisma.sql`e.platform=${query.platform}`);
  if (query.behavior) conditions.push(Prisma.sql`d.behavior=${query.behavior}`);
  if (query.page_id) conditions.push(Prisma.sql`e.page_id=${query.page_id}`);
  if (query.event_name) conditions.push(Prisma.sql`e.event_name=${query.event_name}`);
  return Prisma.sql`
    SELECT e.actor_key,e.kind,e.page_id,e.event_name,e.occurred_at,d.behavior
    FROM product_analytics_events e
    JOIN (VALUES ${definitionRelation()}) AS d(id,behavior)
      ON d.id=e.event_name
    WHERE e.kind IN ('page_view','action') AND ${Prisma.join(conditions, ' AND ')}`;
}

/** 页面、动作与趋势由数据库直接去重聚合，范围去重数不能由下级人数相加。 */
export async function readAnalyticsDetails(prisma: PrismaClient, query: AnalyticsDetailsQuery) {
  try {
    const { start, end, bucket } = analyticsRange(query);
    const platform = query.platform && query.platform !== 'all' ? query.platform : undefined;
    const page = query.page_id ? ANALYTICS_PAGE_DEFINITION_MAP.get(query.page_id) : undefined;
    const definition = query.event_name ? ANALYTICS_DEFINITION_MAP.get(query.event_name) : undefined;
    if (
      (query.page_id && (!page || (platform && !page.platforms.includes(platform)))) ||
      (query.event_name &&
        (!definition ||
          (platform && !definition.platforms.includes(platform)) ||
          (query.behavior && query.behavior !== definition.behavior) ||
          (query.page_id &&
            (definition.kind === 'page_view'
              ? definition.page_id !== query.page_id
              : !definition.source_pages.some(
                  (source) => source.page_id === query.page_id && (!platform || source.platforms.includes(platform)),
                )))))
    ) {
      throw new ApiError(400, 'ANALYTICS_FILTER_INVALID', '事件、发生页面、事件类型与采集端的筛选条件不匹配');
    }
    return await prisma.$transaction(
      async (tx) => {
        const state = await tx.productAnalyticsState.findUnique({ where: { id: 1 } });
        if (!state) throw new ApiError(503, 'ANALYTICS_NOT_READY', '数据采集尚未初始化，请稍后再试');
        const scope = scopedEvents(query, start, end);
        // GROUPING 标记区分全范围、时间桶和各维度，真实 NULL 不会冒充全范围汇总。
        const rows = await tx.$queryRaw<AggregateRow[]>(Prisma.sql`
        WITH scoped AS (${scope}), timed AS (
          SELECT *,date_trunc(${bucket},occurred_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS period_start FROM scoped
        )
        SELECT period_start,event_name,
          CASE WHEN GROUPING(period_start)=0 THEN 'series'
            WHEN GROUPING(event_name)=0 THEN 'event' ELSE 'summary' END AS dimension,
          COUNT(*) FILTER (WHERE kind='page_view') AS page_views,
          COUNT(DISTINCT actor_key) FILTER (WHERE kind='page_view') AS visitors,
          COUNT(*) FILTER (WHERE behavior='click') AS clicks,
          COUNT(DISTINCT actor_key) FILTER (WHERE behavior='click') AS click_users,
          COUNT(*) FILTER (WHERE behavior='complete') AS completions,
          COUNT(DISTINCT actor_key) FILTER (WHERE behavior='complete') AS completion_users
        FROM timed GROUP BY GROUPING SETS ((),(period_start),(event_name))`);
        const seriesByPeriod = new Map(
          rows.filter((row) => row.dimension === 'series').map((row) => [row.period_start!.toISOString(), row]),
        );
        const series = fillAnalyticsSeries(start, end, bucket, []).map((row) => ({
          period_start: row.period_start,
          ...behaviorMetrics(seriesByPeriod.get(row.period_start)),
        }));
        const collectionStartedAt = state.startedAt;
        const complete = start.getTime() >= collectionStartedAt.getTime();
        return {
          range: {
            start_date: query.start_date,
            end_date: query.end_date,
            timezone: 'Asia/Shanghai' as const,
            platform: query.platform ?? 'all',
            bucket,
          },
          summary: behaviorMetrics(rows.find((row) => row.dimension === 'summary')),
          series,
          // 页面排行只计页面访问；操作事件所在页不会增加页面访问人数。
          pages: await readPageRanking(tx, scope),
          events: rows
            .filter(
              (row) =>
                row.dimension === 'event' &&
                row.event_name &&
                ANALYTICS_DEFINITION_MAP.get(row.event_name)?.kind === 'action',
            )
            .map((row) => {
              const definition = ANALYTICS_DEFINITION_MAP.get(row.event_name!)!;
              return {
                event_name: row.event_name!,
                name: definition.name,
                behavior: definition.behavior as 'click' | 'complete',
                total: Number(row.clicks + row.completions),
                users: row.clicks ? Number(row.click_users) : Number(row.completion_users),
              };
            })
            .sort((a, b) => b.total - a.total),
          coverage: {
            collection_started_at: collectionStartedAt.toISOString(),
            complete,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('查询行为分析失败', { cause });
  }
}

/** 页面访客只按页面浏览事件去重，避免同页按钮点击产生额外访问记录。 */
async function readPageRanking(tx: Prisma.TransactionClient, scope: Prisma.Sql) {
  const rows = await tx.$queryRaw<
    Array<{ page_id: string; event_name: string; page_views: bigint; visitors: bigint }>
  >(Prisma.sql`
    WITH scoped AS (${scope}) SELECT page_id,event_name,COUNT(*) AS page_views,COUNT(DISTINCT actor_key) AS visitors
    FROM scoped WHERE kind='page_view' GROUP BY page_id,event_name ORDER BY page_views DESC,event_name ASC`);
  return rows.map((row) => {
    const definition = ANALYTICS_DEFINITION_MAP.get(row.event_name)!;
    return {
      page_id: row.page_id,
      event_name: row.event_name,
      name: definition.name,
      page_views: Number(row.page_views),
      visitors: Number(row.visitors),
    };
  });
}
