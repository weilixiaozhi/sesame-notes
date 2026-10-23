import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { api, request } from '../../api/client';
import { Button, Loading, RequestError } from '../../components/ui';
import { DateRangeBar } from './date-range';
import {
  displayCount,
  measured,
  PLATFORMS,
  supportsPlatform,
  type AnalyticsRange,
  type EventCatalog,
  type Platform,
} from './model';

type Scope = 'user' | 'session' | 'flow';
type FunnelDraft = { steps: string[]; scope: Scope; window_minutes: number };
const SCOPES: Record<Scope, string> = { user: '同一用户', session: '同一会话', flow: '同一次操作' };
const PRESETS = {
  accounting: {
    name: '记一笔',
    steps: [
      'accounting_transaction_create_click',
      'accounting_transaction_editor_view',
      'accounting_transaction_created',
    ],
  },
  credentials: { name: '新建账号密码', steps: ['credentials_create_click', 'credentials_created'] },
  memos: { name: '新建备忘录', steps: ['memos_note_create_click', 'memos_note_created'] },
  fitness: {
    name: '开始并完成训练',
    steps: ['fitness_workout_start_click', 'fitness_workout_started', 'fitness_workout_completed'],
  },
};
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });

/** 仅允许固定目录事件与有界窗口，重复步骤由时间顺序区分，不按名字去重丢失回访。 */
export function validateFunnel(draft: FunnelDraft, catalog: EventCatalog, platform: Platform = 'all'): FunnelDraft {
  try {
    if (draft.steps.length < 2 || draft.steps.length > 8) throw new Error('请选择 2 至 8 个漏斗步骤。');
    if (draft.steps.some((step) => !catalog.events.some((entry) => entry.id === step)))
      throw new Error('请为每个步骤选择有效事件。');
    if (
      draft.steps.some(
        (step) =>
          !supportsPlatform(
            catalog.events.find((entry) => entry.id === step)!,
            platform,
          ),
      )
    )
      throw new Error('部分步骤未在所选来源采集，请调整步骤或来源。');
    if (!Number.isInteger(draft.window_minutes) || draft.window_minutes < 1 || draft.window_minutes > 10080)
      throw new Error('转化窗口应为 1 至 10080 分钟。');
    if (!Object.hasOwn(SCOPES, draft.scope)) throw new Error('请选择有效的关联口径。');
    return { ...draft, steps: [...draft.steps] };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('漏斗条件无效。', { cause: error });
  }
}

