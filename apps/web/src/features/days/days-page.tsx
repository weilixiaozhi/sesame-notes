import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useDraftClose } from '../../components/use-draft-close';
import { DayTools } from './day-tools';
import { DayExport } from './day-export';
import { DayImport } from './day-import';
import { DayCalendar } from './day-calendar';
import { DeleteDayBookDialog } from './delete-day-book-dialog';
import { Pencil, Plus, Trash2, Calculator } from 'lucide-react';
import './days-page.css';
import { unwrap } from '@sesame-notes/api-client';
import { api, pushChange, useSession } from '../../lib/session';
import { createDefaultBookProvisioner } from '../../app/default-book';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import {
  beginProductAnalyticsFlow,
  captureProductAnalyticsContext,
  trackProductAction,
  type ProductAnalyticsContext,
} from '../../lib/product-analytics-runtime';
import { Button, Dialog, EmptyState, ErrorState, Field, LoadingState, PageHeading } from '../../components/ui';
import { BookTabs } from '../../components/book-tabs';
import { BookWorkspaceHeader } from '../../components/book-workspace-header';
import { groupDayEvents } from './day-order';
import {
  buildDefinition,
  convertCalendar,
  dateLabel,
  dayLabels,
  daySummary,
  projectDate,
  solarDate,
  todayDate,
  type DayBook,
  type DayDate,
  type DayDefinition,
  type DayEvent,
} from './day-dates';

const dayOrderHints: Record<DayEvent['category'], string> = {
  birthday: '按下一次生日，由近到远',
  anniversary: '按下一次纪念日，由近到远',
  countdown: '未到期由近到远，已过期排在后面',
  stage: '按开始日期，由新到旧',
};

