import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { BookOpen, CalendarDays, ChevronLeft, ChevronRight, Dumbbell, KeyRound, NotebookPen } from 'lucide-react';
import { unwrap, type components } from '@sesame-notes/api-client';
import { api, useSession } from '../../lib/session';
import { trackProductAction } from '../../lib/product-analytics-runtime';
import { Button, EmptyState, ErrorState, Field, LoadingState, PageHeading } from '../../components/ui';
import { monthOccurrences } from '../days/day-calendar';
import './calendar-page.css';
import { dayLabels, type DayEvent } from '../days/day-dates';
import { displayAmount } from '../accounting/money';
import { calendarDates, calendarRange, localDateKey, shiftCalendarMonth, validCalendarDate } from './calendar-dates';

type MemoBook = components['schemas']['MemoBook'];
const calendarYears = Array.from({ length: 200 }, (_, index) => String(1901 + index));
const calendarMonths = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));

/** 各领域分别查询和重试，月历计数来自完整聚合，私人正文只读取选中日。 */
export function CalendarPage() {
  const { session } = useSession();
  const accountId = session!.user.user_id;
  const [params, setParams] = useSearchParams();
  const [today, setToday] = useState(() => localDateKey(new Date()));
  useEffect(() => {
    const update = () => setToday(localDateKey(new Date()));
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, []);
  const requestedDate = params.get('date');
  const selected = validCalendarDate(requestedDate) ? requestedDate : today;
  const requestedMonth = params.get('month');
  const month = validCalendarDate(`${requestedMonth}-01`) ? requestedMonth! : selected.slice(0, 7);
  const dates = useMemo(() => calendarDates(month), [month]);
  const first = dates[0]! < '1901-01-01' ? '1901-01-01' : dates[0]!;
  const last = dates.at(-1)! > '2100-12-31' ? '2100-12-31' : dates.at(-1)!;
  const range = useMemo(() => calendarRange(first, last), [first, last]);
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ledgers = useQuery({
    queryKey: ['account', accountId, 'accounting', 'ledgers'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/ledgers', { signal })),
  });
  const memos = useQuery({
    queryKey: ['account', accountId, 'memo-books'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/sync/memo-books', { signal })),
  });
  const days = useQuery({
    queryKey: ['account', accountId, 'day-books'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/sync/day-books', { signal })),
  });
  const fitness = useQuery({
    queryKey: ['account', accountId, 'fitness', 'spaces'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/sync/fitness-spaces', { signal })),
  });
  const choose = <T extends { id: string }>(items: T[] | undefined, key: string) =>
    params.has(key) ? items?.find((item) => item.id === params.get(key)) : items?.[0];
  const ledger = choose(
    ledgers.data?.filter((item) => !item.archived_at),
    'ledger',
  );
  const note = choose(
    memos.data?.memo_books.filter((item) => item.type === 'normal'),
    'memo',
  );
  const credential = choose(
    memos.data?.memo_books.filter((item) => item.type === 'credentials'),
    'credential',
  );
  const day = choose(days.data?.day_books, 'day');
  const space = choose(fitness.data?.fitness_spaces, 'space');
  const money = useQuery({
    queryKey: ['account', accountId, 'calendar', 'transactions', ledger?.id, range, timeZone],
    enabled: !!ledger,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/transaction-stats', {
          signal,
          params: {
            path: { ledger_id: ledger!.id },
            query: { ...range, time_zone: timeZone },
          },
        }),
      ),
  });
  const noteCounts = useMemoCounts(note, range, timeZone);
  const credentialCounts = useMemoCounts(credential, range, timeZone);
  const dayData = useQuery({
    queryKey: ['account', accountId, 'day-calendar', day?.id, day?.sync_id],
    enabled: !!day,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/day-books/full', {
          signal,
          params: { query: { day_book_id: day!.id, sync_id: day!.sync_id } },
        }),
      ),
  });
  const workouts = useQuery({
    queryKey: ['account', accountId, 'calendar', 'fitness', space?.id, space?.sync_id, first, last, timeZone],
    enabled: !!space,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/calendar', {
          signal,
          params: {
            path: { fitness_space_id: space!.id },
            query: { start_date: first, end_date: last, time_zone: timeZone, sync_id: space!.sync_id },
          },
        }),
      ),
  });
  const projection = useMemo(() => {
    const byDate = new Map<string, DayEvent[]>();
    let invalid = 0;
    for (const event of dayData.data?.day_events ?? []) {
      try {
        for (const date of monthOccurrences(event, first, last)) byDate.set(date, [...(byDate.get(date) ?? []), event]);
      } catch {
        invalid++;
      }
    }
    return { byDate, invalid };
  }, [dayData.data, first, last]);
  /** 日期和选本写入地址栏，前后退恢复相同上下文。 */
  function change(key: string, value: string) {
    if (key === 'date') trackProductAction('calendar_day_select', 'calendar');
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next);
  }
  /** 任意月份入口都保留数据来源，并把选中日期定位到目标月首日。 */
  function selectMonth(value: string) {
    if (!validCalendarDate(`${value}-01`)) return;
    const next = new URLSearchParams(params);
    next.set('month', value);
    next.set('date', `${value}-01`);
    setParams(next);
  }
  /** 前后月沿用同一范围校验与地址栏状态。 */
  function move(offset: number) {
    const nextMonth = shiftCalendarMonth(month, offset);
    if (nextMonth) selectMonth(nextMonth);
  }
  const selectedWorkouts = workouts.data?.days.find((item) => item.date === selected);
  const loadingNames = [
    ledger && money.isPending && '支出',
    note && noteCounts.isPending && '备忘录',
    credential && credentialCounts.isPending && '账号密码',
    day && dayData.isPending && '日子',
    space && workouts.isPending && '训练',
  ].filter(Boolean);
  const sources = [
    { label: '账本', query: ledgers },
    { label: '备忘录本', query: memos },
    { label: '日子本', query: days },
    { label: '健身空间', query: fitness },
  ];
  const pendingSources = sources.filter((source) => source.query.isPending).map((source) => source.label);
  const sourcesReady = sources.every((source) => source.query.isSuccess);
  const scopes = [
    {
      key: 'ledger',
      label: '日历账本',
      value: ledger?.id,
      items: ledgers.data?.filter((item) => !item.archived_at),
      loading: ledgers.isPending,
      error: ledgers.error,
    },
    {
      key: 'memo',
      label: '日历备忘录本',
      value: note?.id,
      items: memos.data?.memo_books.filter((item) => item.type === 'normal'),
      loading: memos.isPending,
      error: memos.error,
    },
    {
      key: 'credential',
      label: '日历账号密码本',
      value: credential?.id,
      items: memos.data?.memo_books.filter((item) => item.type === 'credentials'),
      loading: memos.isPending,
      error: memos.error,
    },
    {
      key: 'day',
      label: '日历日子本',
      value: day?.id,
      items: days.data?.day_books,
      loading: days.isPending,
      error: days.error,
    },
    {
      key: 'space',
      label: '日历健身空间',
      value: space?.id,
      items: fitness.data?.fitness_spaces,
      loading: fitness.isPending,
      error: fitness.error,
    },
  ];
  const invalidScopes = scopes.filter(
    (scope) => params.get(scope.key) && !scope.value && !scope.loading && !scope.error,
  );
  return (
    <div className="stack calendar-page">
      <PageHeading title="日历" />
      {pendingSources.length > 0 && <LoadingState label={`正在读取${pendingSources.join('、')}…`} />}
      {sources.map((source) =>
        source.query.isError ? (
          <section className="stack" key={source.label} aria-label={`${source.label}读取失败`}>
            <p className="muted">{source.label}读取失败</p>
            <ErrorState error={source.query.error} retry={() => void source.query.refetch()} />
          </section>
        ) : null,
      )}
      {invalidScopes.length > 0 && (
        <p role="alert" className="field-error">
          所选内容已不存在或无法访问，请展开“选择日历内容”重新选择。
        </p>
      )}
      <details className="panel calendar-sources">
        <summary>选择日历内容</summary>
        <div className="form-grid">
          {scopes.map((scope) => (
            <div key={scope.key}>
              <Field label={scope.label}>
                <select
                  value={scope.value ?? ''}
                  disabled={scope.loading || !!scope.error}
                  onChange={(event) => change(scope.key, event.target.value)}
                >
                  <option value="">{scope.loading ? '读取中…' : '不显示'}</option>
                  {scope.items?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ))}
        </div>
        <p className="muted">备忘录和账号卡片按修改日期显示。</p>
      </details>
      <section className="panel stack" aria-label="生活月历">
        {loadingNames.length > 0 && (
          <p role="status" className="muted">
            正在读取{loadingNames.join('、')}日历…
          </p>
        )}
        <div className="toolbar calendar-toolbar">
          <Button
            className="calendar-month-step"
            variant="ghost"
            aria-label="上个月"
            disabled={month === '1901-01'}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={18} />
          </Button>
          <Field label="年份">
            <select
              aria-label="日历年份"
              value={month.slice(0, 4)}
              onChange={(event) => selectMonth(`${event.target.value}-${month.slice(5, 7)}`)}
            >
              {calendarYears.map((year) => (
                <option key={year} value={year}>
                  {year}年
                </option>
              ))}
            </select>
          </Field>
          <Field label="月份">
            <select
              aria-label="日历月份"
              value={month.slice(5, 7)}
              onChange={(event) => selectMonth(`${month.slice(0, 4)}-${event.target.value}`)}
            >
              {calendarMonths.map((value) => (
                <option key={value} value={value}>
                  {Number(value)}月
                </option>
              ))}
            </select>
          </Field>
          <Button
            className="calendar-month-step"
            variant="ghost"
            aria-label="下个月"
            disabled={month === '2100-12'}
            onClick={() => move(1)}
          >
            <ChevronRight size={18} />
          </Button>
          <Button
            className="calendar-today-button"
            variant="secondary"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('date', today);
              next.set('month', today.slice(0, 7));
              setParams(next);
            }}
          >
            今天
          </Button>
        </div>
        <div className="calendar-legend">
          <span>
            <BookOpen size={13} />
            支出
          </span>
          <span>
            <NotebookPen size={13} />
            备忘录
          </span>
          <span>
            <KeyRound size={13} />
            账号密码
          </span>
          <span>
            <Dumbbell size={13} />
            训练
          </span>
          <span>
            <CalendarDays size={13} />
            日子
          </span>
        </div>
        {[
          [ledger, money],
          [note, noteCounts],
          [credential, credentialCounts],
        ].map(([scope, query], index) =>
          scope && query && 'isError' in query && query.isError ? (
            <ErrorState key={index} error={query.error} retry={() => void query.refetch()} />
          ) : null,
        )}
        {projection.invalid > 0 && (
          <p role="alert" className="field-error">
            有 {projection.invalid} 个日子的日期需要确认，请在日子中查看。
          </p>
        )}
        <div className="calendar-grid unified-calendar">
          {['一', '二', '三', '四', '五', '六', '日'].map((label) => (
            <div className="calendar-weekday" key={label}>
              周{label}
            </div>
          ))}
          {dates.map((date) => {
            const expense = money.data?.by_day.find((item) => item.date === date);
            const notes = noteCounts.data?.days.find((item) => item.date === date)?.count ?? 0;
            const credentials = credentialCounts.data?.days.find((item) => item.date === date)?.count ?? 0;
            const workout = workouts.data?.days.find((item) => item.date === date);
            const events = projection.byDate.get(date) ?? [];
            const descriptions = [
              expense ? `支出 ${expense.native_total} ${ledger?.currency}` : '',
              notes ? `${notes} 条备忘录` : '',
              credentials ? `${credentials} 张账号卡片` : '',
              workout?.workouts.length ? `${workout.workouts.length} 次训练` : '',
              workout?.rest_days.length ? '休息日' : '',
              events.length ? `${events.length} 个日子` : '',
            ].filter(Boolean);
            return (
              <button
                type="button"
                key={date}
                disabled={!validCalendarDate(date)}
                className={`calendar-cell ${date.slice(0, 7) !== month ? 'calendar-outside' : ''} ${date === today ? 'calendar-today' : ''} ${date === selected ? 'calendar-selected' : ''}`}
                aria-label={`${date}${descriptions.length ? `，${descriptions.join('，')}` : ''}`}
                aria-pressed={date === selected}
                onClick={() => change('date', date)}
              >
                <span>{Number(date.slice(-2))}</span>
                <span className="calendar-markers">
                  {expense && (
                    <span title={`支出 ${expense.native_total} ${ledger?.currency}`}>
                      <BookOpen size={12} />
                      <span className="calendar-marker-text">{displayAmount(expense.native_total)}</span>
                    </span>
                  )}
                  {notes > 0 && (
                    <span title={`${notes} 条备忘录`}>
                      <NotebookPen size={12} />
                      {notes}
                    </span>
                  )}
                  {credentials > 0 && (
                    <span title={`${credentials} 张账号卡片`}>
                      <KeyRound size={12} />
                      {credentials}
                    </span>
                  )}
                  {!!workout?.workouts.length && (
                    <span title={`${workout.workouts.length} 次训练`}>
                      <Dumbbell size={12} />
                      {workout.workouts.length}
                    </span>
                  )}
                  {!!workout?.rest_days.length && <span>休</span>}
                  {events.length > 0 && (
                    <span title={events.map((event) => event.name).join('、')}>
                      <CalendarDays size={12} />
                      {events.length}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <div className="section-heading">
        <h2>{selected} 的记录</h2>
      </div>
      <div className="calendar-day-records">
        {ledger && <TransactionDay key={`${ledger.id}:${selected}`} ledger={ledger} date={selected} />}
        {note && <MemoDay key={`${note.id}:${selected}`} book={note} date={selected} />}
        {credential && <MemoDay key={`${credential.id}:${selected}`} book={credential} date={selected} />}
        {day && (
          <section className="panel stack">
            <div className="section-heading">
              <h3>日子 · {day.name}</h3>
              <Link
                to={`/days?book=${day.id}`}
                onClick={() => trackProductAction('calendar_section_open_click', 'calendar')}
              >
                打开日子本
              </Link>
            </div>
            {dayData.isPending ? (
              <LoadingState />
            ) : dayData.isError ? (
              <ErrorState error={dayData.error} retry={() => void dayData.refetch()} />
            ) : (projection.byDate.get(selected) ?? []).length ? (
              projection.byDate.get(selected)!.map((event) => (
                <Link
                  className="calendar-record"
                  key={event.id}
                  to={`/days?book=${day.id}&event=${event.id}`}
                  onClick={() => trackProductAction('days_event_open_click', 'calendar')}
                >
                  <span className="badge">{dayLabels[event.category]}</span>
                  <strong>{event.name}</strong>
                  <span>查看与编辑 →</span>
                </Link>
              ))
            ) : (
              <p className="muted">这一天没有日子记录。</p>
            )}
          </section>
        )}
        {space && (
          <section className="panel stack">
            <div className="section-heading">
              <h3>训练 · {space.name}</h3>
              <Link
                to={`/fitness?space=${space.id}&tab=calendar`}
                onClick={() => trackProductAction('calendar_section_open_click', 'calendar')}
              >
                打开训练日历
              </Link>
            </div>
            {workouts.isPending ? (
              <LoadingState />
            ) : workouts.isError ? (
              <ErrorState error={workouts.error} retry={() => void workouts.refetch()} />
            ) : (
              <>
                {selectedWorkouts?.workouts.map((workout) => (
                  <Link
                    className="calendar-record"
                    key={workout.id}
                    to={`/fitness?space=${space.id}&detail=${workout.id}`}
                    onClick={() => trackProductAction('fitness_workout_open_click', 'calendar')}
                  >
                    <Dumbbell size={18} />
                    <strong>{workout.name}</strong>
                    <span>
                      {workout.status === 'completed'
                        ? '已完成'
                        : workout.status === 'in_progress'
                          ? '进行中'
                          : '已安排'}
                    </span>
                  </Link>
                ))}
                {selectedWorkouts?.rest_days.map((rest) => (
                  <p className="muted" key={rest.source_plan_id}>
                    {rest.source_plan_name} · 休息日
                  </p>
                ))}
                {!selectedWorkouts?.workouts.length && !selectedWorkouts?.rest_days.length && (
                  <p className="muted">这一天没有训练安排。</p>
                )}
              </>
            )}
          </section>
        )}
      </div>
      {sourcesReady && invalidScopes.length === 0 && !ledger && !note && !credential && !day && !space && (
        <EmptyState title="为日历选择内容" description="展开“选择日历内容”，选择要显示的本子。" />
      )}
    </div>
  );
}

/** 月历计数接口不返回标题、富文本或账号密码内容。 */
function useMemoCounts(book: MemoBook | undefined, range: ReturnType<typeof calendarRange>, timeZone: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: ['account', session!.user.user_id, 'calendar', 'memo-counts', book?.id, book?.sync_id, range, timeZone],
    enabled: !!book,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/memo-books/{memo_book_id}/calendar-counts', {
          signal,
          params: {
            path: { memo_book_id: book!.id },
            query: { ...range, time_zone: timeZone, sync_id: book!.sync_id },
          },
        }),
      ),
  });
}

