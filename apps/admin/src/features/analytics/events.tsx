import { useEffect, useRef, useState } from 'react';
import './analytics.css';
import { useQuery } from '@tanstack/react-query';
import { api, request } from '../../api/client';
import { initialPaging } from '../../api/types';
import { useClampPage } from '../../api/paging';
import { Button, Empty, Loading, Pagination, RequestError } from '../../components/ui';
import { AnalyticsChart, periodLabel } from './chart';
import { DateRangeBar, presetRange, validateRange } from './date-range';
import {
  analysisQuery,
  analysisLink,
  alignSelection,
  BEHAVIORS,
  displayCount,
  eventMeasure,
  eventRows,
  MEASURES,
  PLATFORMS,
  TIME_BUCKETS,
  pageLabel,
  rowMeasure,
  sourcePageChoices,
  supportsPlatform,
  type AnalysisQuery,
  type AnalysisSelection,
  type AnalyticsRange,
  type Behavior,
  type EventCatalog,
  type Measure,
} from './model';
import { FunnelAnalysis } from './funnel';

const INITIAL_SELECTION: AnalysisSelection = {
  behavior: 'view',
  event: '',
  page: '',
  bucket: 'day',
};
type Submitted = { range: AnalyticsRange; selection: AnalysisSelection; revision: number; error?: string };

/** 概览下钻只恢复受控来源、行为和日期，事件身份在目录加载后再次校验。 */
export function selectionFromPath(path: string): Submitted {
  try {
    const params = new URL(path, 'http://localhost').searchParams;
    const platform = params.get('platform');
    const behavior = params.get('behavior');
    const bucket = params.get('bucket');
    if (platform && !Object.hasOwn(PLATFORMS, platform)) throw new Error('查询链接中的来源无效，请重新选择后查询。');
    if (behavior && !Object.hasOwn(BEHAVIORS, behavior))
      throw new Error('查询链接中的事件类型无效，请重新选择后查询。');
    if (bucket && !Object.hasOwn(TIME_BUCKETS, bucket)) throw new Error('查询链接中的时间粒度无效，请重新选择后查询。');
    const defaults = presetRange();
    const range = validateRange({
      start_date: params.get('start_date') || defaults.start_date,
      end_date: params.get('end_date') || defaults.end_date,
      platform: platform === 'app' || platform === 'web' ? platform : 'all',
    });
    return {
      range,
      selection: {
        ...INITIAL_SELECTION,
        behavior: behavior === 'click' || behavior === 'complete' ? behavior : 'view',
        event: params.get('event') ?? '',
        page: params.get('page') ?? '',
        bucket: bucket === 'hour' || bucket === 'month' ? bucket : 'day',
      },
      revision: 0,
    };
  } catch (failure) {
    return {
      range: presetRange(),
      selection: { ...INITIAL_SELECTION },
      revision: 0,
      error: failure instanceof Error ? failure.message : '查询链接不可用，请重新选择条件后查询。',
    };
  }
}