/** 可配置封闭漏斗独立提交步骤、窗口和关联口径，不把全日期内任意先后行为拼成流程。 */
export function FunnelAnalysis({ active, initialRange }: { active: boolean; initialRange: AnalyticsRange }) {
  const [draft, setDraft] = useState<FunnelDraft>({
    steps: [...PRESETS.accounting.steps],
    scope: 'user',
    window_minutes: 30,
  });
  const [example, setExample] = useState('accounting');
  const [error, setError] = useState('');
  const [draftRange, setDraftRange] = useState(initialRange);
  const [submitted, setSubmitted] = useState({ ...initialRange, ...draft });
  const [revision, setRevision] = useState(0);
  const rangeKey = `${initialRange.start_date}:${initialRange.end_date}:${initialRange.platform}`;
  useEffect(() => {
    setDraftRange({
      start_date: initialRange.start_date,
      end_date: initialRange.end_date,
      platform: initialRange.platform,
    });
    setSubmitted((value) => ({
      ...value,
      start_date: initialRange.start_date,
      end_date: initialRange.end_date,
      platform: initialRange.platform,
    }));
  }, [initialRange.start_date, initialRange.end_date, initialRange.platform]);
  const catalog = useQuery({
    queryKey: ['admin', 'analytics-catalog'],
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminAnalytics.catalog(signal), 'read-funnel-events'),
  });
  const report = useQuery({
    queryKey: ['admin', 'analytics-funnel', submitted, revision],
    enabled: active && !!catalog.data,
    queryFn: ({ signal }) => request(() => api.adminAnalytics.funnel(submitted, signal), 'read-configurable-funnel'),
  });
  /** 添加、替换和重排步骤只修改草稿，旧结果仍显示原来的已提交条件。 */
  function replaceSteps(steps: string[]): void {
    setDraft({ ...draft, steps });
    setExample('custom');
  }
  /** 单个移动按数组位置交换，保证重复事件仍能作为独立有序步骤。 */
  function move(index: number, offset: number): void {
    const steps = [...draft.steps];
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    replaceSteps(steps);
  }
  /** 日期和漏斗配置一次提交，拒绝目录未就绪时发出不受控事件条件。 */
  function submit(range: AnalyticsRange): void {
    try {
      if (!catalog.data) throw new Error('埋点清单尚未加载，请稍后重试。');
      setSubmitted({ ...range, ...validateFunnel(draft, catalog.data, range.platform) });
      setDraftRange(range);
      setRevision((value) => value + 1);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '请检查漏斗配置。');
    }
  }
  const choices = catalog.data?.events.filter((entry) => supportsPlatform(entry, draftRange.platform)) ?? [];
  const dirty =
    draft.scope !== submitted.scope ||
    draft.window_minutes !== submitted.window_minutes ||
    draft.steps.join('|') !== submitted.steps.join('|') ||
    draftRange.start_date !== submitted.start_date ||
    draftRange.end_date !== submitted.end_date ||
    draftRange.platform !== submitted.platform;
  return (
    <div className="analytics-page">
      <section className="panel analytics-query-panel">
        <DateRangeBar
          key={rangeKey}
          value={initialRange}
          onChange={setDraftRange}
          onSubmit={submit}
          busy={report.isFetching || !catalog.data}
        >
          <div className="analytics-event-selectors">
            <label className="field">
              流程示例
              <select
                value={example}
                onChange={(event) => {
                  const key = event.target.value;
                  setExample(key);
                  if (key !== 'custom') setDraft({ ...draft, steps: [...PRESETS[key as keyof typeof PRESETS].steps] });
                }}
              >
                <option value="custom">自定义步骤</option>
                {Object.entries(PRESETS).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              关联口径
              <select
                value={draft.scope}
                onChange={(event) => setDraft({ ...draft, scope: event.target.value as Scope })}
              >
                {Object.entries(SCOPES).map(([key, value]) => (
                  <option key={key} value={key}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              转化窗口（分钟）
              <input
                type="number"
                min={1}
                max={10080}
                required
                value={draft.window_minutes || ''}
                onChange={(event) => setDraft({ ...draft, window_minutes: Number(event.target.value) })}
              />
            </label>
          </div>
          <ol className="analytics-funnel-builder">
            {draft.steps.map((step, index) => (
              <li key={index}>
                <label className="field">
                  步骤 {index + 1}
                  <select
                    value={step}
                    onChange={(event) =>
                      replaceSteps(draft.steps.map((value, at) => (at === index ? event.target.value : value)))
                    }
                  >
                    <option value="">选择事件</option>
                    {!!step && !choices.some((entry) => entry.id === step) && (
                      <option value={step} disabled>
                        {catalog.data?.events.find((entry) => entry.id === step)?.name ?? '所选事件'}（该来源未采集）
                      </option>
                    )}
                    {choices.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="row-actions">
                  <Button disabled={index === 0} aria-label={`上移步骤 ${index + 1}`} onClick={() => move(index, -1)}>
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    disabled={index === draft.steps.length - 1}
                    aria-label={`下移步骤 ${index + 1}`}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={14} />
                  </Button>
                  <Button
                    disabled={draft.steps.length <= 2}
                    aria-label={`删除步骤 ${index + 1}`}
                    onClick={() => replaceSteps(draft.steps.filter((_, at) => at !== index))}
                  >
                    <X size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <Button
            disabled={draft.steps.length >= 8 || !catalog.data}
            onClick={() => replaceSteps([...draft.steps, ''])}
          >
            <Plus size={14} />
            添加步骤
          </Button>
          <p className="analytics-funnel-hint">
            从首步开始计时，须在窗口内按顺序到达后续步骤。同一次操作仅关联带流程标识的入口及后续事件，不会把此前的首页访问补入流程。
          </p>
        </DateRangeBar>
        {dirty && (
          <p role="status" className="analytics-draft-note">
            查询条件已修改，点击查询更新结果。
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </section>
      {catalog.isError ? (
        <RequestError error={catalog.error} retry={() => void catalog.refetch()} />
      ) : report.isPending ? (
        <Loading label="正在计算漏斗…" />
      ) : report.isError ? (
        <RequestError error={report.error} retry={() => void report.refetch()} />
      ) : (
        <>
          <div className="analytics-result-caption">
            <span>
              {report.data.range.start_date} — {report.data.range.end_date} · {PLATFORMS[report.data.range.platform]}
            </span>
            <span>
              {SCOPES[report.data.scope]} · 首步后 {report.data.window_minutes} 分钟
            </span>
          </div>
          <section className="panel analytics-path-panel">
            <div className="analytics-section-heading">
              <h2>漏斗转化</h2>
              <div className="analytics-path-rate">
                <span>整体转化率</span>
                <strong>
                  {report.data.coverage.complete && report.data.completion_rate !== null
                    ? percent.format(report.data.completion_rate)
                    : '—'}
                </strong>
              </div>
            </div>
            <ol className="analytics-path-steps">
              {report.data.steps.map((step, index) => {
                const users = measured(
                  step.users,
                  report.data.coverage.complete,
                  report.data.coverage.collection_started_at,
                );
                const previous = index
                  ? measured(
                      report.data.steps[index - 1]!.users,
                      report.data.coverage.complete,
                      report.data.coverage.collection_started_at,
                    )
                  : users;
                return (
                  <li key={`${index}:${step.id}`}>
                    <span>
                      {index + 1}. {step.name}
                    </span>
                    <strong>
                      {displayCount(users)}
                      {users !== null && <small>人</small>}
                    </strong>
                    <div className="analytics-step-bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${report.data.steps[0]!.users ? (step.users / report.data.steps[0]!.users) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    {index > 0 && (
                      <span className="muted">
                        上一步转化{' '}
                        {report.data.coverage.complete && step.conversion_rate !== null
                          ? percent.format(step.conversion_rate)
                          : '—'}{' '}
                        · 流失 {users === null || previous === null ? '—' : step.drop_off} 人
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="analytics-table-note">
              每一步按登录账号独立计数。同一用户多次尝试，只要有一次在窗口内依次到达，该步计一人；所有步骤均限定在查询日期范围内。
            </p>
          </section>
        </>
      )}
    </div>
  );
}
