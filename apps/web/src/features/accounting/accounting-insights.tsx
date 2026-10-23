import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap, type paths } from '@sesame-notes/api-client';
import { api } from '../../lib/session';
import { ErrorState } from '../../components/ui';
import { displayAmount } from './money';
import {
  amountPercent,
  amountUnits,
  dailyAverage,
  localDate,
  periodChange,
  rangeDays,
  type AccountingStats,
} from './accounting-analytics';
type TransactionFilters = NonNullable<paths['/api/v1/ledgers/{ledger_id}/transactions']['get']['parameters']['query']>;

/** 展示准确的日均、上期对比和可键盘操作的逐日支出趋势。 */
export function AccountingInsights({
  stats,
  accountId,
  ledgerId,
  filters,
  previous,
  throughToday = false,
  trendId,
}: {
  stats: AccountingStats;
  accountId: string;
  ledgerId: string;
  filters: TransactionFilters;
  previous: { start_at: string; end_at: string } | null;
  throughToday?: boolean;
  trendId?: string;
}) {
  const prior = useQuery({
    queryKey: [
      'account',
      accountId,
      'accounting',
      ledgerId,
      'previous-stats',
      stats.ledger_currency,
      filters,
      previous,
    ],
    enabled: previous !== null,
    queryFn: async ({ signal }) => {
      try {
        return unwrap(
          await api.GET('/api/v1/ledgers/{ledger_id}/transaction-stats', {
            signal,
            params: {
              path: { ledger_id: ledgerId },
              query: { ...filters, ...previous, time_zone: new Intl.DateTimeFormat().resolvedOptions().timeZone },
            },
          }),
        );
      } catch (error) {
        if (!signal.aborted) console.error('读取上期支出对比失败', { ledgerId, filters, previous, error });
        throw error;
      }
    },
  });
  const days = rangeDays(filters.start_at, filters.end_at);
  return (
    <div className="accounting-overview-insights">
      <div className="accounting-overview-summary">
        <span className="accounting-total-label">这段时间的支出 · {stats.ledger_currency}</span>
        <p className="accounting-total-amount">{displayAmount(stats.expense_total)}</p>
        <p className="accounting-total-context">
          共 {stats.transaction_count} 笔记录{throughToday ? ' · 当前账期截至今日' : ''}
        </p>
        <div className="accounting-overview-metrics">
          {days !== null && (
            <div>
              <span className="muted">
                日均支出 <span className="accounting-metric-detail">· {days} 天</span>
              </span>
              <p>
                <strong>{dailyAverage(stats.expense_total, days)}</strong>
              </p>
            </div>
          )}
          {previous && (
            <div>
              <span className="muted">较上一完整周期</span>
              <p>
                <strong>
                  {prior.isPending
                    ? '正在比较…'
                    : prior.isError
                      ? '暂时无法比较'
                      : prior.data.ledger_currency !== stats.ledger_currency
                        ? '账本币种已改变，请刷新统计后比较'
                        : periodChange(stats.expense_total, prior.data.expense_total)}
                </strong>
              </p>
            </div>
          )}
        </div>
        {throughToday && previous && <p className="accounting-comparison-note">本期未结束，上期为完整账期。</p>}
      </div>
      <ExpenseTrend
        id={trendId}
        key={`${filters.start_at}-${filters.end_at}`}
        stats={stats}
        start={filters.start_at}
        end={filters.end_at}
      />
      {previous && prior.isError && (
        <div className="accounting-comparison-error">
          <ErrorState error={prior.error} retry={() => void prior.refetch()} />
        </div>
      )}
    </div>
  );
}

