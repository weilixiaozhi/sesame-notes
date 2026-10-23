import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useDraftClose } from '../../components/use-draft-close';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { GripVertical, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { unwrap } from '@sesame-notes/api-client';
import { api, captureSessionOperation, pushChange, useSession } from '../../lib/session';
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
import { recalledMemoBook, rememberMemoBook } from './memo-selection';
import { MemoEditor } from './memo-editor';
import './memos-page.css';
import { MemoExport } from './memo-export';
import { MemoImport } from './memo-import';
import { MemoDocumentExport } from './memo-document';
import { CredentialExport } from './memo-credential-export';
import { DeleteMemoBookDialog } from './delete-memo-book-dialog';
import { useCredentialReorder } from './memo-reorder';
import { nextCredentialOrderKey } from './memo-order';
import {
  deltaSchema,
  emptyDelta,
  fieldsSchema,
  hasVisibleText,
  isWellFormed,
  logMemoError,
  memoPreview,
  type MemoBook,
  type MemoDelta,
  type MemoEntry,
  type MemoFields,
} from './memo-content';

const bookFormSchema = z.object({
  name: z
    .string()
    .trim()
    .refine(hasVisibleText, '请输入本子名称')
    .refine((value) => Array.from(value).length <= 100, '名称最多 100 个字'),
  type: z.enum(['normal', 'credentials']),
});
type MemoType = MemoBook['type'];
type MemoSort = 'updated' | 'title' | 'manual';

/** 完整本子记录共用名称搜索和排序，避免分页之外的记录遗漏。 */
export function MemosPage() {
  const { session } = useSession();
  const accountId = session!.user.user_id;
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [bookDialog, setBookDialog] = useState<MemoBook | 'new' | null>(null);
  const [entryDialog, setEntryDialog] = useState<MemoEntry | 'new' | null>(null);
  const [entryFlow, setEntryFlow] = useState<ProductAnalyticsContext | null>(null);
  const firstEntryFlow = useRef<ProductAnalyticsContext | null>(null);
  const [deleting, setDeleting] = useState<MemoEntry | null>(null);
  const [deletingBook, setDeletingBook] = useState<MemoBook | null>(null);
  const [search, setSearch] = useState('');
  const pageActive = useRef(true);
  const provisionBooks = useMemo(
    () => ({
      normal: createDefaultBookProvisioner('memos', accountId),
      credentials: createDefaultBookProvisioner('memos', accountId, 'credentials'),
    }),
    [accountId],
  );
  useEffect(() => {
    pageActive.current = true;
    return () => {
      pageActive.current = false;
    };
  }, []);
  const firstEntry = useMutation({
    /** 仅用户点击时准备可用本子，失败保留入口，重复点击由待处理状态阻止。 */
    mutationFn: async (type: MemoType) => {
      try {
        return await provisionBooks[type]();
      } catch (error) {
        console.error('准备第一条备忘录失败', { accountId, type, error });
        throw error;
      }
    },
    onSuccess: (bookId, type) => {
      // 云端目录已进入查询缓存，使用真实本子身份直接打开内容编辑器。
      if (!pageActive.current) return;
      openBook(bookId, type);
      setEntryDialog('new');
      setEntryFlow(firstEntryFlow.current);
    },
  });
  const books = useQuery({
    queryKey: ['account', session!.user.user_id, 'memo-books'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/sync/memo-books', { signal })),
  });
  const requestedBook = params.get('book');
  const requestedEntry = params.get('entry');
  // 两类入口各自只选择同类型本子，地址中的本子身份不能改变当前业务入口。
  const activeType: MemoType = location.pathname === '/credentials' ? 'credentials' : 'normal';
  const linkedBook = books.data?.memo_books.find((book) => book.id === requestedBook && book.type === activeType);
  const sort: MemoSort =
    params.get('sort') === 'title'
      ? 'title'
      : params.get('sort') === 'updated'
        ? 'updated'
        : activeType === 'credentials'
          ? 'manual'
          : 'updated';
  const visibleBooks = books.data?.memo_books.filter((book) => book.type === activeType) ?? [];
  const selected = requestedBook
    ? linkedBook
    : (visibleBooks.find((book) => book.id === recalledMemoBook(client, accountId, activeType)) ?? visibleBooks[0]);
  const canonicalPath = activeType === 'credentials' ? '/credentials' : '/memos';
  useEffect(() => {
    if (selected) rememberMemoBook(client, accountId, selected.type, selected.id);
  }, [client, accountId, selected]);

  /** 显式选择在对应业务入口打开当前类型的本子。 */
  function openBook(id: string, type: MemoType) {
    navigate({
      pathname: type === 'credentials' ? '/credentials' : '/memos',
      search: `?book=${encodeURIComponent(id)}`,
    });
  }

  /** 同类型下显式选本时同步记录选择，类型间往返不会跳到另一类的容器。 */
  function selectBook(id: string) {
    trackProductAction(
      activeType === 'credentials' ? 'credentials_book_select' : 'memos_book_select',
      activeType === 'credentials' ? 'credentials' : 'memos',
    );
    openBook(id, activeType);
  }

  /** 创建入口与已有记录入口只在用户实际打开时记点击，记录标题和正文不参与埋点。 */
  function openEntry(entry: MemoEntry | 'new'): void {
    try {
      const creating = entry === 'new';
      const context = beginProductAnalyticsFlow();
      trackProductAction(
        activeType === 'credentials'
          ? creating
            ? 'credentials_create_click'
            : 'credentials_open_click'
          : creating
            ? 'memos_note_create_click'
            : 'memos_note_open_click',
        activeType === 'credentials' ? 'credentials' : 'memos',
        accountId,
        context,
      );
      setEntryFlow(context);
      setEntryDialog(entry);
    } catch (error) {
      logMemoError('打开记录失败', error);
    }
  }
  /** 排序方式写入地址，刷新页面仍使用当前选择，其他深链参数保持完整。 */
  function changeSort(value: MemoSort) {
    try {
      if (value === 'manual' && !params.has('sort')) return;
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === 'manual' || (value === 'updated' && activeType === 'normal')) next.delete('sort');
          else next.set('sort', value);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    } catch (error) {
      logMemoError('切换记录排序失败', error, { accountId });
    }
  }
  const entries = useQuery({
    queryKey: ['account', accountId, 'memo-entries', selected?.id, selected?.sync_id],
    enabled: !!selected && !deletingBook,
    queryFn: async ({ signal }) => {
      try {
        return unwrap(
          await api.GET('/api/v1/sync/memo-books/full', {
            signal,
            params: { query: { memo_book_id: selected!.id, sync_id: selected!.sync_id } },
          }),
        );
      } catch (error) {
        logMemoError('读取本子记录失败', error, { accountId, bookId: selected!.id });
        throw error;
      }
    },
  });
  const fullEntries = useMemo(() => entries.data?.memo_entries ?? [], [entries.data]);
  const rows = useMemo(() => {
    const keyword = search.trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
    // 只搜索记录名称；字段值和正文不会影响名称搜索结果。
    return [...fullEntries]
      .filter((entry) => entry.title.normalize('NFKC').toLocaleLowerCase('zh-CN').includes(keyword))
      .sort((left, right) => compareMemoEntries(left, right, sort));
  }, [fullEntries, search, sort]);
  const reorder = useCredentialReorder({
    book: activeType === 'credentials' ? selected : undefined,
    entries: fullEntries,
    visibleEntries: rows,
    onSaved: () => changeSort('manual'),
  });
  const displayedRows = activeType === 'credentials' ? reorder.visibleEntries : rows;
  return (
    <div className="stack memos-page">
      <PageHeading title={activeType === 'credentials' ? '账号密码' : '备忘录'} />
      {books.isError && books.data !== undefined && (
        <ErrorState error={books.error} retry={() => void books.refetch()} />
      )}
      {firstEntry.isError && (
        <ErrorState error={firstEntry.error} retry={() => firstEntry.mutate(firstEntry.variables ?? activeType)} />
      )}
      {books.isPending ? (
        <LoadingState label={activeType === 'credentials' ? '正在读取账号密码本…' : '正在读取备忘录本…'} />
      ) : books.isError && books.data === undefined ? (
        <ErrorState
          error={books.error}
          retry={() => {
            void books.refetch();
          }}
        />
      ) : requestedBook && !selected ? (
        <EmptyState
          title={activeType === 'credentials' ? '找不到这个账号密码本' : '找不到这个备忘录本'}
          description="本子可能已删除，或当前账号没有访问权限。"
          action={<Button onClick={() => navigate(canonicalPath)}>返回我的本子</Button>}
        />
      ) : !selected ? (
        <EmptyState
          title={activeType === 'credentials' ? '把常用账号收在一起' : '记下此刻的想法'}
          description={
            activeType === 'credentials'
              ? '账号、密码和登录备注，按卡片整理。'
              : '灵感、清单或随手一记，都可以从这里开始。'
          }
          action={
            <Button
              disabled={firstEntry.isPending}
              onClick={() => {
                firstEntryFlow.current = beginProductAnalyticsFlow();
                trackProductAction(
                  activeType === 'credentials' ? 'credentials_create_click' : 'memos_note_create_click',
                  activeType === 'credentials' ? 'credentials' : 'memos',
                  accountId,
                  firstEntryFlow.current,
                );
                firstEntry.mutate(activeType);
              }}
            >
              <Plus size={16} />
              {firstEntry.isPending ? '正在打开…' : activeType === 'credentials' ? '新建账号卡片' : '写第一条备忘录'}
            </Button>
          }
        />
      ) : (
        <>
          <BookWorkspaceHeader
            key={`${activeType}:${selected.id}`}
            label="本子管理"
            disabled={firstEntry.isPending || reorder.locked}
            selector={
              <BookTabs
                label={activeType === 'credentials' ? '账号密码本' : '备忘录本'}
                items={visibleBooks}
                value={selected.id}
                onSelect={selectBook}
                disabled={firstEntry.isPending || reorder.locked}
              />
            }
            actions={
              <>
                <label className="memo-name-search">
                  <Search size={16} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="名称搜索"
                    placeholder="搜索名称"
                    value={search}
                    disabled={reorder.locked}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <select
                  aria-label="排序方式"
                  className="memo-sort-select"
                  value={sort === 'manual' ? '' : sort}
                  disabled={reorder.locked}
                  onChange={(event) => changeSort(event.target.value as MemoSort)}
                >
                  {activeType === 'credentials' && (
                    <option value="" disabled>
                      排序方式
                    </option>
                  )}
                  <option value="updated">最近编辑</option>
                  <option value="title">名称</option>
                </select>
                <div className="memo-create-action">
                  <Button disabled={reorder.locked} onClick={() => openEntry('new')}>
                    <Plus size={16} />
                    {activeType === 'credentials' ? '新建账号卡片' : '写一条备忘录'}
                  </Button>
                </div>
              </>
            }
            sections={[
              {
                id: 'create',
                title: '新建',
                content: (
                  <Button variant="ghost" onClick={() => setBookDialog('new')} disabled={firstEntry.isPending}>
                    <Plus size={16} />
                    新建本子
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
                    <MemoImport book={selected} />
                    <MemoExport book={selected} />
                    {selected.type === 'credentials' && <CredentialExport book={selected} />}
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
          {activeType === 'credentials' && reorder.pending && (
            <p className="muted memo-reorder-progress" role="status">
              正在保存顺序
              {reorder.progress.total > 0 ? ` ${reorder.progress.completed} / ${reorder.progress.total}` : '…'}
            </p>
          )}
          {activeType === 'credentials' && reorder.error !== null && (
            <div className="stack memo-reorder-error">
              <ErrorState error={reorder.error} />
              <div className="toolbar">
                <p className="muted">
                  {reorder.conflicted
                    ? '卡片已发生变化，请重新加载后再拖动。'
                    : '当前调整已保留，重试会继续保存未完成的卡片。'}
                </p>
                {!reorder.conflicted && <Button onClick={() => void reorder.retry()}>重试保存</Button>}
                <Button variant="secondary" onClick={() => void reorder.discard()}>
                  重新加载
                </Button>
              </div>
            </div>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {reorder.announcement}
          </span>
          {entries.isPending ? (
            <LoadingState />
          ) : entries.isError && !entries.data ? (
            <ErrorState
              error={entries.error}
              retry={() => {
                void entries.refetch();
              }}
            />
          ) : displayedRows.length === 0 ? (
            <EmptyState
              title={search.trim() ? '没有匹配的记录' : selected.type === 'credentials' ? '暂无账号卡片' : '暂无备忘录'}
              description={search.trim() ? '试试其他名称。' : undefined}
            />
          ) : (
            <div className="memo-grid">
              {displayedRows.map((entry) => (
                <article
                  {...(activeType === 'credentials' ? reorder.rowProps(entry) : {})}
                  className={`panel memo-card${activeType === 'credentials' ? ' memo-credential-card memo-credential-draggable' : ''}${reorder.dragged === entry.id ? ' memo-is-dragging' : ''}`}
                  key={entry.id}
                >
                  {activeType === 'credentials' && (
                    <button
                      {...reorder.handleProps(entry)}
                      type="button"
                      className="memo-reorder-grip button button-ghost button-sm"
                      aria-label={`拖动 ${entry.title || '无标题卡片'}`}
                    >
                      <GripVertical size={18} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="card-main"
                    disabled={reorder.locked}
                    onClick={() => openEntry(entry)}
                    aria-label={`打开 ${entry.title || (activeType === 'credentials' ? '无标题卡片' : '无标题备忘录')}`}
                  >
                    <h3>{entry.title || (activeType === 'credentials' ? '无标题卡片' : '无标题备忘录')}</h3>
                    {memoPreview(entry) && <p className="memo-preview">{memoPreview(entry)}</p>}
                  </button>

                  <div className="toolbar memo-card-footer">
                    <MemoDocumentExport entry={entry} />
                    <small className="muted">{new Date(entry.updated_at).toLocaleDateString('zh-CN')} 更新</small>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleting(entry)}
                      disabled={reorder.locked}
                      aria-label={`删除 ${entry.title || (activeType === 'credentials' ? '无标题卡片' : '无标题备忘录')}`}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {entries.isError && entries.data && (
            <ErrorState
              error={entries.error}
              retry={() => {
                void entries.refetch();
              }}
            />
          )}
        </>
      )}
      {bookDialog && (
        <MemoBookDialog
          book={bookDialog === 'new' ? undefined : bookDialog}
          initialType={activeType}
          onClose={() => setBookDialog(null)}
          onCreated={(id, type) => {
            openBook(id, type);
          }}
        />
      )}
      {requestedEntry && selected && !entryDialog && (
        <LinkedMemoDialog
          key={`${selected.id}:${requestedEntry}`}
          book={selected}
          entryId={requestedEntry}
          onClose={() => setParams({ book: selected.id }, { replace: true })}
        />
      )}
      {entryDialog && selected && (
        <MemoEntryDialog
          key={entryDialog === 'new' ? selected.id : entryDialog.id}
          analyticsContext={entryFlow}
          book={selected}
          entry={entryDialog === 'new' ? undefined : entryDialog}
          onClose={() => setEntryDialog(null)}
        />
      )}
      {deletingBook && (
        <DeleteMemoBookDialog
          book={deletingBook}
          onClose={() => setDeletingBook(null)}
          onDeleted={() => navigate(deletingBook.type === 'credentials' ? '/credentials' : '/memos')}
        />
      )}
      {deleting && <DeleteMemoDialog entry={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

/** 手动顺序使用同步键，时间和名称排序各自独立，同值时按身份稳定排列。 */
function compareMemoEntries(left: MemoEntry, right: MemoEntry, sort: MemoSort): number {
  try {
    if (sort === 'manual') {
      const leftKey = left.order_key === null ? null : BigInt(left.order_key);
      const rightKey = right.order_key === null ? null : BigInt(right.order_key);
      if (leftKey !== rightKey) {
        if (leftKey === null) return 1;
        if (rightKey === null) return -1;
        return leftKey < rightKey ? -1 : 1;
      }
    } else if (sort === 'title') {
      const nameOrder = left.title.localeCompare(right.title, 'zh-CN', { numeric: true, sensitivity: 'base' });
      if (nameOrder) return nameOrder;
    } else {
      const timeOrder = Date.parse(right.updated_at) - Date.parse(left.updated_at);
      if (timeOrder) return timeOrder;
    }
    return left.id.localeCompare(right.id);
  } catch (error) {
    logMemoError('比较记录顺序失败', error, { leftId: left.id, rightId: right.id, sort });
    return left.id.localeCompare(right.id);
  }
}

/** 本子类型创建后固定，重命名只更新名称与审计时间。 */
function MemoBookDialog({
  book,
  initialType,
  onClose,
  onCreated,
}: {
  book?: MemoBook;
  initialType: MemoType;
  onClose: () => void;
  onCreated: (id: string, type: MemoType) => void;
}) {
  useProductAnalyticsPage(
    (book?.type ?? initialType) === 'credentials' ? 'credentials.books.edit' : 'memos.books.edit',
  );
  const form = useForm<z.infer<typeof bookFormSchema>>({
    resolver: zodResolver(bookFormSchema),
    defaultValues: { name: book?.name ?? '', type: book?.type ?? initialType },
  });
  const [id] = useState(() => book?.id ?? crypto.randomUUID());
  const [createdAt] = useState(() => book?.created_at ?? new Date().toISOString());
  const attempt = useRef({ signature: '', mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString() });
  const save = useMutation({
    mutationFn: async (values: z.infer<typeof bookFormSchema>) => {
      const signature = JSON.stringify(values);
      if (attempt.current.signature !== signature)
        attempt.current = { signature, mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString() };
      await pushChange({
        mutation_id: attempt.current.mutationId,
        entity_type: 'memo_book',
        entity_id: id,
        ledger_id: null,
        day_book_id: null,
        memo_book_id: id,
        sync_id: book?.sync_id,
        base_revision: book?.revision ?? 0,
        updated_at: attempt.current.updatedAt,
        action: 'upsert',
        payload: { ...values, created_at: createdAt, updated_at: attempt.current.updatedAt },
      });
    },
  });
  const { close, confirmation, finish } = useDraftClose(form.formState.isDirty, save.isPending, onClose);
  return (
    <Dialog
      open
      title={book ? '重命名本子' : initialType === 'credentials' ? '新建账号密码本' : '新建备忘录本'}
      onClose={close}
    >
      <form
        className="stack"
        onSubmit={form.handleSubmit((values) =>
          save.mutate(values, { onSuccess: () => finish(() => onCreated(id, values.type)) }),
        )}
      >
        <Field label="名称" error={form.formState.errors.name?.message}>
          <input
            autoFocus
            {...form.register('name')}
            disabled={save.isPending}
            placeholder={initialType === 'credentials' ? '例如：常用账号' : '例如：生活随记'}
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

/** 将文本和字段保存在弹窗内存中；失败后保留输入与幂等键供重试。 */
function MemoEntryDialog({
  book: currentBook,
  entry: currentEntry,
  analyticsContext,
  onClose,
}: {
  book: MemoBook;
  entry?: MemoEntry;
  analyticsContext?: ProductAnalyticsContext | null;
  onClose: () => void;
}) {
  // 编辑期间固定读到的版本，后台刷新不能把旧草稿配上最新修订号。
  const [book] = useState(currentBook);
  const [entry] = useState(currentEntry);
  const { session } = useSession();
  const analyticsAccountId = session?.user.user_id ?? '';
  const analyticsPage = book.type === 'credentials' ? 'credentials.editor' : 'memos.editor';
  useProductAnalyticsPage(analyticsPage, true, 2, analyticsContext);
  const saveContext = useRef<ProductAnalyticsContext | null>(null);
  const [title, setTitle] = useState(entry?.title ?? '');
  const [initial] = useState(() => deltaSchema.safeParse(entry?.body ?? emptyDelta));
  const [initialFields] = useState(() =>
    fieldsSchema.safeParse(
      entry?.body ?? {
        fields: [
          { label: '账号', value: '' },
          { label: '密码', value: '' },
        ],
      },
    ),
  );
  const [body, setBody] = useState<MemoDelta>(initial.success ? initial.data : emptyDelta);
  const [fields, setFields] = useState<MemoFields>(initialFields.success ? initialFields.data.fields : []);
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [id] = useState(() => entry?.id ?? crypto.randomUUID());
  const [createdAt] = useState(() => entry?.created_at ?? new Date().toISOString());
  const attempt = useRef<{
    signature: string;
    mutationId: string;
    updatedAt: string;
    orderKey?: string | null;
    operation?: ReturnType<typeof captureSessionOperation>;
  }>({ signature: '', mutationId: crypto.randomUUID(), updatedAt: new Date().toISOString() });
  const readable = book.type === 'normal' ? initial.success : initialFields.success;
  const save = useMutation({
    mutationFn: async () => {
      try {
        const content = book.type === 'normal' ? deltaSchema.parse(body) : fieldsSchema.parse({ fields });
        const signature = JSON.stringify({ title, content });
        if (attempt.current.signature !== signature) {
          attempt.current = {
            signature,
            mutationId: crypto.randomUUID(),
            updatedAt: new Date().toISOString(),
            orderKey: book.type === 'normal' ? null : entry?.order_key,
            operation: captureSessionOperation(analyticsAccountId),
          };
        }
        const operation = (attempt.current.operation ??= captureSessionOperation(analyticsAccountId));
        operation.assertCurrent();
        if (attempt.current.orderKey === undefined) {
          const snapshot = unwrap(
            await operation.client.GET('/api/v1/sync/memo-books/full', {
              params: { query: { memo_book_id: book.id, sync_id: book.sync_id } },
            }),
          );
          operation.assertCurrent();
          // 已选择的顺序键与本次幂等提交一起保留，响应丢失后重试不会改写同一请求。
          attempt.current.orderKey = nextCredentialOrderKey(snapshot.memo_entries);
        }
        operation.assertCurrent();
        await pushChange({
          mutation_id: attempt.current.mutationId,
          entity_type: 'memo_entry',
          entity_id: id,
          ledger_id: null,
          day_book_id: null,
          memo_book_id: book.id,
          sync_id: entry?.sync_id ?? book.sync_id,
          base_revision: entry?.revision ?? 0,
          updated_at: attempt.current.updatedAt,
          action: 'upsert',
          payload: {
            book_type: book.type,
            title,
            body_format: book.type === 'normal' ? 'delta_v1' : 'fields_v1',
            body: content,
            order_key: attempt.current.orderKey,
            created_at: createdAt,
            updated_at: attempt.current.updatedAt,
          },
        });
      } catch (error) {
        logMemoError('保存记录失败', error, { bookId: book.id, entryId: id });
        throw error;
      }
    },
    onSuccess: () => {
      // 一次持久化只记录一条完成事件，原记录是否存在决定新建或编辑口径。
      trackProductAction(
        book.type === 'credentials'
          ? entry
            ? 'credentials_saved'
            : 'credentials_created'
          : entry
            ? 'memos_note_saved'
            : 'memos_note_created',
        analyticsPage,
        analyticsAccountId,
        saveContext.current,
      );
    },
  });
  const { close, confirmation, finish } = useDraftClose(dirty, save.isPending, onClose);
  /** 字段值不进入任何日志，错误只说明校验失败的字段位置。 */
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setValidationError('');
    if (!isWellFormed(title)) {
      setValidationError('标题包含无效字符，请重新输入。');
      return;
    }
    if (!readable || invalid) {
      setValidationError('正文包含暂不支持的格式，请检查格式后重试。');
      return;
    }
    if (book.type === 'credentials') {
      const result = fieldsSchema.safeParse({ fields });
      if (!result.success) {
        setValidationError('字段名称不能为空且最多 64 个字符，字段值最多 2048 个字符。');
        return;
      }
      if (!hasVisibleText(title) && fields.length === 0) {
        setValidationError('请输入标题或添加至少一个字段。');
        return;
      }
    }
    save.mutate(undefined, { onSuccess: () => finish() });
  }
  return (
    <Dialog
      open
      title={
        book.type === 'credentials' ? (entry ? '编辑账号卡片' : '新建账号卡片') : entry ? '编辑备忘录' : '写一条备忘录'
      }
      onClose={close}
      description={book.name}
    >
      {!readable ? (
        <EmptyState title="当前正文格式暂不支持" description="为保护原有内容，请在客户端打开这条备忘录。" />
      ) : (
        <form
          className="stack"
          onSubmit={submit}
          onSubmitCapture={() => {
            if (save.isPending) return;
            saveContext.current = captureProductAnalyticsContext(analyticsContext);
            trackProductAction(
              book.type === 'credentials' ? 'credentials_save_click' : 'memos_note_save_click',
              analyticsPage,
              analyticsAccountId,
              saveContext.current,
            );
          }}
        >
          <Field label="标题">
            <input
              autoFocus
              value={title}
              disabled={save.isPending}
              onChange={(event) => {
                setTitle(event.target.value);
                setDirty(true);
              }}
              placeholder="给这条记录起个标题"
            />
          </Field>
          {book.type === 'normal' ? (
            <MemoEditor
              initial={initial.success ? initial.data : emptyDelta}
              disabled={save.isPending}
              onChange={(value) => {
                setBody(value);
                setDirty(true);
              }}
              onInvalid={setInvalid}
            />
          ) : (
            <>
              <div>
                <span className="muted">{fields.length} / 20 个字段</span>
              </div>
              {fields.map((field, index) => (
                <div className="credential-row" key={index}>
                  <Field label={`字段 ${index + 1} 名称`}>
                    <input
                      aria-label={`字段 ${index + 1} 名称`}
                      value={field.label}
                      maxLength={64}
                      disabled={save.isPending}
                      onChange={(event) => {
                        setFields(
                          fields.map((item, position) =>
                            position === index ? { ...item, label: event.target.value } : item,
                          ),
                        );
                        setDirty(true);
                      }}
                    />
                  </Field>
                  <Field label={`字段 ${index + 1} 值`}>
                    <input
                      aria-label={`字段 ${index + 1} 值`}
                      type="text"
                      autoComplete="off"
                      value={field.value}
                      maxLength={2048}
                      disabled={save.isPending}
                      onChange={(event) => {
                        setFields(
                          fields.map((item, position) =>
                            position === index ? { ...item, value: event.target.value } : item,
                          ),
                        );
                        setDirty(true);
                      }}
                    />
                  </Field>
                  <Button
                    variant="ghost"
                    aria-label={`删除字段 ${index + 1}`}
                    disabled={save.isPending}
                    onClick={() => {
                      setFields(fields.filter((_, position) => position !== index));
                      setDirty(true);
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                disabled={fields.length >= 20 || save.isPending}
                onClick={() => {
                  setFields([...fields, { label: '', value: '' }]);
                  setDirty(true);
                }}
              >
                <Plus size={16} />
                添加字段
              </Button>
            </>
          )}
          {invalid && (
            <p role="alert" className="error-text">
              正文格式超出支持范围，请把缩进控制在 5 级以内。
            </p>
          )}
          {validationError && (
            <p role="alert" className="error-text">
              {validationError}
            </p>
          )}
          {save.isError && <ErrorState error={save.error} />}
          <div className="dialog-actions">
            <Button type="submit" disabled={save.isPending || invalid}>
              {save.isPending ? '保存中…' : book.type === 'credentials' ? '保存账号卡片' : '保存备忘录'}
            </Button>
          </div>
        </form>
      )}
      {confirmation}
    </Dialog>
  );
}

/** 删除使用当前修订号，其他设备已编辑时交给服务端拒绝覆盖。 */
function DeleteMemoDialog({ entry, onClose }: { entry: MemoEntry; onClose: () => void }) {
  const { session } = useSession();
  const accountId = session?.user.user_id ?? '';
  const [mutationId] = useState(() => crypto.randomUUID());
  const [updatedAt] = useState(() => new Date().toISOString());
  const remove = useMutation({
    mutationFn: async (context: ProductAnalyticsContext | null) => {
      await pushChange({
        mutation_id: mutationId,
        entity_type: 'memo_entry',
        entity_id: entry.id,
        ledger_id: null,
        day_book_id: null,
        memo_book_id: entry.memo_book_id,
        sync_id: entry.sync_id,
        base_revision: entry.revision,
        updated_at: updatedAt,
        action: 'delete',
        payload: {},
      });
      trackProductAction(
        entry.book_type === 'credentials' ? 'credentials_deleted' : 'memos_note_deleted',
        entry.book_type === 'credentials' ? 'credentials' : 'memos',
        accountId,
        context,
      );
    },
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      title={entry.book_type === 'credentials' ? '删除这张账号卡片？' : '删除这条备忘录？'}
      description={`“${entry.title || (entry.book_type === 'credentials' ? '无标题卡片' : '无标题备忘录')}”将从云端删除，并同步到其他设备。`}
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

/** 深链从完整快照查找目标，不依赖列表第一页；首次打开后保留编辑版本。 */
function LinkedMemoDialog({ book, entryId, onClose }: { book: MemoBook; entryId: string; onClose: () => void }) {
  const { session } = useSession();
  const [resolved, setResolved] = useState<MemoEntry>();
  const full = useQuery({
    queryKey: ['account', session!.user.user_id, 'memo-deep-link', book.id, book.sync_id, entryId],
    gcTime: 0,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/memo-books/full', {
          signal,
          params: { query: { memo_book_id: book.id, sync_id: book.sync_id } },
        }),
      ),
  });
  const found = full.data?.memo_entries.find((entry) => entry.id === entryId && !entry.deleted_at);
  useEffect(() => {
    if (found) setResolved((current) => current ?? found);
  }, [found]);
  if (resolved) return <MemoEntryDialog book={book} entry={resolved} onClose={onClose} />;
  return (
    <Dialog open title="打开备忘录" onClose={onClose}>
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
        <EmptyState title="找不到这条备忘录" description="记录可能已删除，或链接所属本子不正确。" />
      )}
    </Dialog>
  );
}
