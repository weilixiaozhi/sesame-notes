import { useId, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ChartNoAxesCombined, ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { unwrap, type components, type paths } from '@sesame-notes/api-client';
import { api } from '../../lib/session';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { trackProductAction } from '../../lib/product-analytics-runtime';
import { Button, ErrorState, Field, LoadingState } from '../../components/ui';
import { displayAmount } from './money';
import { billingRange, currentBillingMonth, customDateRange } from './accounting-periods';
import { localDate, weekRange, previousRange, amountPercent, amountUnits } from './accounting-analytics';
import { AccountingInsights } from './accounting-insights';
import './accounting-overview.css';

type Ledger = components['schemas']['Ledger'];
type TransactionFilters = NonNullable<paths['/api/v1/ledgers/{ledger_id}/transactions']['get']['parameters']['query']>;

/** 筛选条件放在 URL 中，浏览器前进后退恢复同一账期和分类视图。 */
export function useAccountingFilters(ledger: Ledger) {
  const [params, setParams] = useSearchParams();
  const period = params.get('period') ?? currentBillingMonth(ledger.month_start_day);
  const scope = params.get('scope') ?? 'month';
  const today = localDate();
  const week = params.get('week') ?? today;
  const category = params.get('category') ?? '';
  const currency = params.get('currency') ?? '';
  const start = params.get('from') ?? '';
  const end = params.get('to') ?? '';
  const calculation = useMemo(() => {
    try {
      if (!['week', 'month', 'year', 'custom', 'all'].includes(scope)) throw new Error('请选择有效的统计范围。');
      if (currency && !/^[A-Z]{3}$/.test(currency))
        throw new Error('原币筛选请输入完整的三位大写币种代码，或清空查看全部币种。');
      let range: { start_at?: string; end_at?: string } =
        scope === 'all'
          ? {}
          : scope === 'week'
            ? weekRange(week)
            : scope === 'custom'
              ? customDateRange(start, end)
              : scope === 'year'
                ? {
                    start_at: billingRange(`${period.slice(0, 4)}-01`, ledger.month_start_day).start_at,
                    end_at: billingRange(`${period.slice(0, 4)}-12`, ledger.month_start_day).end_at,
                  }
                : billingRange(period, ledger.month_start_day);
      let throughToday = false;
      if ((scope === 'month' || scope === 'year') && range.start_at && range.end_at) {
        const todayRange = customDateRange(today, today);
        if (range.start_at <= todayRange.start_at && range.end_at > todayRange.end_at) {
          range = { ...range, end_at: todayRange.end_at };
          throughToday = true;
        }
      }
      const filters: TransactionFilters = {
        ...range,

        ...(category ? { category_id: category } : {}),
        ...(/^[A-Z]{3}$/.test(currency) ? { currency_code: currency } : {}),
      };
      const previous =
        Number(period.slice(0, 4)) > 100 ? previousRange(scope, period, week, ledger.month_start_day) : null;
      return { filters, previous, throughToday, error: '' };
    } catch (error) {
      console.error('账本筛选范围计算失败', { scope, period, week, start, end, currency, error });
      return {
        filters: {} as TransactionFilters,
        previous: null,
        throughToday: false,
        error: error instanceof Error ? error.message : '筛选条件无效。',
      };
    }
  }, [scope, period, week, today, start, end, category, currency, ledger.month_start_day]);
  /** 单次更新 URL 中的一个筛选项，保留其他筛选和浏览器历史。 */
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return { ...calculation, period, week, scope, category, currency, start, end, change };
}

/** 服务端统计覆盖完整筛选区间，分页只影响下方记录列表，不影响统计总额。 */
export function LedgerStatistics({
  ledger,
  accountId,
  categories,
  view,
  memberActions,
}: {
  ledger: Ledger;
  accountId: string;
  categories: components['schemas']['Category'][];
  view: ReturnType<typeof useAccountingFilters>;
  memberActions: ReactNode;
}) {
  const stats = useQuery({
    queryKey: ['account', accountId, 'accounting', ledger.id, 'stats', ledger.currency, view.filters],
    enabled: !view.error,
    queryFn: async ({ signal }) => {
      try {
        return unwrap(
          await api.GET('/api/v1/ledgers/{ledger_id}/transaction-stats', {
            signal,
            params: {
              path: { ledger_id: ledger.id },
              query: { ...view.filters, time_zone: new Intl.DateTimeFormat().resolvedOptions().timeZone },
            },
          }),
        );
      } catch (error) {
        if (!signal.aborted)
          console.error('读取账本支出概览失败', { ledgerId: ledger.id, filters: view.filters, error });
        throw error;
      }
    },
  });
  const [navigationError, setNavigationError] = useState('');
  const [showInsights, setShowInsights] = useState(false);
  useProductAnalyticsPage('accounting.statistics', showInsights, 1);
  const chartsId = useId();
  const activeFilters = Number(Boolean(view.category)) + Number(Boolean(view.currency));
  const currentPeriod = currentBillingMonth(ledger.month_start_day);
  const isCurrent =
    view.scope === 'week'
      ? !view.error && weekRange(view.week).start_at === weekRange(localDate()).start_at
      : view.scope === 'year'
        ? view.period.slice(0, 4) === currentPeriod.slice(0, 4)
        : view.period === currentPeriod;

  /** 用本地日期移动完整账期，非法日期在原位提示而不改变当前筛选。 */
  const movePeriod = (offset: number) => {
    try {
      setNavigationError('');
      if (view.scope === 'week') {
        const date = new Date(weekRange(view.week).start_at);
        date.setDate(date.getDate() + offset * 7);
        view.change('week', localDate(date));
      } else {
        billingRange(view.period, ledger.month_start_day);
        const date = new Date(Number(view.period.slice(0, 4)), Number(view.period.slice(5, 7)) - 1, 1);
        date.setMonth(date.getMonth() + offset * (view.scope === 'year' ? 12 : 1));
        const next = localDate(date).slice(0, 7);
        billingRange(next, ledger.month_start_day);
        view.change('period', next);
      }
    } catch (error) {
      console.error('切换账本账期失败', {
        ledgerId: ledger.id,
        scope: view.scope,
        period: view.period,
        week: view.week,
        offset,
        error,
      });
      setNavigationError('这个账期暂时无法打开，请重新选择日期。');
    }
  };

  return (
    <section className="panel accounting-statistics" aria-label="账本统计与筛选">
      <div className="accounting-overview-heading">
        <h2>支出概览</h2>
        <div className="accounting-period-tabs" role="group" aria-label="快速切换统计范围">
          {[
            ['week', '周'],
            ['month', '月'],
            ['year', '年'],
            ['custom', '自定义'],
            ['all', '全部'],
          ].map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={view.scope === value}
              onClick={() => view.change('scope', value!)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="accounting-period-toolbar">
        {['week', 'month', 'year'].includes(view.scope) && (
          <div className="accounting-period-picker">
            <Button
              variant="ghost"
              size="sm"
              aria-label="上一个账期"
              disabled={Boolean(view.error)}
              onClick={() => movePeriod(-1)}
            >
              <ChevronLeft size={17} />
            </Button>
            <Field
              label={
                view.scope === 'week' ? '选择周内日期' : view.scope === 'year' ? '选择年度（按所在年）' : '选择账期'
              }
            >
              <input
                type={view.scope === 'week' ? 'date' : 'month'}
                value={view.scope === 'week' ? view.week : view.period}
                onChange={(event) => view.change(view.scope === 'week' ? 'week' : 'period', event.target.value)}
              />
            </Field>
            <Button
              variant="ghost"
              size="sm"
              aria-label="下一个账期"
              disabled={Boolean(view.error)}
              onClick={() => movePeriod(1)}
            >
              <ChevronRight size={17} />
            </Button>
            {!isCurrent && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  view.change(
                    view.scope === 'week' ? 'week' : 'period',
                    view.scope === 'week' ? localDate() : currentPeriod,
                  )
                }
              >
                {view.scope === 'week' ? '回到本周' : view.scope === 'year' ? '回到本年' : '回到本期'}
              </Button>
            )}
          </div>
        )}
        {view.scope === 'custom' && (
          <div className="accounting-custom-period">
            <Field label="开始日期">
              <input type="date" value={view.start} onChange={(event) => view.change('from', event.target.value)} />
            </Field>
            <span aria-hidden="true">—</span>
            <Field label="结束日期">
              <input type="date" value={view.end} onChange={(event) => view.change('to', event.target.value)} />
            </Field>
          </div>
        )}
        {view.scope === 'all' && <p className="muted">查看这个账本的全部支出</p>}
        <span className="accounting-period-context">
          {view.scope === 'week'
            ? '每周一开始'
            : view.scope === 'month' || view.scope === 'year'
              ? `每月 ${ledger.month_start_day} 日起算`
              : ''}
          {view.throughToday ? ' · 截至今日' : ''}
        </span>
      </div>
      <details className="accounting-overview-filters">
        <summary>
          <SlidersHorizontal size={14} aria-hidden="true" />
          筛选条件{activeFilters > 0 ? ` · 已选 ${activeFilters} 项` : ' · 全部分类'}
        </summary>
        <div className="form-grid">
          <Field label="统计范围">
            <select value={view.scope} onChange={(event) => view.change('scope', event.target.value)}>
              <option value="week">周账期（周一开始）</option>
              <option value="month">月账期</option>
              <option value="year">年度账期</option>
              <option value="custom">自定义日期</option>
              <option value="all">全部时间</option>
            </select>
          </Field>
          <Field label="筛选分类">
            <select value={view.category} onChange={(event) => view.change('category', event.target.value)}>
              <option value="">全部分类</option>
              <option value="uncategorized">未分类</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="原币筛选" hint="留空显示全部币种。">
            <input
              maxLength={3}
              placeholder="例如 USD"
              value={view.currency}
              onChange={(event) => view.change('currency', event.target.value.toUpperCase())}
            />
          </Field>
        </div>
      </details>
      {navigationError && (
        <p role="alert" className="error-text">
          {navigationError}
        </p>
      )}
      {view.error ? (
        <p role="alert" className="error-text">
          {view.error}
        </p>
      ) : stats.isPending ? (
        <LoadingState label="正在统计账本…" />
      ) : stats.isError ? (
        <ErrorState error={stats.error} retry={() => void stats.refetch()} />
      ) : (
        <>
          <div className="accounting-overview-content" data-charts-expanded={showInsights}>
            <AccountingInsights
              stats={stats.data}
              accountId={accountId}
              ledgerId={ledger.id}
              filters={view.filters}
              previous={view.previous}
              throughToday={view.throughToday}
              trendId={`${chartsId}-trend`}
            />
            <CategoryBreakdown
              id={`${chartsId}-categories`}
              stats={stats.data}
              category={view.category}
              onSelect={(value) => view.change('category', value)}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="accounting-chart-toggle"
            aria-expanded={showInsights}
            aria-controls={`${chartsId}-trend ${chartsId}-categories`}
            onClick={() => {
              if (!showInsights) trackProductAction('accounting_statistics_open_click', 'accounting');
              setShowInsights(!showInsights);
            }}
          >
            <ChartNoAxesCombined size={15} />
            {showInsights ? '收起图表分析' : '展开图表分析'}
            <ChevronDown size={14} />
          </Button>
          {stats.data.by_currency.length > 1 && (
            <details className="accounting-currency-breakdown">
              <summary>按原币查看 · {stats.data.by_currency.length} 种币种</summary>
              <ul className="category-list">
                {stats.data.by_currency.map((currency) => (
                  <li className="toolbar" key={currency.currency_code}>
                    <span>
                      {currency.currency_code} {displayAmount(currency.amount_total)}
                    </span>
                    <span>
                      折合 {stats.data.ledger_currency} {displayAmount(currency.native_total)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {memberActions}
    </section>
  );
}

/** 分类按本位币金额排序，点击同一分类恢复全部，比例和金额均取完整统计。 */
function CategoryBreakdown({
  id,
  stats,
  category,
  onSelect,
}: {
  id: string;
  stats: import('./accounting-analytics').AccountingStats;
  category: string;
  onSelect: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...stats.by_category].sort((a, b) =>
    amountUnits(a.native_total) > amountUnits(b.native_total)
      ? -1
      : amountUnits(a.native_total) < amountUnits(b.native_total)
        ? 1
        : 0,
  );
  return (
    <section id={id} className="accounting-category-breakdown" aria-label="支出构成">
      <div className="accounting-chart-heading">
        <h3>钱花在哪里</h3>
        <span className="muted">{stats.ledger_currency}</span>
      </div>
      {sorted.length === 0 ? (
        <p className="accounting-chart-empty">记下第一笔支出后，就能看到分类构成。</p>
      ) : (
        <ul className="accounting-category-bars">
          {(expanded ? sorted : sorted.slice(0, 4)).map((item) => {
            const id = item.category_id ?? 'uncategorized';
            const percent = amountPercent(item.native_total, stats.expense_total);
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-pressed={category === id}
                  onClick={() => onSelect(category === id ? '' : id)}
                >
                  <span className="accounting-category-label">
                    <span>{item.category_name ?? '未分类'}</span>
                    <strong>{displayAmount(item.native_total)}</strong>
                  </span>
                  <span className="accounting-category-track" aria-hidden="true">
                    <span style={{ width: `${percent}%` }} />
                  </span>
                  <span className="accounting-category-meta">
                    <span className="sr-only">{item.transaction_count} 笔 · </span>
                    <span>{percent.toFixed(2)}%</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {sorted.length > 4 && (
        <Button variant="ghost" size="sm" className="accounting-show-categories" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起分类' : `查看全部 ${sorted.length} 个分类`}
        </Button>
      )}
      {category && (
        <Button variant="ghost" size="sm" onClick={() => onSelect('')}>
          查看全部分类
        </Button>
      )}
    </section>
  );
}