/** 小范围补齐无支出日期的零值，超长区间按实际有账日期展示以控制浏览器工作量。 */
function trendDays(stats: AccountingStats, start?: string, end?: string) {
  const values = new Map((stats.by_day ?? []).map((day) => [day.date, day]));
  const count = rangeDays(start, end);
  if (start && end && count !== null && count > 0 && count <= 366) {
    const date = new Date(start);
    for (let index = 0; index < count; index += 1) {
      const key = localDate(date);
      if (!values.has(key)) values.set(key, { date: key, native_total: '0', transaction_count: 0 });
      date.setDate(date.getDate() + 1);
    }
  }
  return [...values.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** 趋势图直接呈现逐日金额，原生滑块支持触屏和键盘逐点读取。 */
function ExpenseTrend({
  stats,
  start,
  end,
  id,
}: {
  stats: AccountingStats;
  start?: string;
  end?: string;
  id?: string;
}) {
  const days = trendDays(stats, start, end);
  const [selected, setSelected] = useState(Math.max(0, days.length - 1));
  const gradientId = useId();
  const rangeId = useId();
  const activeIndex = Math.min(selected, days.length - 1);
  const active = days[activeIndex];
  if (days.length === 0)
    return (
      <section id={id} className="accounting-expense-trend" aria-label="支出趋势">
        <h3>每日支出</h3>
        <p className="accounting-chart-empty">当前筛选范围还没有支出趋势。</p>
      </section>
    );
  const maximum = days.reduce(
    (largest, day) => (amountUnits(day.native_total) > amountUnits(largest) ? day.native_total : largest),
    '0',
  );
  // 金额只在计算有界图表坐标时转换为百分比，展示仍保留原始十进制精度。
  const points = days.map((day, index) => ({
    x: days.length === 1 ? 300 : 12 + (index * 576) / (days.length - 1),
    y: 130 - amountPercent(day.native_total, maximum) * 1.05,
  }));
  const point = points[activeIndex];
  const coordinates = points.map(({ x, y }) => `${x},${y}`).join(' ');
  return (
    <section id={id} className="accounting-expense-trend" aria-label="支出趋势">
      <div className="accounting-chart-heading">
        <h3>每日支出</h3>
        <span className="muted">{stats.ledger_currency}</span>
      </div>
      <div className="accounting-trend-value" role="status">
        {active && (
          <>
            <span>{active.date}</span>
            <strong>{displayAmount(active.native_total)}</strong>
            <span>· {active.transaction_count} 笔</span>
          </>
        )}
      </div>
      <div className="accounting-trend-chart">
        <span className="accounting-trend-maximum">{displayAmount(maximum)}</span>
        <svg
          viewBox="0 0 600 142"
          preserveAspectRatio="none"
          role="img"
          aria-label="每日支出趋势图，具体金额可在下方按日期查看"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {[25, 77.5, 130].map((y) => (
            <line
              key={y}
              x1="12"
              x2="588"
              y1={y}
              y2={y}
              stroke="var(--border)"
              strokeDasharray={y === 130 ? undefined : '4 5'}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polygon
            points={`${points[0]?.x},130 ${coordinates} ${points[points.length - 1]?.x},130`}
            fill={`url(#${gradientId})`}
          />
          <polyline
            points={coordinates}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2.5"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {point && (
            <>
              <line
                x1={point.x}
                x2={point.x}
                y1="18"
                y2="130"
                stroke="var(--primary)"
                strokeOpacity="0.25"
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={point.x}
                cy={point.y}
                r="4"
                fill="var(--primary)"
                stroke="var(--surface)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </svg>
        <span className="accounting-trend-zero">0</span>
      </div>
      <label className="sr-only" htmlFor={rangeId}>
        查看日期
      </label>
      <input
        id={rangeId}
        className="accounting-trend-slider"
        type="range"
        min={0}
        max={Math.max(0, days.length - 1)}
        value={Math.max(0, activeIndex)}
        disabled={days.length === 1}
        onChange={(event) => setSelected(Number(event.target.value))}
        aria-valuetext={
          active ? `${active.date} 支出 ${displayAmount(active.native_total)} ${stats.ledger_currency}` : undefined
        }
      />
      <div className="accounting-trend-dates">
        <span>{days[0]?.date}</span>
        <span>{days[days.length - 1]?.date}</span>
      </div>
      {!start || !end || (rangeDays(start, end) ?? 0) > 366 ? (
        <p className="accounting-comparison-note">长时间范围按实际有支出的日期展示。</p>
      ) : null}
    </section>
  );
}
