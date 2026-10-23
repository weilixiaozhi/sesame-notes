import type { api } from '../../api/client';

export type OverviewReport = Awaited<ReturnType<typeof api.adminAnalytics.report>>;
export type AnalyticsReport = Awaited<ReturnType<typeof api.adminAnalytics.details>>;
export type EventCatalog = Awaited<ReturnType<typeof api.adminAnalytics.catalog>>;
type TimeBucket = AnalyticsReport['range']['bucket'];
export type AnalysisQuery = Parameters<typeof api.adminAnalytics.details>[0];
export type Platform = 'all' | 'app' | 'web';
export type Behavior = 'view' | 'click' | 'complete';
export type Measure = 'total' | 'users' | 'average';
export type AnalysisSelection = {
  behavior: Behavior;
  event: string;
  page: string;
  bucket: TimeBucket;
};
export type AnalyticsRange = { start_date: string; end_date: string; platform: Platform };
type EventRow = { id: string; name: string; code: string; total: number; users: number };
export const BEHAVIORS: Record<Behavior, string> = { view: '页面访问', click: '关键点击', complete: '操作完成' };
export const TIME_BUCKETS: Record<TimeBucket, string> = { hour: '按小时', day: '按天', month: '按月' };
export const MEASURES: Record<Measure, string> = { total: '总次数', users: '触发用户数', average: '人均次数' };
export const PLATFORMS: Record<Platform, string> = { all: '全部来源', app: 'App', web: 'Web' };
const count = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

/** 采集端是事件候选的前置条件，避免选择客户端不存在的页面或操作。 */
export function supportsPlatform(definition: EventCatalog['events'][number], platform: Platform): boolean {
  return platform === 'all' || definition.platforms.includes(platform);
}

/** 页面候选来自事件真实触发来源，与服务端采集校验使用同一目录声明。 */
export function sourcePageChoices(catalog: EventCatalog, selection: AnalysisSelection, platform: Platform) {
  const ids = new Set(
    catalog.events
      .filter(
        (entry) =>
          entry.kind === 'action' &&
          entry.behavior === selection.behavior &&
          (!selection.event || entry.id === selection.event) &&
          supportsPlatform(entry, platform),
      )
      .flatMap((entry) =>
        entry.source_pages
          .filter((source) => platform === 'all' || source.platforms.includes(platform))
          .map((source) => source.page_id),
      ),
  );
  return catalog.events.filter((entry) => entry.kind === 'page_view' && ids.has(entry.page_id!));
}

/** 修改来源或事件后清理不可能的筛选组合，选择框与实际提交值始终一致。 */
export function alignSelection(
  catalog: EventCatalog,
  selection: AnalysisSelection,
  platform: Platform,
): AnalysisSelection {
  const next = { ...selection };
  if (
    next.event &&
    !catalog.events.some(
      (entry) => entry.id === next.event && entry.behavior === next.behavior && supportsPlatform(entry, platform),
    )
  )
    next.event = '';
  if (
    next.behavior === 'view' ||
    !sourcePageChoices(catalog, next, platform).some((entry) => entry.page_id === next.page)
  )
    next.page = '';
  return next;
}

/** 页面筛选沿用事件目录的正式名称，仅省略访问行为后缀，不使用触发位置描述作为名称。 */
export function pageLabel(definition: EventCatalog['events'][number]): string {
  return definition.name.replace(/_访问$/, '');
}

/** 按服务端采集覆盖区分缺失与真实零，时间桶边界由同一服务端查询确定。 */
export function measured(value: number, complete: boolean, startedAt: string, periodStart?: string): number | null {
  return value || complete || (periodStart && Date.parse(periodStart) >= Date.parse(startedAt)) ? value : null;
}

