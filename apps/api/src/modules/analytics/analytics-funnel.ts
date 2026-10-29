import { Prisma, type PrismaClient } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { ANALYTICS_DEFINITION_MAP } from './analytics-catalog.js';
import type { AnalyticsFunnelQuery } from './analytics-contract.js';
import { analyticsRange } from './analytics-service.js';

/** 每次首步事件独立尝试，在受限窗口内按用户或同一关联上下文推进，最终按账号去重。 */
export async function readAnalyticsFunnel(prisma: PrismaClient, query: AnalyticsFunnelQuery) {
  try {
    const { start, end } = analyticsRange(query);
    if (
      query.steps.length < 2 ||
      query.steps.length > 8 ||
      !Number.isInteger(query.window_minutes) ||
      query.window_minutes < 1 ||
      query.window_minutes > 10_080 ||
      !['user', 'session', 'flow'].includes(query.scope)
    ) {
      throw new ApiError(400, 'ANALYTICS_FUNNEL_INVALID', '请选择 2–8 个步骤和 1 分钟至 7 天的转化窗口');
    }
    const definitions = query.steps.map((id) => {
      const definition = ANALYTICS_DEFINITION_MAP.get(id);
      if (!definition) throw new ApiError(400, 'ANALYTICS_FUNNEL_STEP_INVALID', '请选择已定义的页面或操作事件');
      if (query.platform && query.platform !== 'all' && !definition.platforms.includes(query.platform)) {
        throw new ApiError(
          400,
          'ANALYTICS_FUNNEL_STEP_PLATFORM_INVALID',
          '所选漏斗步骤未在该采集端接入，请调整步骤或采集端',
        );
      }
      return definition;
    });
    return await prisma.$transaction(
      async (tx) => {
        const state = await tx.productAnalyticsState.findUnique({ where: { id: 1 } });
        if (!state) throw new ApiError(503, 'ANALYTICS_NOT_READY', '数据采集尚未初始化，请稍后再试');
        const contextColumn =
          query.scope === 'session'
            ? Prisma.sql`session_id`
            : query.scope === 'flow'
              ? Prisma.sql`flow_id`
              : Prisma.sql`NULL::uuid`;
        const platformFilter =
          !query.platform || query.platform === 'all' ? Prisma.empty : Prisma.sql`AND platform=${query.platform}`;
        const acceptedSteps = Prisma.join([...new Set(query.steps)].map((id) => Prisma.sql`${id}`));
        const requiredContext = query.scope === 'user' ? Prisma.empty : Prisma.sql`WHERE context_id IS NOT NULL`;
        const successors = query.steps.slice(1).flatMap((id, index) => [
          Prisma.sql`MIN(occurred_at) FILTER (WHERE definition_id=${id}) OVER ordered_times AS ${Prisma.raw(`next_time_${index + 1}`)}`,
          Prisma.sql`CASE WHEN session_id IS NOT NULL AND event_sequence IS NOT NULL
            THEN MIN(event_sequence) FILTER (WHERE definition_id=${id}) OVER ordered_sequences
            ELSE NULL END AS ${Prisma.raw(`next_sequence_${index + 1}`)}`,
        ]);
        const lookupColumns = query.steps
          .slice(1)
          .flatMap((_, index) => [
            Prisma.sql`MAX(${Prisma.raw(`next_time_${index + 1}`)}) AS ${Prisma.raw(`next_time_${index + 1}`)}`,
            Prisma.sql`MAX(${Prisma.raw(`next_sequence_${index + 1}`)}) AS ${Prisma.raw(`next_sequence_${index + 1}`)}`,
          ]);
        const steps = [
          Prisma.sql`step_0 AS (
            SELECT actor_key,event_id AS attempt_id,occurred_at AS first_at,occurred_at AS reached_at,
              context_id,session_id,event_sequence FROM scoped WHERE definition_id=${query.steps[0]})`,
        ];
        for (let index = 1; index < query.steps.length; index++) {
          const previous = Prisma.raw(`step_${index - 1}`);
          const current = Prisma.raw(`step_${index}`);
          const candidates = Prisma.raw(`candidates_${index}`);
          const earliest = Prisma.raw(`earliest_${index}`);
          const nextTime = Prisma.raw(`next_time_${index}`);
          const nextSequence = Prisma.raw(`next_sequence_${index}`);
          // 同毫秒只允许同一会话内按采集顺序推进，跨会话不能以任意 UUID 排序制造先后。
          steps.push(Prisma.sql`${candidates} AS (
            SELECT previous.actor_key,previous.attempt_id,previous.first_at,previous.context_id,
              target.occurred_at AS reached_at,target.session_id,target.event_sequence
            FROM ${previous} previous JOIN lookups successor
              ON successor.actor_key=previous.actor_key
              AND successor.context_id IS NOT DISTINCT FROM previous.context_id
              AND successor.occurred_at=previous.reached_at
              AND successor.session_id IS NOT DISTINCT FROM previous.session_id
              AND successor.event_sequence IS NOT DISTINCT FROM previous.event_sequence
            JOIN targets target ON target.actor_key=previous.actor_key
              AND target.context_id IS NOT DISTINCT FROM previous.context_id
              AND target.definition_id=${query.steps[index]}
              AND target.occurred_at=CASE WHEN successor.${nextSequence} IS NOT NULL
                THEN previous.reached_at ELSE successor.${nextTime} END
              AND ((successor.${nextSequence} IS NOT NULL
                AND target.session_id=previous.session_id AND target.event_sequence=successor.${nextSequence})
                OR (successor.${nextSequence} IS NULL
                  AND target.event_sequence IS NOT DISTINCT FROM target.first_sequence))
            WHERE target.occurred_at <= previous.first_at + (${query.window_minutes}::int * INTERVAL '1 minute'))`);
          // 更早的到达时间覆盖全部更晚候选；同毫秒不同会话互不可比，必须保留每个会话的最早序号。
          steps.push(Prisma.sql`${earliest} AS (
            SELECT *,MIN(reached_at) OVER (PARTITION BY actor_key,attempt_id) AS earliest_at FROM ${candidates})`);
          steps.push(Prisma.sql`${current} AS (
            SELECT actor_key,attempt_id,first_at,context_id,reached_at,session_id,MIN(event_sequence) AS event_sequence
            FROM ${earliest} WHERE reached_at=earliest_at
            GROUP BY actor_key,attempt_id,first_at,context_id,reached_at,session_id)`);
        }
        const missingCount =
          query.scope === 'user'
            ? Prisma.sql`COUNT(*) FILTER (WHERE FALSE)`
            : Prisma.sql`COUNT(*) FILTER (WHERE context_id IS NULL)`;
        // 后继时间和同会话序号各自预计算，避免每个尝试扫描整个时间窗口；阶段内只保留不被更早候选覆盖的状态。
        const rows = await tx.$queryRaw<Array<{ step: number; users: bigint }>>(Prisma.sql`
          WITH relevant AS (
            SELECT actor_key,event_id,occurred_at,session_id,event_sequence,
              ${contextColumn} AS context_id,event_name AS definition_id
            FROM product_analytics_events WHERE kind IN ('page_view','action') AND occurred_at >= ${start} AND occurred_at < ${end}
              ${platformFilter} AND event_name IN (${acceptedSteps})
          ),scoped AS (SELECT * FROM relevant ${requiredContext}),nodes AS (
            SELECT DISTINCT actor_key,context_id,occurred_at,session_id,event_sequence,definition_id FROM scoped
          ),targets AS (
            SELECT *,MIN(event_sequence) OVER (
              PARTITION BY actor_key,context_id,occurred_at,session_id,definition_id) AS first_sequence FROM nodes
          ),timeline AS (
            SELECT actor_key,context_id,occurred_at,session_id,event_sequence,${Prisma.join(successors)} FROM nodes
            WINDOW ordered_times AS (
              PARTITION BY actor_key,context_id ORDER BY occurred_at DESC GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
            ordered_sequences AS (
              PARTITION BY actor_key,context_id,occurred_at,session_id ORDER BY event_sequence DESC
              GROUPS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
          ),lookups AS (
            SELECT actor_key,context_id,occurred_at,session_id,event_sequence,${Prisma.join(lookupColumns)} FROM timeline
            GROUP BY actor_key,context_id,occurred_at,session_id,event_sequence
          ),${Prisma.join(steps)}
          SELECT -1::int AS step,${missingCount} AS users FROM relevant
          UNION ALL ${Prisma.join(
            query.steps.map(
              (_, index) =>
                Prisma.sql`SELECT ${index}::int AS step,COUNT(DISTINCT actor_key) AS users FROM ${Prisma.raw(`step_${index}`)}`,
            ),
            ' UNION ALL ',
          )} ORDER BY step`);
        const counts = new Map(rows.map((row) => [row.step, Number(row.users)]));
        const missingContextEvents = counts.get(-1) ?? 0;
        const collectionStartedAt = query.steps.some((id) => id === 'banner_impression' || id === 'banner_click')
          ? state.bannerStartedAt
          : state.startedAt;
        const complete = start.getTime() >= collectionStartedAt.getTime() && missingContextEvents === 0;
        const firstUsers = counts.get(0) ?? 0;
        return {
          range: {
            start_date: query.start_date,
            end_date: query.end_date,
            timezone: 'Asia/Shanghai' as const,
            platform: query.platform ?? 'all',
          },
          scope: query.scope,
          window_minutes: query.window_minutes,
          steps: definitions.map((definition, index) => {
            const users = counts.get(index) ?? 0;
            const previousUsers = index ? (counts.get(index - 1) ?? 0) : firstUsers;
            return {
              id: definition.id,
              name: definition.name,
              users,
              conversion_rate: complete && previousUsers ? users / previousUsers : null,
              drop_off: index ? Math.max(0, previousUsers - users) : 0,
            };
          }),
          completion_rate: complete && firstUsers ? (counts.get(query.steps.length - 1) ?? 0) / firstUsers : null,
          coverage: {
            collection_started_at: collectionStartedAt.toISOString(),
            complete,
            missing_context_events: missingContextEvents,
          },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('查询漏斗转化失败', { cause });
  }
}
