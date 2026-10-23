import { useState } from 'react';
import './analytics.css';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Eye, MousePointer2, UserPlus, Users } from 'lucide-react';
import { api, request } from '../../api/client';
import { Button, Empty, Loading, RequestError } from '../../components/ui';
import { AnalyticsChart, periodLabel, type AnalyticsPoint } from './chart';
import { DateRangeBar, presetRange } from './date-range';
import {
  analysisLink,
  displayCount,
  eventMeasure,
  measured,
  PLATFORMS,
  TIME_BUCKETS,
  type AnalyticsRange,
  type AnalyticsReport,
  type OverviewReport,
} from './model';

type Metric = 'active_users' | 'new_users' | 'page_views' | 'clicks';
const METRICS = [
  { id: 'active_users', label: '活跃用户', unit: '人', icon: Users },
  { id: 'new_users', label: '新增用户', unit: '人', icon: UserPlus },
  { id: 'page_views', label: '页面访问', unit: '次', icon: Eye },
  { id: 'clicks', label: '关键点击', unit: '次', icon: MousePointer2 },
] as const;

/** 概览指标共用采集起点，真实零值与尚未开始采集的范围保持区分。 */
function overviewValue(report: OverviewReport, details: AnalyticsReport, metric: Metric): number | null {
  if (metric === 'clicks') return eventMeasure(details, 'click', 'total');
  return measured(report.summary[metric], report.coverage.complete, report.coverage.collection_started_at);
}

/** 每个指标只读取所属响应的时间桶，跨整点到达的独立请求不能按数组位置拼接。 */
export function overviewPoints(report: OverviewReport, details: AnalyticsReport, metric: Metric): AnalyticsPoint[] {
  const source = metric === 'clicks' ? details : report;
  const rows =
    metric === 'clicks'
      ? details.series.map((row) => ({
          period: row.period_start,
          value: eventMeasure(details, 'click', 'total', row, row.period_start),
        }))
      : report.series.map((row) => ({
          period: row.period_start,
          value: measured(
            row[metric],
            report.coverage.complete,
            report.coverage.collection_started_at,
            row.period_start,
          ),
        }));
  return rows.map((row) => ({
    label: periodLabel(row.period, source.range.bucket, true),
    shortLabel: periodLabel(row.period, source.range.bucket, false, source.range),
    value: row.value,
  }));
}

/** 数据概览突出少量核心指标及排名摘要，下钻携带同一时间和来源到事件分析。 */
export function AnalyticsOverview({ active, navigate }: { active: boolean; navigate: (path: string) => void }) {
  const [range, setRange] = useState<AnalyticsRange>(() => presetRange());
  const [revision, setRevision] = useState(0);
  const [metric, setMetric] = useState<Metric>('active_users');
  const query = useQuery({
    queryKey: ['admin', 'analytics-overview', range, revision],
    enabled: active,
    queryFn: ({ signal }) =>
      request(async () => {
        const filters = { ...range, bucket: 'auto' as const };
        const [report, details] = await Promise.all([
          api.adminAnalytics.report(filters, signal),
          api.adminAnalytics.details(filters, signal),
        ]);
        return { report, details };
      }, 'read-analytics-overview'),
  });
  const selected = METRICS.find((item) => item.id === metric)!;
  return (
    <div className="analytics-page">
      <div className="analytics-page-heading">
        <h1>数据概览</h1>
        <Button onClick={() => navigate(analysisLink(range, 'view'))}>
          进入事件分析
          <ArrowRight size={15} />
        </Button>
      </div>
      <section className="panel analytics-filter-panel">
        <DateRangeBar
          value={range}
          busy={query.isFetching}
          onSubmit={(next) => {
            setRange(next);
            setRevision((value) => value + 1);
          }}
        />
      </section>
      {query.isPending ? (
        <Loading label="正在读取数据概览…" />
      ) : query.isError ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <div className="analytics-result-caption">
            <span>
              {range.start_date} — {range.end_date} · {PLATFORMS[range.platform]}
            </span>
            <span>仅统计登录账号，活跃人数按区间去重</span>
          </div>
          <div className="analytics-overview-metrics">
            {METRICS.map((item) => {
              const value = overviewValue(query.data.report, query.data.details, item.id);
              return (
                <button
                  type="button"
                  key={item.id}
                  className="panel analytics-kpi"
                  aria-pressed={metric === item.id}
                  onClick={() => setMetric(item.id)}
                >
                  <span className="analytics-kpi-label">
                    <item.icon size={17} />
                    {item.label}
                  </span>
                  <span className="analytics-kpi-value">
                    {displayCount(value)}
                    {value !== null && <small>{item.unit}</small>}
                  </span>
                </button>
              );
            })}
          </div>
          <section className="panel analytics-chart-panel">
            <div className="analytics-section-heading">
              <h2>{selected.label}趋势</h2>
              <span className="muted">
                {TIME_BUCKETS[(metric === 'clicks' ? query.data.details : query.data.report).range.bucket]}
              </span>
            </div>
            <AnalyticsChart
              label={selected.label}
              rows={overviewPoints(query.data.report, query.data.details, metric)}
            />
          </section>
          <div className="analytics-overview-rankings">
            <section className="panel">
              <div className="analytics-section-heading">
                <h2>热门页面</h2>
                <Button variant="ghost" onClick={() => navigate(analysisLink(range, 'view'))}>
                  查看全部
                  <ArrowRight size={14} />
                </Button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>页面</th>
                      <th>访问次数</th>
                      <th>访问人数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.details.pages.slice(0, 5).map((row) => (
                      <tr key={row.page_id}>
                        <td data-label="页面">
                          <button
                            className="analytics-row-link"
                            onClick={() => navigate(analysisLink(range, 'view', row.event_name))}
                          >
                            {row.name}
                          </button>
                        </td>
                        <td data-label="访问次数">{displayCount(row.page_views)}</td>
                        <td data-label="访问人数">{displayCount(row.visitors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!query.data.details.pages.length && <Empty>所选范围暂无页面访问</Empty>}
            </section>
            <section className="panel">
              <div className="analytics-section-heading">
                <h2>热门点击</h2>
                <Button variant="ghost" onClick={() => navigate(analysisLink(range, 'click'))}>
                  查看全部
                  <ArrowRight size={14} />
                </Button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>事件名称</th>
                      <th>点击次数</th>
                      <th>点击人数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.details.events
                      .filter((row) => row.behavior === 'click')
                      .slice(0, 5)
                      .map((row) => (
                        <tr key={row.event_name}>
                          <td data-label="事件名称">
                            <button
                              className="analytics-row-link"
                              onClick={() => navigate(analysisLink(range, 'click', row.event_name))}
                            >
                              {row.name}
                            </button>
                          </td>
                          <td data-label="点击次数">{displayCount(row.total)}</td>
                          <td data-label="点击人数">{displayCount(row.users)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {!query.data.details.events.some((row) => row.behavior === 'click') && (
                <Empty>所选范围暂无关键点击</Empty>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