/** 事件分析只采用当前行为的次数和独立账号数，避免把不同口径的人数混加。 */
export function eventMeasure(
  report: AnalyticsReport,
  behavior: Behavior,
  measure: Measure,
  row = report.summary,
  periodStart?: string,
): number | null {
  const total = behavior === 'view' ? row.page_views : behavior === 'click' ? row.clicks : row.completions;
  const users = behavior === 'view' ? row.visitors : behavior === 'click' ? row.click_users : row.completion_users;
  const value = measured(
    measure === 'users' ? users : total,
    report.coverage.complete,
    report.coverage.collection_started_at,
    periodStart,
  );
  if (measure !== 'average' || value === null) return value;
  return users ? total / users : null;
}

/** 去重人数为零时人均次数没有分母，不用零掩盖缺失的使用人群。 */
export function rowMeasure(row: EventRow, measure: Measure): number | null {
  return measure === 'total' ? row.total : measure === 'users' ? row.users : row.users ? row.total / row.users : null;
}

/** 把页面和动作统一为可排序的分析行，事件身份保持服务端固定标识。 */
export function eventRows(report: AnalyticsReport, behavior: Behavior): EventRow[] {
  return behavior === 'view'
    ? report.pages.map((row) => ({
        id: row.event_name,
        code: row.event_name,
        name: row.name,
        total: row.page_views,
        users: row.visitors,
      }))
    : report.events
        .filter((row) => row.behavior === behavior)
        .map((row) => ({
          id: row.event_name,
          code: row.event_name,
          name: row.name,
          total: row.total,
          users: row.users,
        }));
}

/** 只把已登记事件的身份转换成查询条件，拒绝地址或表单中的未知事件。 */
export function analysisQuery(
  range: AnalyticsRange,
  selection: AnalysisSelection,
  catalog: EventCatalog,
): AnalysisQuery {
  try {
    const definition = selection.event
      ? catalog.events.find((entry) => entry.id === selection.event && entry.behavior === selection.behavior)
      : undefined;
    if (selection.event && !definition) throw new Error('所选事件已不可用，请重新选择。');
    if (definition && !supportsPlatform(definition, range.platform))
      throw new Error('所选事件不在该来源采集，请重新选择。');
    if (!Object.hasOwn(TIME_BUCKETS, selection.bucket)) throw new Error('请选择按小时、按天或按月。');
    const days = (Date.parse(range.end_date) - Date.parse(range.start_date)) / 86_400_000 + 1;
    if (selection.bucket === 'hour' && days > 31) throw new Error('按小时最多查询 31 天，请缩短日期范围或改为按天。');
    const page = selection.behavior === 'view' ? undefined : selection.page || undefined;
    if (page && !catalog.events.some((entry) => entry.kind === 'page_view' && entry.page_id === page))
      throw new Error('所选页面已不可用，请重新选择。');
    if (page && !sourcePageChoices(catalog, selection, range.platform).some((entry) => entry.page_id === page))
      throw new Error('所选事件不会在该页面触发，请重新选择发生页面。');
    return {
      ...range,
      bucket: selection.bucket,
      behavior: selection.behavior,
      page_id: page as AnalysisQuery['page_id'],
      event_name: definition?.event_name as AnalysisQuery['event_name'],
    };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('分析条件无效，请重新选择。', { cause: error });
  }
}

/** 看板下钻保留当前日期和来源，事件身份通过查询参数传递给独立分析页面。 */
export function analysisLink(
  range: AnalyticsRange,
  behavior: Behavior,
  event = '',
  options: { page?: string; bucket?: TimeBucket } = {},
): string {
  const query = new URLSearchParams({
    ...range,
    behavior,
    ...(event ? { event } : {}),
    ...(options.page ? { page: options.page } : {}),
    ...(options.bucket ? { bucket: options.bucket } : {}),
  });
  return `/analytics/events?${query}`;
}

/** 所有指标统一使用缺失符号，避免出现 undefined、NaN 或误导的零。 */
export function displayCount(value: number | null): string {
  return value === null ? '—' : count.format(value);
}