/** 跨过午夜或重新聚焦时更新今天，卡片不会一直显示昨天的倒数。 */
function useToday() {
  const [today, setToday] = useState(todayDate);
  useEffect(() => {
    const update = () => setToday(todayDate());
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, []);
  return today;
}

/** 整本日子按固定类型分组，并按各类型的实际发生日期展示。 */
export function DaysPage() {
  const { session } = useSession();
  const accountId = session!.user.user_id;
  const [params, setParams] = useSearchParams();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [bookDialog, setBookDialog] = useState<DayBook | 'new' | null>(null);
  const [eventDialog, setEventDialog] = useState<DayEvent | 'new' | null>(null);
  const [eventFlow, setEventFlow] = useState<ProductAnalyticsContext | null>(null);
  const firstEventFlow = useRef<ProductAnalyticsContext | null>(null);
  const [deleting, setDeleting] = useState<DayEvent | null>(null);
  const [deletingBook, setDeletingBook] = useState<DayBook | null>(null);
  const pageActive = useRef(true);
  const provisionDefaultBook = useMemo(() => createDefaultBookProvisioner('days', accountId), [accountId]);
  useEffect(() => {
    pageActive.current = true;
    return () => {
      pageActive.current = false;
    };
  }, []);
  const firstEvent = useMutation({
    /** 首次记录由用户主动发起，云端已有本子时直接复用，失败保留重试入口。 */
    mutationFn: async () => {
      try {
        return await provisionDefaultBook();
      } catch (error) {
        console.error('准备第一个日子失败', { accountId, error });
        throw error;
      }
    },
    onSuccess: (bookId) => {
      // 目录缓存包含服务器同步身份，离开页面后的异步完成不再改变当前路由。
      if (!pageActive.current) return;
      selectBook(bookId);
      setEventFlow(firstEventFlow.current);
      setEventDialog('new');
    },
  });
  const today = useToday();
  const books = useQuery({
    queryKey: ['account', session!.user.user_id, 'day-books'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/sync/day-books', { signal })),
  });
  const requestedBook = params.get('book');
  const requestedEvent = params.get('event');
  const selected = requestedBook
    ? books.data?.day_books.find((book) => book.id === requestedBook)
    : books.data?.day_books[0];
  const events = useQuery({
    queryKey: ['account', session!.user.user_id, 'day-events', selected?.id, 'full', selected?.sync_id],
    staleTime: 15_000,
    enabled: !!selected && !deletingBook,
    queryFn: async ({ signal }) => {
      try {
        // 在同一份完整快照上排序，创建较早但即将到来的日子也会出现在正确位置。
        return unwrap(
          await api.GET('/api/v1/sync/day-books/full', {
            signal,
            params: { query: { day_book_id: selected!.id, sync_id: selected!.sync_id } },
          }),
        );
      } catch (error) {
        if (!signal.aborted) console.error('[日子] 读取日子本失败', { bookId: selected?.id, error });
        throw error;
      }
    },
  });
  const { groups, invalid } = useMemo(
    () => groupDayEvents(events.data?.day_events ?? [], today, selected?.id ?? ''),
    [events.data, today, selected?.id],
  );
  const hasEvents = groups.length > 0 || invalid.length > 0;
  /** 创建和已有日子分别记录用户入口点击，不上传日子名称、日期或对象身份。 */
  function openEvent(event: DayEvent | 'new'): void {
    try {
      const context = beginProductAnalyticsFlow();
      trackProductAction(
        event === 'new' ? 'days_event_create_click' : 'days_event_open_click',
        undefined,
        accountId,
        context,
      );
      setEventFlow(context);
      setEventDialog(event);
    } catch (error) {
      console.warn('[日子] 打开日子暂不可用', error);
    }
  }
  /** 本子保存在地址栏，切换本子只移除旧条目深链。 */
  function selectBook(id: string) {
    const next = new URLSearchParams(params);
    next.set('book', id);
    next.delete('event');
    setParams(next);
  }
  return (
    <div className="stack days-page">
      {toolsOpen && <DayTools onClose={() => setToolsOpen(false)} />}
      <PageHeading
        title="日子"
        actions={
          <div className="toolbar">
            {selected && (
              <Button onClick={() => openEvent('new')}>
                <Plus size={16} />
                添加日子
              </Button>
            )}
            <Button variant="secondary" onClick={() => setToolsOpen(true)}>
              <Calculator size={16} />
              日期工具
            </Button>
          </div>
        }
      />
      {firstEvent.isError && <ErrorState error={firstEvent.error} retry={() => firstEvent.mutate()} />}
      {books.isPending ? (
        <LoadingState label="正在读取日子本…" />
      ) : books.isError && !books.data ? (
        <ErrorState
          error={books.error}
          retry={() => {
            void books.refetch();
          }}
        />
      ) : requestedBook && !selected ? (
        <EmptyState
          title="找不到这个日子本"
          description="本子可能已删除，或当前账号没有访问权限。"
          action={<Button onClick={() => setParams({})}>返回我的本子</Button>}
        />
      ) : !selected ? (
        <EmptyState
          title="留住值得记住的日子"
          description="生日、纪念日或下一次期待，从第一个日子开始。"
          action={
            <Button
              disabled={firstEvent.isPending}
              onClick={() => {
                firstEventFlow.current = beginProductAnalyticsFlow();
                trackProductAction('days_event_create_click', 'days', accountId, firstEventFlow.current);
                firstEvent.mutate();
              }}
            >
              <Plus size={16} />
              {firstEvent.isPending ? '正在打开…' : '添加第一个日子'}
            </Button>
          }
        />
      ) : (
        <>
          {books.isError && !events.isError && (
            <ErrorState
              error={books.error}
              retry={() => {
                void books.refetch();
              }}
            />
          )}
          <BookWorkspaceHeader
            label="日子本管理"
            disabled={firstEvent.isPending}
            selector={
              <BookTabs
                label="日子本"
                items={books.data?.day_books ?? []}
                value={selected.id}
                onSelect={(id) => {
                  trackProductAction('days_book_select', 'days');
                  selectBook(id);
                }}
                disabled={firstEvent.isPending}
              />
            }
            sections={[
              {
                id: 'create',
                title: '新建',
                content: (
                  <Button variant="ghost" onClick={() => setBookDialog('new')} disabled={firstEvent.isPending}>
                    <Plus size={16} />
                    新建日子本
                  </Button>
                ),
              },
              {
                id: 'settings',
                title: '设置',
                content: (
                  <Button variant="ghost" onClick={() => setBookDialog(selected)}>
                    <Pencil size={16} />
                    重命名
                  </Button>
                ),
              },
              {
                id: 'data',
                title: '数据操作',
                content: (
                  <>
                    <DayImport book={selected} />
                    <DayExport book={selected} />
                    <Button
                      variant="ghost"
                      className="book-management-delete"
                      onClick={() => setDeletingBook(selected)}
                    >
                      <Trash2 size={16} />
                      删除本子
                    </Button>
                  </>
                ),
              },
            ]}
          />
          {events.isPending ? (
            <LoadingState />
          ) : events.isError && !hasEvents ? (
            <ErrorState
              error={events.error}
              retry={() => {
                void events.refetch();
                if (books.isError) void books.refetch();
              }}
            />
          ) : (
            <>
              <DayCalendar
                key={selected.id}
                book={selected}
                events={events.data?.day_events ?? []}
                today={today}
                onEdit={openEvent}
              />
              {!hasEvents ? (
                <EmptyState
                  title="暂无日子"
                  action={<Button onClick={() => openEvent('new')}>添加第一个日子</Button>}
                />
              ) : (
                <div className="days-groups">
                  {groups.map((group) => (
                    <section className="day-group" key={group.category} aria-labelledby={`day-group-${group.category}`}>
                      <header className="day-group-heading">
                        <div className="day-group-title">
                          <h2 id={`day-group-${group.category}`}>{dayLabels[group.category]}</h2>
                          <span className="muted">{group.events.length} 个</span>
                        </div>
                        <p className="muted">{dayOrderHints[group.category]}</p>
                      </header>
                      <DayCards events={group.events} today={today} onEdit={openEvent} onDelete={setDeleting} />
                    </section>
                  ))}
                  {invalid.length > 0 && (
                    <section className="day-group" aria-labelledby="day-group-invalid">
                      <header className="day-group-heading">
                        <div className="day-group-title">
                          <h2 id="day-group-invalid">待确认日期</h2>
                          <span className="muted">{invalid.length} 个</span>
                        </div>
                        <p className="muted">请打开日子检查原始日期。</p>
                      </header>
                      <DayCards events={invalid} today={today} onEdit={openEvent} onDelete={setDeleting} />
                    </section>
                  )}
                </div>
              )}
            </>
          )}
          {events.isError && hasEvents && (
            <ErrorState
              error={events.error}
              retry={() => {
                void events.refetch();
                if (books.isError) void books.refetch();
              }}
            />
          )}
        </>
      )}
      {bookDialog && (
        <DayBookDialog
          book={bookDialog === 'new' ? undefined : bookDialog}
          onClose={() => setBookDialog(null)}
          onCreated={selectBook}
        />
      )}
      {requestedEvent && selected && !eventDialog && (
        <LinkedDayDialog
          key={`${selected.id}:${requestedEvent}`}
          book={selected}
          eventId={requestedEvent}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete('event');
            next.set('book', selected.id);
            setParams(next, { replace: true });
          }}
        />
      )}
      {eventDialog && selected && (
        <DayEventDialog
          analyticsContext={eventFlow}
          key={eventDialog === 'new' ? selected.id : eventDialog.id}
          event={eventDialog === 'new' ? undefined : eventDialog}
          book={selected}
          onClose={() => setEventDialog(null)}
        />
      )}
      {deletingBook && (
        <DeleteDayBookDialog
          book={deletingBook}
          onClose={() => setDeletingBook(null)}
          onDeleted={() => setParams({})}
        />
      )}
      {deleting && <DeleteDayDialog event={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

/** 每个分组独立排布卡片，保留统一的查看、编辑与删除入口。 */
function DayCards({
  events,
  today,
  onEdit,
  onDelete,
}: {
  events: readonly DayEvent[];
  today: string;
  onEdit: (event: DayEvent) => void;
  onDelete: (event: DayEvent) => void;
}) {
  return (
    <div className="days-grid">
      {events.map((event) => {
        const summary = daySummary(event, today);
        return (
          <article className={`panel day-card day-${event.category}`} key={event.id}>
            <button type="button" className="card-main" onClick={() => onEdit(event)} aria-label={`编辑 ${event.name}`}>
              <span className="badge">{dayLabels[event.category]}</span>
              <h3>{event.name}</h3>
              <div className="day-count">
                {summary.value}
                <small>{summary.label}</small>
              </div>
              <p className="muted">{summary.detail}</p>
              <small className="muted">{dateLabel(event.event ?? event.start)}</small>
            </button>
            <div className="toolbar day-card-footer">
              <Button variant="ghost" size="sm" onClick={() => onEdit(event)}>
                <Pencil size={14} />
                编辑
              </Button>
              <Button variant="ghost" size="sm" aria-label={`删除 ${event.name}`} onClick={() => onDelete(event)}>
                <Trash2 size={16} />
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/** 日子本重命名保留原创建时间，幂等标识在网络重试时不变。 */
function DayBookDialog({
  book,
  onClose,
  onCreated,
}: {
  book?: DayBook;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  useProductAnalyticsPage('days.books.edit');
  const [name, setName] = useState(book?.name ?? '');
  const [validation, setValidation] = useState('');
  const [id] = useState(() => book?.id ?? crypto.randomUUID());
  const [createdAt] = useState(() => book?.created_at ?? new Date().toISOString());
  const attempt = useRef({ name: '', mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString() });
  const save = useMutation({
    mutationFn: async () => {
      if (attempt.current.name !== name.trim())
        attempt.current = { name: name.trim(), mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString() };
      await pushChange({
        mutation_id: attempt.current.mutationId,
        entity_type: 'day_book',
        entity_id: id,
        ledger_id: null,
        day_book_id: id,
        sync_id: book?.sync_id,
        base_revision: book?.revision ?? 0,
        updated_at: attempt.current.updatedAt,
        action: 'upsert',
        payload: { name: name.trim(), created_at: createdAt },
      });
    },
  });
  const { close, confirmation, finish } = useDraftClose(name !== (book?.name ?? ''), save.isPending, onClose);
  /** 本地先检查名称，服务端继续执行权威的 Unicode 语义校验。 */
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || Array.from(name.trim()).length > 100) {
      setValidation('请输入 1 至 100 个字的名称');
      return;
    }
    setValidation('');
    save.mutate(undefined, { onSuccess: () => finish(() => onCreated(id)) });
  }
  return (
    <Dialog open onClose={close} title={book ? '重命名日子本' : '新建日子本'}>
      <form className="stack" onSubmit={submit}>
        <Field label="名称" error={validation}>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={save.isPending}
            placeholder="例如：生活里的重要时刻"
          />
        </Field>
        {save.isError && <ErrorState error={save.error} />}
        <div className="dialog-actions">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? '保存中…' : '保存本子'}
          </Button>
        </div>
      </form>
      {confirmation}
    </Dialog>
  );
}

/** 原始农历日期可编辑，投影只作为说明显示，不能手动覆盖。 */
function DateField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: DayDate;
  onChange: (value: DayDate) => void;
  disabled: boolean;
}) {
  const [error, setError] = useState('');
  let projection = '';
  try {
    projection = projectDate(value).solar_date;
  } catch {
    projection = '请检查日期';
  }
  /** 切换历法沿用当前真实日期；输入非法时保留原输入供修正。 */
  function changeCalendar(calendar: DayDate['calendar_type']) {
    try {
      onChange(convertCalendar(value, calendar));
      setError('');
    } catch {
      setError('请先补全一个有效日期，再切换历法');
    }
  }
  return (
    <fieldset className="date-field">
      <legend>{label}</legend>
      <div className="form-grid">
        <Field label={`${label}历法`}>
          <select
            value={value.calendar_type}
            disabled={disabled}
            onChange={(event) => changeCalendar(event.target.value as DayDate['calendar_type'])}
          >
            <option value="solar">公历</option>
            <option value="lunar">农历</option>
          </select>
        </Field>
        {value.calendar_type === 'solar' ? (
          <Field label={label}>
            <input
              type="date"
              min="1901-01-01"
              max="2100-12-31"
              value={value.solar_date}
              disabled={disabled}
              required
              onChange={(event) => {
                const [year = 0, month = 0, day = 0] = event.target.value.split('-').map(Number);
                onChange({
                  ...value,
                  solar_date: event.target.value,
                  original_year: year,
                  original_month: month,
                  original_day: day,
                });
                setError('');
              }}
            />
          </Field>
        ) : (
          <>
            <Field label={`${label}农历年`}>
              <input
                type="number"
                min={1900}
                max={2100}
                step={1}
                value={value.original_year || ''}
                required
                disabled={disabled}
                onChange={(event) => onChange({ ...value, original_year: Number(event.target.value) })}
              />
            </Field>
            <Field label={`${label}农历月`}>
              <select
                value={value.original_month}
                disabled={disabled}
                onChange={(event) => onChange({ ...value, original_month: Number(event.target.value) })}
              >
                {Array.from({ length: 12 }, (_, index) => (
                  <option key={index} value={index + 1}>
                    {index + 1} 月
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`${label}农历日`}>
              <input
                type="number"
                min={1}
                max={30}
                step={1}
                value={value.original_day || ''}
                required
                disabled={disabled}
                onChange={(event) => onChange({ ...value, original_day: Number(event.target.value) })}
              />
            </Field>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={value.is_leap_month}
                disabled={disabled}
                onChange={(event) => onChange({ ...value, is_leap_month: event.target.checked })}
              />
              闰月
            </label>
          </>
        )}
      </div>
      {value.calendar_type === 'lunar' && <p className="muted">对应公历：{projection}</p>}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** 类别切换只整理提交载荷，不破坏其他端保存的原始历法和创建时间。 */
function DayEventDialog({
  event: currentEvent,
  book: currentBook,
  onClose,
  analyticsContext,
}: {
  event?: DayEvent;
  book: DayBook;
  onClose: () => void;
  analyticsContext?: ProductAnalyticsContext | null;
}) {
  // 编辑期间保持起始修订号，其他设备写入后服务端必须继续拒绝覆盖。
  const [book] = useState(currentBook);
  const [event] = useState(currentEvent);
  const { session } = useSession();
  const analyticsAccountId = session?.user.user_id ?? '';
  const saveContext = useRef<ProductAnalyticsContext | null>(null);
  useProductAnalyticsPage('days.editor', true, 2, analyticsContext);
  const [initial] = useState<DayDefinition>(() =>
    event
      ? {
          name: event.name,
          category: event.category,
          countdown_mode: event.countdown_mode,
          interval_days: event.interval_days,
          repeat_type: event.repeat_type,
          statistic_type: event.statistic_type,
          event: event.event,
          start: event.start,
          end: event.end,
          created_at: event.created_at,
        }
      : {
          name: '',
          category: 'anniversary',
          countdown_mode: null,
          interval_days: null,
          repeat_type: 'yearly',
          statistic_type: 'day',
          event: solarDate(todayDate()),
          start: null,
          end: null,
          created_at: new Date().toISOString(),
        },
  );
  const [draft, setDraft] = useState(initial);
  const [validation, setValidation] = useState('');
  const [id] = useState(() => event?.id ?? crypto.randomUUID());
  const attempt = useRef({ signature: '', mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString() });
  const save = useMutation({
    mutationFn: async (payload: DayDefinition) => {
      const signature = JSON.stringify(payload);
      if (attempt.current.signature !== signature)
        attempt.current = { signature, mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString() };
      await pushChange({
        mutation_id: attempt.current.mutationId,
        entity_type: 'day_event',
        entity_id: id,
        ledger_id: null,
        day_book_id: book.id,
        sync_id: event?.sync_id ?? book.sync_id,
        base_revision: event?.revision ?? 0,
        updated_at: attempt.current.updatedAt,
        action: 'upsert',
        payload,
      });
    },
    onSuccess: () => {
      // 一次持久化只记录一条完成事件，原记录是否存在决定新建或编辑口径。
      trackProductAction(
        event ? 'days_event_saved' : 'days_event_created',
        'days.editor',
        analyticsAccountId,
        saveContext.current,
      );
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const { close, confirmation, finish } = useDraftClose(dirty, save.isPending, onClose);
  const starting =
    draft.category === 'stage' || (draft.category === 'countdown' && draft.countdown_mode === 'interval_days');
  /** 保留表单输入并展示日期错误，不向服务端发送未经投影校验的日期。 */
  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    try {
      if (!draft.name.trim() || Array.from(draft.name.trim()).length > 100)
        throw new Error('请输入 1 至 100 个字的名称');
      const payload = buildDefinition(draft);
      setValidation('');
      save.mutate(payload, { onSuccess: () => finish() });
    } catch (error) {
      setValidation(error instanceof Error ? error.message : '请检查日期填写是否完整');
    }
  }
  return (
    <Dialog open title={event ? '编辑日子' : '添加一个重要日子'} description={book.name} onClose={close}>
      <form
        className="stack"
        onSubmit={submit}
        onSubmitCapture={() => {
          if (save.isPending) return;
          saveContext.current = captureProductAnalyticsContext(analyticsContext);
          trackProductAction('days_event_save_click', 'days.editor', analyticsAccountId, saveContext.current);
        }}
      >
        <Field label="名称">
          <input
            autoFocus
            required
            value={draft.name}
            disabled={save.isPending}
            placeholder="例如：开始跑步的日子"
            onChange={(input) => setDraft({ ...draft, name: input.target.value })}
          />
        </Field>
        <div className="form-grid">
          <Field label="类型">
            <select
              value={draft.category}
              disabled={save.isPending}
              onChange={(input) => {
                const category = input.target.value as DayEvent['category'];
                setDraft({
                  ...draft,
                  category,
                  event: draft.event ?? solarDate(todayDate()),
                  start: draft.start ?? solarDate(todayDate()),
                  countdown_mode:
                    category === 'countdown' ? (draft.countdown_mode ?? 'fixed_date') : draft.countdown_mode,
                });
              }}
            >
              {Object.entries(dayLabels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="统计方式">
            <select
              value={draft.statistic_type}
              disabled={save.isPending}
              onChange={(input) =>
                setDraft({ ...draft, statistic_type: input.target.value as DayEvent['statistic_type'] })
              }
            >
              <option value="day">按天</option>
              <option value="year">按年月日</option>
            </select>
          </Field>
        </div>
        {draft.category === 'countdown' && (
          <Field label="倒数方式">
            <select
              value={draft.countdown_mode ?? 'fixed_date'}
              disabled={save.isPending}
              onChange={(input) =>
                setDraft({
                  ...draft,
                  countdown_mode: input.target.value as DayEvent['countdown_mode'],
                  event: draft.event ?? solarDate(todayDate()),
                  start: draft.start ?? solarDate(todayDate()),
                  interval_days: draft.interval_days ?? 30,
                })
              }
            >
              <option value="fixed_date">指定目标日期</option>
              <option value="interval_days">从起日计算天数</option>
            </select>
          </Field>
        )}
        <DateField
          label={starting ? '开始日期' : draft.category === 'birthday' ? '出生日期' : '日期'}
          value={(starting ? draft.start : draft.event) ?? solarDate(todayDate())}
          disabled={save.isPending}
          onChange={(value) => setDraft({ ...draft, [starting ? 'start' : 'event']: value })}
        />
        {draft.category === 'countdown' && draft.countdown_mode === 'interval_days' && (
          <Field label="间隔天数" hint="包含开始当天，不自动循环。">
            <input
              type="number"
              min={1}
              max={36500}
              step={1}
              required
              value={draft.interval_days ?? ''}
              disabled={save.isPending}
              onChange={(input) => setDraft({ ...draft, interval_days: Number(input.target.value) })}
            />
          </Field>
        )}
        {draft.category === 'stage' && (
          <>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={draft.end !== null}
                disabled={save.isPending}
                onChange={(input) =>
                  setDraft({ ...draft, end: input.target.checked ? (draft.start ?? solarDate(todayDate())) : null })
                }
              />
              设置结束日期
            </label>
            {draft.end && (
              <DateField
                label="结束日期"
                value={draft.end}
                disabled={save.isPending}
                onChange={(value) => setDraft({ ...draft, end: value })}
              />
            )}
          </>
        )}
        {(draft.category === 'birthday' || draft.category === 'anniversary') && (
          <div className="day-date-help">
            <p className="day-date-help-title">日期计算规则</p>
            <p className="muted">
              每年纪念一次；公历 2 月 29 日在平年按 2 月末计算，农历闰月只在相应闰月出现的年份计算。
            </p>
          </div>
        )}
        {validation && (
          <p className="field-error" role="alert">
            {validation}
          </p>
        )}
        {save.isError && <ErrorState error={save.error} />}
        <div className="dialog-actions">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? '保存中…' : '保存日子'}
          </Button>
        </div>
      </form>
      {confirmation}
    </Dialog>
  );
}

/** 删除确认携带修订号，避免删除其他设备的新修改。 */
function DeleteDayDialog({ event, onClose }: { event: DayEvent; onClose: () => void }) {
  const { session } = useSession();
  const accountId = session?.user.user_id ?? '';
  const [mutationId] = useState(() => crypto.randomUUID());
  const [updatedAt] = useState(() => new Date().toISOString());
  const remove = useMutation({
    mutationFn: async (context: ProductAnalyticsContext | null) => {
      await pushChange({
        mutation_id: mutationId,
        entity_type: 'day_event',
        entity_id: event.id,
        ledger_id: null,
        day_book_id: event.day_book_id,
        sync_id: event.sync_id,
        base_revision: event.revision,
        updated_at: updatedAt,
        action: 'delete',
        payload: {},
      });
      trackProductAction('days_event_deleted', 'days', accountId, context);
    },
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      title="删除这个日子？"
      description={`“${event.name}”将从云端删除，并同步到其他设备。`}
      onClose={() => {
        if (!remove.isPending) onClose();
      }}
    >
      {remove.isError && <ErrorState error={remove.error} />}
      <div className="dialog-actions">
        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={() => remove.mutate(captureProductAnalyticsContext())}
        >
          {remove.isPending ? '删除中…' : '确认删除'}
        </Button>
      </div>
    </Dialog>
  );
}

/** 深链读取完整本子，避免分页外的日子被误报不存在。 */
function LinkedDayDialog({ book, eventId, onClose }: { book: DayBook; eventId: string; onClose: () => void }) {
  const { session } = useSession();
  const [resolved, setResolved] = useState<DayEvent>();
  const full = useQuery({
    queryKey: ['account', session!.user.user_id, 'day-deep-link', book.id, book.sync_id, eventId],
    gcTime: 0,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/day-books/full', {
          signal,
          params: { query: { day_book_id: book.id, sync_id: book.sync_id } },
        }),
      ),
  });
  const found = full.data?.day_events.find((event) => event.id === eventId && !event.deleted_at);
  useEffect(() => {
    if (found) setResolved((current) => current ?? found);
  }, [found]);
  if (resolved) return <DayEventDialog book={book} event={resolved} onClose={onClose} />;
  return (
    <Dialog open title="打开日子" onClose={onClose}>
      {full.isPending || found ? (
        <LoadingState />
      ) : full.isError ? (
        <ErrorState
          error={full.error}
          retry={() => {
            void full.refetch();
          }}
        />
      ) : (
        <EmptyState title="找不到这个日子" description="记录可能已删除，或链接所属本子不正确。" />
      )}
    </Dialog>
  );
}
