import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { dayLabels, nextOccurrence, validateSolar, type DayBook, type DayEvent } from './day-dates';

/** 地址栏日期使用业务日期校验，不让无效日期溢出到其他月份。 */
function calendarDate(value: string | null, fallback: string): string {
  try {
    return value ? validateSolar(value) : fallback;
  } catch {
    return fallback;
  }
}

/** 每条记录在月份内生成真实发生日期，阶段起止分开显示，同日不重复。 */
export function monthOccurrences(event: DayEvent, from: string, to: string): string[] {
  if (event.category === 'stage')
    return [
      ...new Set(
        [event.start?.solar_date, event.end?.solar_date].filter(
          (date): date is string => !!date && date >= from && date <= to,
        ),
      ),
    ];
  const next = nextOccurrence(event, from);
  return next && next <= to ? [next] : [];
}

/** 月历与分类列表使用同一份完整快照，选日明细保持紧凑且不影响下方全部记录。 */
export function DayCalendar({
  book,
  events,
  today,
  onEdit,
}: {
  book: DayBook;
  events: readonly DayEvent[];
  today: string;
  onEdit: (event: DayEvent) => void;
}) {
  useProductAnalyticsPage('days.calendar', true, 1);
  const [params, setParams] = useSearchParams();
  const selected = calendarDate(params.get('date'), today);
  const month = calendarDate(params.get('month') ? `${params.get('month')}-01` : null, selected).slice(0, 7);
  /** 每次日历导航保留本子与其他参数，前后退可恢复月份和选中日。 */
  function navigate(nextMonth: string, nextDate: string) {
    const next = new URLSearchParams(params);
    next.set('book', book.id);
    next.set('month', nextMonth);
    next.set('date', nextDate);
    setParams(next);
  }
  const dates = useMemo(() => {
    const first = new Date(`${month}-01T00:00:00Z`);
    const offset = (first.getUTCDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, index) =>
      new Date(first.getTime() + (index - offset) * 86_400_000).toISOString().slice(0, 10),
    );
  }, [month]);
  const calendar = useMemo(() => {
    const calendar = new Map<string, DayEvent[]>();
    const first = dates[0]! < '1901-01-01' ? '1901-01-01' : dates[0]!;
    const last = dates.at(-1)! > '2100-12-31' ? '2100-12-31' : dates.at(-1)!;
    for (const event of events) {
      try {
        for (const date of monthOccurrences(event, first, last))
          calendar.set(date, [...(calendar.get(date) ?? []), event]);
      } catch (error) {
        // 损坏日期由下方待确认分组提供修正入口，月历继续绘制其他记录。
        console.error('[日子] 生成月历日期失败', { bookId: book.id, eventId: event.id, first, last, error });
      }
    }
    return calendar;
  }, [dates, events, book.id]);
  /** 月份只在应用支持区间内切换。 */
  function moveMonth(offset: number) {
    const [year = 0, number = 0] = month.split('-').map(Number);
    const next = new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
    if (next >= '1901-01' && next <= '2100-12') {
      navigate(next, `${next}-01`);
    }
  }
  const dayEvents = calendar.get(selected) ?? [];
  return (
    <section className="day-calendar" aria-label="日子日历">
      <div className="panel day-calendar-month">
        <div className="toolbar day-calendar-navigation">
          <Button variant="ghost" aria-label="上个月" disabled={month === '1901-01'} onClick={() => moveMonth(-1)}>
            <ChevronLeft size={18} />
          </Button>
          <h2>{month.replace('-', ' 年 ')} 月</h2>
          <Button variant="ghost" aria-label="下个月" disabled={month === '2100-12'} onClick={() => moveMonth(1)}>
            <ChevronRight size={18} />
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              navigate(today.slice(0, 7), today);
            }}
          >
            回到今天
          </Button>
        </div>
        <div className="calendar-grid" aria-label={`${month} 日历`}>
          {['一', '二', '三', '四', '五', '六', '日'].map((label) => (
            <div className="calendar-weekday" key={label}>
              周{label}
            </div>
          ))}
          {dates.map((date) => {
            const rows = calendar.get(date) ?? [];
            const supported = date >= '1901-01-01' && date <= '2100-12-31';
            return (
              <button
                type="button"
                className={`calendar-cell ${date.slice(0, 7) !== month ? 'calendar-outside' : ''} ${date === today ? 'calendar-today' : ''} ${date === selected ? 'calendar-selected' : ''}`}
                key={date}
                disabled={!supported}
                aria-label={`${date}，${rows.length} 个日子`}
                aria-pressed={date === selected}
                onClick={() => navigate(month, date)}
              >
                <span>{Number(date.slice(-2))}</span>
                {rows.length > 0 && <span className="day-calendar-count">{rows.length}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <section className="day-calendar-selection" aria-label={`${selected} 的日子`}>
        <h3>
          {selected}
          <span className="muted">{dayEvents.length} 个日子</span>
        </h3>
        {dayEvents.length ? (
          dayEvents.map((event) => (
            <div className="day-calendar-record" key={event.id}>
              <span className="badge">{dayLabels[event.category]}</span>
              <strong>{event.name}</strong>
              <Button size="sm" variant="ghost" aria-label={`查看与编辑 ${event.name}`} onClick={() => onEdit(event)}>
                查看
              </Button>
            </div>
          ))
        ) : (
          <p className="muted">这一天没有记录</p>
        )}
      </section>
    </section>
  );
}