/** 事件分析按事件、聚合指标和筛选条件组织查询，趋势与明细共享同一响应。 */
export function EventAnalysis({
  active,
  path,
  navigate,
}: {
  active: boolean;
  path: string;
  navigate?: (path: string) => void;
}) {
  const [submitted, setSubmitted] = useState<Submitted>(() => selectionFromPath(path));
  const [draft, setDraft] = useState(submitted.selection);
  const [draftRange, setDraftRange] = useState(submitted.range);
  const localPath = useRef<string | null>(null);
  const [measure, setMeasure] = useState<Measure>('total');
  const [mode, setMode] = useState<'events' | 'funnel'>('events');
  const [tableMode, setTableMode] = useState<'events' | 'time'>('events');
  const [paging, setPaging] = useState(initialPaging);
  const [error, setError] = useState('');
  const [rangeKey, setRangeKey] = useState(0);
  useEffect(() => {
    if (path === localPath.current) {
      localPath.current = null;
      return;
    }
    const next = selectionFromPath(path);
    setSubmitted(next);
    setDraft(next.selection);
    setDraftRange(next.range);
    setMeasure('total');
    setMode('events');
    setTableMode('events');
    setPaging(initialPaging);
    setError('');
    setRangeKey((value) => value + 1);
  }, [path]);
  const catalog = useQuery({
    queryKey: ['admin', 'analytics-catalog'],
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminAnalytics.catalog(signal), 'read-analysis-events'),
  });
  let query: AnalysisQuery | undefined;
  let selectionError = submitted.error ?? '';
  try {
    if (catalog.data && !selectionError) query = analysisQuery(submitted.range, submitted.selection, catalog.data);
  } catch (failure) {
    selectionError = failure instanceof Error ? failure.message : '事件条件不可用。';
  }
  const report = useQuery({
    queryKey: ['admin', 'analytics-events', query, submitted.revision],
    enabled: active && !!query && mode === 'events',
    queryFn: ({ signal }) => request(() => api.adminAnalytics.details(query!, signal), 'read-event-analysis'),
  });
  const data = report;
  const rows = report.data
    ? eventRows(report.data, submitted.selection.behavior).sort(
        (left, right) =>
          (rowMeasure(right, measure) ?? -1) - (rowMeasure(left, measure) ?? -1) || left.id.localeCompare(right.id),
      )
    : [];
  useClampPage(
    report.data ? (tableMode === 'time' ? report.data.series.length : rows.length) : undefined,
    paging,
    setPaging,
  );
  /** 筛选提交后再更新查询，已展示指标始终对应提交时的事件与日期。 */
  function submit(range: AnalyticsRange): void {
    try {
      if (!catalog.data) throw new Error('埋点清单尚未加载，请稍后重试。');
      analysisQuery(range, draft, catalog.data);
      setSubmitted({ range, selection: { ...draft }, revision: submitted.revision + 1 });
      setDraftRange(range);
      setPaging(initialPaging);
      setError('');
      const nextPath = analysisLink(range, draft.behavior, draft.event, { page: draft.page, bucket: draft.bucket });
      if (navigate && nextPath !== path) {
        localPath.current = nextPath;
        navigate(nextPath);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '请检查分析条件。');
    }
  }
  /** 关联筛选从当前草稿来源推导，不发送尚未提交的查询。 */
  function changeSelection(next: AnalysisSelection, range = draftRange): void {
    setDraft(catalog.data ? alignSelection(catalog.data, next, range.platform) : next);
    setError('');
  }
  const choices =
    catalog.data?.events.filter(
      (entry) => entry.behavior === draft.behavior && supportsPlatform(entry, draftRange.platform),
    ) ?? [];
  const pages = catalog.data ? sourcePageChoices(catalog.data, draft, draftRange.platform) : [];
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(submitted.selection) ||
    JSON.stringify(draftRange) !== JSON.stringify(submitted.range);
  return (
    <div className="analytics-page">
      <div className="analytics-page-heading">
        <h1>事件分析</h1>
        <div className="analytics-segmented" role="group" aria-label="分析方式">
          <Button aria-pressed={mode === 'events'} onClick={() => setMode('events')}>
            事件趋势
          </Button>
          <Button aria-pressed={mode === 'funnel'} onClick={() => setMode('funnel')}>
            漏斗分析
          </Button>
        </div>
      </div>
      <div hidden={mode !== 'funnel'}>
        <FunnelAnalysis active={active && mode === 'funnel'} initialRange={submitted.range} />
      </div>
      <div hidden={mode !== 'events'} className="analytics-page">
        <section className="panel analytics-query-panel">
          <DateRangeBar
            key={rangeKey}
            value={submitted.range}
            busy={data.isFetching || !catalog.data}
            onSubmit={submit}
            onChange={(range) => {
              setDraftRange(range);
              changeSelection(draft, range);
            }}
          >
            <div className="analytics-event-selectors">
              <label className="field">
                事件类型
                <select
                  value={draft.behavior}
                  onChange={(event) =>
                    changeSelection({ ...draft, behavior: event.target.value as Behavior, event: '', page: '' })
                  }
                >
                  {Object.entries(BEHAVIORS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field analytics-event-picker">
                事件名称
                <select
                  value={draft.event}
                  onChange={(event) => changeSelection({ ...draft, event: event.target.value })}
                >
                  <option value="">全部{BEHAVIORS[draft.behavior]}</option>
                  {choices.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              {draft.behavior !== 'view' && (
                <label className="field">
                  发生页面
                  <select
                    value={draft.page}
                    onChange={(event) => changeSelection({ ...draft, page: event.target.value })}
                  >
                    <option value="">全部页面</option>
                    {pages.map((entry) => (
                      <option key={entry.id} value={entry.page_id ?? ''}>
                        {pageLabel(entry)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                时间粒度
                <select
                  value={draft.bucket}
                  onChange={(event) =>
                    changeSelection({ ...draft, bucket: event.target.value as AnalysisSelection['bucket'] })
                  }
                >
                  {Object.entries(TIME_BUCKETS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </DateRangeBar>
          {dirty && (
            <p role="status" className="analytics-draft-note">
              查询条件已修改，点击查询更新结果。
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </section>
        {mode === 'events' && catalog.isError ? (
          <RequestError error={catalog.error} retry={() => void catalog.refetch()} />
        ) : selectionError && mode === 'events' ? (
          <div role="alert" className="request-error">
            {selectionError}
          </div>
        ) : data.isPending ? (
          <Loading label="正在查询分析数据…" />
        ) : data.isError ? (
          <RequestError error={data.error} retry={() => void data.refetch()} />
        ) : (
          data.data && (
            <>
              <div className="analytics-result-caption">
                <span>
                  {submitted.range.start_date} — {submitted.range.end_date} · {PLATFORMS[submitted.range.platform]} ·{' '}
                  {TIME_BUCKETS[data.data.range.bucket]}
                </span>
                <span>{selectedEventName(catalog.data, submitted.selection)}</span>
              </div>
              <>
                <div className="analytics-analysis-metrics" role="group" aria-label="分析指标">
                  {Object.entries(MEASURES).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={measure === key}
                      className="analytics-analysis-metric"
                      onClick={() => {
                        setMeasure(key as Measure);
                        setPaging(initialPaging);
                      }}
                    >
                      <span>{label}</span>
                      <strong>
                        {displayCount(eventMeasure(data.data, submitted.selection.behavior, key as Measure))}
                      </strong>
                    </button>
                  ))}
                </div>
                <section className="panel analytics-chart-panel">
                  <div className="analytics-section-heading">
                    <h2>{MEASURES[measure]}趋势</h2>
                    <span className="muted">
                      {measure === 'users'
                        ? '按每个时间段去重'
                        : measure === 'average'
                          ? '次数 ÷ 触发用户数'
                          : BEHAVIORS[submitted.selection.behavior]}
                    </span>
                  </div>
                  <AnalyticsChart
                    label={MEASURES[measure]}
                    fractional={measure === 'average'}
                    rows={data.data.series.map((row) => ({
                      label: periodLabel(row.period_start, data.data!.range.bucket, true),
                      shortLabel: periodLabel(row.period_start, data.data!.range.bucket, false, data.data!.range),
                      value: eventMeasure(data.data!, submitted.selection.behavior, measure, row, row.period_start),
                    }))}
                  />
                </section>
                <section className="panel analytics-results">
                  <div className="analytics-section-heading">
                    <h2>数据明细</h2>
                    <div className="analytics-segmented" role="group" aria-label="明细维度">
                      <Button
                        aria-pressed={tableMode === 'events'}
                        onClick={() => {
                          setTableMode('events');
                          setPaging(initialPaging);
                        }}
                      >
                        按事件
                      </Button>
                      <Button
                        aria-pressed={tableMode === 'time'}
                        onClick={() => {
                          setTableMode('time');
                          setPaging(initialPaging);
                        }}
                      >
                        按时间
                      </Button>
                    </div>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{tableMode === 'events' ? '事件名称' : '时间'}</th>
                          <th>总次数</th>
                          <th>触发用户数</th>
                          <th>人均次数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tableMode === 'events'
                          ? rows
                              .slice((paging.page - 1) * paging.page_size, paging.page * paging.page_size)
                              .map((row) => (
                                <tr key={row.id}>
                                  <td data-label="事件名称">
                                    <span>{row.name}</span>
                                    <code className="analytics-secondary-code">{row.code}</code>
                                  </td>
                                  <td data-label="总次数">{displayCount(row.total)}</td>
                                  <td data-label="触发用户数">{displayCount(row.users)}</td>
                                  <td data-label="人均次数">{displayCount(rowMeasure(row, 'average'))}</td>
                                </tr>
                              ))
                          : data.data.series
                              .slice((paging.page - 1) * paging.page_size, paging.page * paging.page_size)
                              .map((row) => (
                                <tr key={row.period_start}>
                                  <td data-label="时间">
                                    {periodLabel(row.period_start, data.data!.range.bucket, true)}
                                  </td>
                                  {(['total', 'users', 'average'] as const).map((key) => (
                                    <td key={key} data-label={MEASURES[key]}>
                                      {displayCount(
                                        eventMeasure(
                                          data.data!,
                                          submitted.selection.behavior,
                                          key,
                                          row,
                                          row.period_start,
                                        ),
                                      )}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                      </tbody>
                    </table>
                  </div>
                  {tableMode === 'events' && !rows.length && <Empty>所选范围没有匹配的事件</Empty>}
                  <Pagination
                    value={paging}
                    total={tableMode === 'events' ? rows.length : data.data.series.length}
                    onChange={setPaging}
                  />
                  <p className="analytics-table-note">触发用户数按登录账号独立去重，不等于各行人数相加。</p>
                </section>
              </>
            </>
          )
        )}
      </div>
    </div>
  );
}

/** 结果标题使用已提交的事件身份，未提交的下拉选择不会改变已显示结果。 */
function selectedEventName(catalog: EventCatalog | undefined, selection: AnalysisSelection): string {
  const name = selection.event
    ? (catalog?.events.find((entry) => entry.id === selection.event)?.name ?? '所选事件')
    : `全部${BEHAVIORS[selection.behavior]}`;
  const page =
    selection.page && selection.behavior !== 'view'
      ? catalog?.events.find((entry) => entry.kind === 'page_view' && entry.page_id === selection.page)
      : undefined;
  return page ? `${name} · ${pageLabel(page)}` : name;
}