/** 选中日明细单独分页，账号卡片只显示标题，不将密码值渲染到日历。 */
function MemoDay({ book, date }: { book: MemoBook; date: string }) {
  const { session } = useSession();
  const path = book.type === 'credentials' ? '/credentials' : '/memos';
  const range = calendarRange(date, date);
  const data = useInfiniteQuery({
    queryKey: ['account', session!.user.user_id, 'calendar', 'memo-day', book.id, book.sync_id, range],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await api.GET('/api/v1/memo-books/{memo_book_id}/entries', {
          signal,
          params: {
            path: { memo_book_id: book.id },
            query: { ...range, sync_id: book.sync_id, limit: 30, cursor: pageParam },
          },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = data.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="panel stack">
      <div className="section-heading">
        <h3>
          {book.type === 'normal' ? '备忘录' : '账号密码'} · {book.name}
        </h3>
        <Link
          to={`${path}?book=${book.id}`}
          onClick={() => trackProductAction('calendar_section_open_click', 'calendar')}
        >
          打开本子
        </Link>
      </div>
      {data.isPending ? (
        <LoadingState />
      ) : (
        <>
          {items.map((entry) => (
            <Link
              className="calendar-record"
              key={entry.id}
              to={`${path}?book=${book.id}&entry=${entry.id}`}
              onClick={() =>
                trackProductAction(
                  book.type === 'credentials' ? 'credentials_open_click' : 'memos_note_open_click',
                  'calendar',
                )
              }
            >
              {book.type === 'normal' ? <NotebookPen size={18} /> : <KeyRound size={18} />}
              <strong>{entry.title || '无标题'}</strong>
              <span>查看与编辑 →</span>
            </Link>
          ))}
          {!items.length && !data.isError && <p className="muted">这一天没有修改记录。</p>}
        </>
      )}
      {data.isError && (
        <ErrorState
          error={data.error}
          retry={() => void (data.isFetchNextPageError ? data.fetchNextPage() : data.refetch())}
        />
      )}
      {data.hasNextPage && (
        <Button variant="secondary" disabled={data.isFetchingNextPage} onClick={() => void data.fetchNextPage()}>
          {data.isFetchingNextPage ? '读取中…' : '加载更多'}
        </Button>
      )}
    </section>
  );
}

/** 当天明细与月格金额统一展示全部支出，按同一自然日范围读取。 */
function TransactionDay({ ledger, date }: { ledger: components['schemas']['Ledger']; date: string }) {
  const { session } = useSession();
  const range = calendarRange(date, date);
  const data = useInfiniteQuery({
    queryKey: ['account', session!.user.user_id, 'calendar', 'transaction-day', ledger.id, range],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/transactions', {
          signal,
          params: {
            path: { ledger_id: ledger.id },
            query: { ...range, limit: 30, cursor: pageParam },
          },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = data.data?.pages.flatMap((page) => page.items) ?? [];
  const link = `/accounting?ledger=${ledger.id}&scope=custom&from=${date}&to=${date}`;
  return (
    <section className="panel stack">
      <div className="section-heading">
        <h3>支出 · {ledger.name}</h3>
        <Link to={link} onClick={() => trackProductAction('calendar_section_open_click', 'calendar')}>
          查看当天账目
        </Link>
      </div>
      {data.isPending ? (
        <LoadingState />
      ) : (
        <>
          {items.map((item) => (
            <Link
              className="calendar-record"
              key={item.id}
              to={link}
              onClick={() => trackProductAction('calendar_section_open_click', 'calendar')}
            >
              <BookOpen size={18} />
              <strong>{item.note || item.category_name || '未分类支出'}</strong>
              <span>
                {displayAmount(item.native_amount)} {ledger.currency}
              </span>
            </Link>
          ))}
          {!items.length && !data.isError && <p className="muted">这一天没有支出记录。</p>}
        </>
      )}
      {data.isError && (
        <ErrorState
          error={data.error}
          retry={() => void (data.isFetchNextPageError ? data.fetchNextPage() : data.refetch())}
        />
      )}
      {data.hasNextPage && (
        <Button variant="secondary" disabled={data.isFetchingNextPage} onClick={() => void data.fetchNextPage()}>
          {data.isFetchingNextPage ? '读取中…' : '加载更多'}
        </Button>
      )}
    </section>
  );
}
