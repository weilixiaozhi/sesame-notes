import { useEffect, useState, type ReactNode } from 'react';
import { hashKey, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';

import {
  Archive,
  ArrowLeftRight,
  ChartNoAxesCombined,
  FolderTree,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Users,
} from 'lucide-react';
import { unwrap, type components } from '@sesame-notes/api-client';
import { api, pushChange, queryClient, useSession } from '../../lib/session';
import { createDefaultBookProvisioner } from '../../app/default-book';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import {
  beginProductAnalyticsFlow,
  captureProductAnalyticsContext,
  trackProductAction,
  type ProductAnalyticsContext,
} from '../../lib/product-analytics-runtime';
import { Button, Dialog, EmptyState, ErrorState, LoadingState, PageHeading } from '../../components/ui';
import { displayAmount } from './money';
import { BookTabs } from '../../components/book-tabs';
import { BookWorkspaceHeader } from '../../components/book-workspace-header';
import { AccountingRecordAction } from './accounting-record-action';
import { TransactionEditor } from './transaction-editor';
import { TransactionDetail } from './transaction-detail';
import { TransactionNextPage } from './transaction-next-page';
import { TransactionTimeline } from './transaction-timeline';
import { LedgerEditor } from './ledger-editor';
import { CategoryManager } from './category-manager';
import { PendingOperationGuard } from './pending-operation-guard';
import { SharingDialog } from './sharing-dialog';
import { useDefaultCategoryInitialization } from './default-category-initialization';
import { CurrencyChangeDialog } from './currency-change-dialog';
import { LedgerStatistics, useAccountingFilters } from './ledger-statistics';
import { JoinLedgerDialog } from './join-ledger-dialog';

import { AaStatisticsDialog } from './aa-statistics-dialog';
import { MemberExpenseDialog } from './member-expense-dialog';
import { ExchangeRatesDialog } from './exchange-rates-dialog';
import { LedgerActionDialog } from './ledger-action-dialog';
import { AccountingTransferDialog } from './transfer/accounting-transfer-dialog';
import './accounting-page.css';

type Ledger = components['schemas']['Ledger'];
type Transaction = components['schemas']['Transaction'];

/** 查询键包含账号身份；切换账本重新挂载编辑区，清除旧账本的编辑状态。 */
export function AccountingPage() {
  const { session } = useSession();
  const accountId = session?.user.user_id ?? '';
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  useProductAnalyticsPage('accounting.ledgers.edit', createOpen);
  const [joinOpen, setJoinOpen] = useState(() => searchParams.has('invite'));
  const [deletingLedger, setDeletingLedger] = useState<Ledger | null>(null);
  const [transactionRequestLedger, setTransactionRequestLedger] = useState<{
    ledgerId: string;
    context: ProductAnalyticsContext | null;
  } | null>(null);
  const [ensureDefaultLedger] = useState(() => createDefaultBookProvisioner('accounting', accountId));
  const firstRecord = useMutation({ mutationFn: ensureDefaultLedger });
  const ledgerQuery = useQuery({
    queryKey: ['account', accountId, 'accounting', 'ledgers'],
    queryFn: async ({ signal }) => unwrap(await api.GET('/api/v1/ledgers', { signal })),
    enabled: Boolean(accountId),
  });
  const ledgers = ledgerQuery.data ?? [];
  const selectedId = searchParams.get('ledger');
  const selected = selectedId
    ? ledgers.find((ledger) => ledger.id === selectedId)
    : (ledgers.find((ledger) => !ledger.archived_at) ?? ledgers[0]);
  const selectLedger = (ledgerId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('ledger', ledgerId);
    if (selected?.id !== ledgerId && next.get('category') !== 'uncategorized') next.delete('category');
    setSearchParams(next);
  };
  /** 用户开始第一笔记录时复用或准备云端账本，成功后直接打开支出编辑器。 */
  function startFirstRecord() {
    const context = beginProductAnalyticsFlow();
    trackProductAction('accounting_transaction_create_click', 'accounting', accountId, context);
    firstRecord.mutate(undefined, {
      onSuccess: (id) => {
        setTransactionRequestLedger({ ledgerId: id, context });
        selectLedger(id);
      },
    });
  }
  const ledgerSelector = (
    <BookTabs
      label="当前账本"
      items={ledgers.map((ledger) => ({ id: ledger.id, name: ledger.name, archived: Boolean(ledger.archived_at) }))}
      value={selected?.id}
      onSelect={(id) => {
        trackProductAction('accounting_ledger_select', 'accounting');
        selectLedger(id);
      }}
    />
  );
  return (
    <div className="stack accounting-page">
      <PageHeading title="记账" />
      {/* 目录刷新失败只显示错误；已有缓存继续支撑工作区，编辑中的草稿保持挂载。 */}
      {ledgerQuery.isError && ledgerQuery.data !== undefined && (
        <ErrorState error={ledgerQuery.error} retry={() => void ledgerQuery.refetch()} />
      )}
      {firstRecord.isError && <ErrorState error={firstRecord.error} retry={startFirstRecord} />}
      {ledgerQuery.isPending ? (
        <LoadingState label="正在读取云端账本…" />
      ) : ledgerQuery.isError && ledgerQuery.data === undefined ? (
        <ErrorState error={ledgerQuery.error} retry={() => void ledgerQuery.refetch()} />
      ) : selectedId && !selected ? (
        <EmptyState
          title="无法访问这个账本"
          description="账本可能已被移除，或你的共享权限发生了变化。"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('ledger');
                next.delete('category');
                setSearchParams(next);
              }}
            >
              返回我的账本
            </Button>
          }
        />
      ) : !selected ? (
        <EmptyState
          title="还没有账本"
          description="从第一笔日常花销开始，账本会自动为你准备好。"
          action={
            <>
              <Button variant="secondary" onClick={() => setJoinOpen(true)}>
                加入共享账本
              </Button>
              <Button disabled={firstRecord.isPending} onClick={startFirstRecord}>
                <Plus size={18} />
                {firstRecord.isPending ? '正在准备账本…' : '记第一笔'}
              </Button>
            </>
          }
        />
      ) : (
        deletingLedger?.id !== selected.id && (
          <LedgerWorkspace
            key={`${accountId}:${selected.id}`}
            ledger={selected}
            accountId={accountId}
            onDelete={() => setDeletingLedger(selected)}
            onCreateLedger={() => setCreateOpen(true)}
            onJoinLedger={() => setJoinOpen(true)}
            ledgerSelector={ledgerSelector}
            startRequested={transactionRequestLedger?.ledgerId === selected.id}
            startContext={transactionRequestLedger?.context ?? null}
            onStarted={() => setTransactionRequestLedger(null)}
          />
        )
      )}
      {deletingLedger && (
        <LedgerActionDialog
          ledger={deletingLedger}
          mode="delete"
          onClose={() => setDeletingLedger(null)}
          onComplete={async () => {
            const scope = ['account', accountId, 'accounting', deletingLedger.id];
            // 先移除已删除账本的缓存，异步列表刷新不得重新挂载旧工作区。
            queryClient.setQueryData<Ledger[]>(
              ['account', accountId, 'accounting', 'ledgers'],
              (previous) => previous?.filter((entry) => entry.id !== deletingLedger.id) ?? [],
            );
            queryClient.removeQueries({ queryKey: scope });
            const next = new URLSearchParams(searchParams);
            if (next.get('ledger') === deletingLedger.id) {
              next.delete('ledger');
              if (next.get('category') !== 'uncategorized') next.delete('category');
            }
            setSearchParams(next, { replace: true });
            await queryClient.invalidateQueries({
              queryKey: ['account', accountId, 'accounting', 'ledgers'],
              exact: true,
            });
          }}
        />
      )}
      {joinOpen && (
        <JoinLedgerDialog
          initialCode={searchParams.get('invite') ?? ''}
          onClose={() => {
            setJoinOpen(false);
            if (searchParams.has('invite')) {
              const next = new URLSearchParams(searchParams);
              next.delete('invite');
              setSearchParams(next, { replace: true });
            }
          }}
          onJoined={selectLedger}
        />
      )}
      {createOpen && (
        <LedgerEditor
          accountId={accountId}
          onClose={() => setCreateOpen(false)}
          onSaved={(ledger) => {
            selectLedger(ledger.id);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** 按游标读取当前账本，所有修改成功后重新读取服务器权威数据。 */
function LedgerWorkspace({
  ledger,
  accountId,
  onDelete,
  onCreateLedger,
  onJoinLedger,
  ledgerSelector,
  startRequested,
  startContext,
  onStarted,
}: {
  ledger: Ledger;
  accountId: string;
  onDelete: () => void;
  onCreateLedger: () => void;
  onJoinLedger: () => void;
  ledgerSelector: ReactNode;
  startRequested: boolean;
  startContext: ProductAnalyticsContext | null;
  onStarted: () => void;
}) {
  const [editingLedger, setEditingLedger] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [aaOpen, setAaOpen] = useState(false);
  const [memberStatsOpen, setMemberStatsOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [ledgerAction, setLedgerAction] = useState<'clear' | null>(null);
  const [actionNotice, setActionNotice] = useState('');
  const [params, setParams] = useSearchParams();
  const [transactionEditor, setTransactionEditor] = useState<Transaction | 'new' | null>(null);
  const [transactionDetail, setTransactionDetail] = useState<Transaction | null>(null);
  const [transactionFlow, setTransactionFlow] = useState<ProductAnalyticsContext | null>(null);
  useEffect(() => {
    // 目录缓存可能先于路由切换发布；通过一次性意图打开编辑器，刷新不会重新打开。
    if (startRequested) {
      setTransactionEditor('new');
      setTransactionFlow(startContext);
      onStarted();
    }
  }, [startRequested, startContext, onStarted]);
  const [deleteTarget, setDeleteTarget] = useState<Transaction | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [categoryManager, setCategoryManager] = useState(false);
  useProductAnalyticsPage('accounting.categories', categoryManager);
  useProductAnalyticsPage('accounting.ledgers.edit', editingLedger);
  useProductAnalyticsPage('accounting.sharing', sharingOpen);
  useProductAnalyticsPage('accounting.aa_statistics', aaOpen);
  useProductAnalyticsPage('accounting.member_statistics', memberStatsOpen);

  /** 新记录直接记账，已有记录先查看详情，访问统计失败不阻塞实际操作。 */
  function openTransaction(transaction: Transaction | 'new'): void {
    let context: ProductAnalyticsContext | null = null;
    try {
      context = beginProductAnalyticsFlow();
      trackProductAction(
        transaction === 'new' ? 'accounting_transaction_create_click' : 'accounting_transaction_open_click',
        'accounting',
        accountId,
        context,
      );
    } catch (error) {
      console.warn('[记账] 记录访问统计暂不可用', { ledgerId: ledger.id, error });
    }
    setTransactionFlow(context);
    if (transaction === 'new') setTransactionEditor('new');
    else setTransactionDetail(transaction);
  }
  const baseKey = ['account', accountId, 'accounting'] as const;
  const filterView = useAccountingFilters(ledger);
  const categories = useQuery({
    queryKey: [...baseKey, ledger.id, 'categories'],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/categories', { signal, params: { path: { ledger_id: ledger.id } } }),
      ),
  });
  const categoryInitialization = useDefaultCategoryInitialization(
    ledger,
    accountId,
    categories.isSuccess && categories.data.length === 0,
  );
  const retryCategories = () => {
    if (categoryInitialization.error) categoryInitialization.retry();
    else void categories.refetch();
  };
  const transactionKey = [...baseKey, ledger.id, 'transactions', ledger.currency, filterView.filters];
  const transactions = useInfiniteQuery({
    queryKey: transactionKey,
    enabled: !filterView.error,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/transactions', {
          signal,
          params: {
            path: { ledger_id: ledger.id },
            query: { ...filterView.filters, limit: 40, ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: baseKey });
  const refreshLedger = useMutation({
    /** 当前账本内容与目录分别刷新，不使其他账本的统计和记录缓存失效。 */
    mutationFn: async () => {
      try {
        const results = await Promise.allSettled([
          queryClient.invalidateQueries({ queryKey: [...baseKey, ledger.id] }, { throwOnError: true }),
          queryClient.invalidateQueries({ queryKey: [...baseKey, 'ledgers'], exact: true }, { throwOnError: true }),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      } catch (error) {
        console.error('刷新当前账本数据失败', { accountId, ledgerId: ledger.id, error });
        throw error;
      }
    },
  });
  const deletion = useMutation({
    mutationFn: async ({ target, context }: { target: Transaction; context: ProductAnalyticsContext | null }) => {
      try {
        const result = unwrap(
          await api.DELETE('/api/v1/ledgers/{ledger_id}/transactions/{transaction_id}', {
            params: { path: { ledger_id: ledger.id, transaction_id: target.id } },
            body: { base_revision: target.revision },
          }),
        );
        trackProductAction('accounting_transaction_deleted', 'accounting', accountId, context);
        return result;
      } catch (error) {
        console.error('删除支出失败', {
          ledgerId: ledger.id,
          transactionId: target.id,
          revision: target.revision,
          error,
        });
        throw error;
      }
    },
    onSuccess: async () => {
      await invalidate();
      setDeleteTarget(null);
      setTransactionDetail(null);
    },
  });
  const archive = useMutation({
    mutationFn: async () =>
      pushChange({
        mutation_id: crypto.randomUUID(),
        entity_type: 'ledger_archive',
        entity_id: ledger.id,
        ledger_id: ledger.id,
        sync_id: ledger.sync_id,
        action: 'upsert',
        updated_at: new Date().toISOString(),
        payload: { archived: !ledger.archived_at },
      }),
    onSuccess: async () => {
      await invalidate();
      setArchiveConfirm(false);
    },
  });
  const items = Array.from(
    new Map((transactions.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item])).values(),
  );
  /** 从详情进入编辑时沿用本次操作身份，编辑完成或取消均回到支出列表。 */
  function editTransactionDetail(): void {
    if (!transactionDetail || ledger.archived_at) return;
    try {
      setTransactionFlow(captureProductAnalyticsContext(transactionFlow));
    } catch (error) {
      console.warn('[记账] 编辑操作统计暂不可用', { transactionId: transactionDetail.id, error });
    }
    setTransactionEditor(items.find((item) => item.id === transactionDetail.id) ?? transactionDetail);
    setTransactionDetail(null);
  }
  return (
    <div className="stack accounting-workspace" data-recording-enabled={!ledger.archived_at}>
      {(deletion.isPending || archive.isPending) && <PendingOperationGuard />}

      <BookWorkspaceHeader
        label="账本管理"
        selector={ledgerSelector}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                trackProductAction('accounting_categories_open_click', 'accounting');
                setCategoryManager(true);
              }}
            >
              <FolderTree size={17} />
              分类
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTransferOpen(true)}>
              <ArrowLeftRight size={16} />
              导入 / 导出
            </Button>
          </>
        }
        sections={[
          {
            id: 'create',
            title: '新建',
            content: (
              <>
                <Button variant="ghost" onClick={onCreateLedger}>
                  <Plus size={17} />
                  新建账本
                </Button>
                <Button variant="ghost" onClick={onJoinLedger}>
                  <Users size={17} />
                  加入共享账本
                </Button>
              </>
            ),
          },
          {
            id: 'settings',
            title: '设置',
            content: (
              <>
                {ledger.role === 'owner' && (
                  <Button variant="ghost" aria-label="当前账本设置" onClick={() => setEditingLedger(true)}>
                    <Settings2 size={17} />
                    账本设置
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setSharingOpen(true)}>
                  <Users size={17} />
                  共享与成员
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    archive.reset();
                    setArchiveConfirm(true);
                  }}
                >
                  <Archive size={17} />
                  {ledger.archived_at ? '取消归档' : '归档'}
                </Button>
              </>
            ),
          },
          {
            id: 'currency',
            title: '币种与汇率',
            content: (
              <>
                {ledger.role === 'owner' && (
                  <Button variant="ghost" disabled={Boolean(ledger.archived_at)} onClick={() => setCurrencyOpen(true)}>
                    更换本位币
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setRatesOpen(true)}>
                  汇率设置
                </Button>
              </>
            ),
          },
          ...(ledger.role === 'owner'
            ? [
                {
                  id: 'data',
                  title: '数据操作',
                  danger: true,
                  content: (
                    <>
                      <Button
                        variant="secondary"
                        disabled={Boolean(ledger.archived_at)}
                        onClick={() => setLedgerAction('clear')}
                      >
                        清空支出记录
                      </Button>
                      <Button
                        variant="secondary"
                        className="accounting-delete-ledger"
                        disabled={Boolean(ledger.archived_at)}
                        onClick={onDelete}
                      >
                        <Trash2 size={16} />
                        删除云端账本
                      </Button>
                    </>
                  ),
                },
              ]
            : []),
        ]}
      />
      {actionNotice && (
        <p role="status" className="notice">
          {actionNotice}
        </p>
      )}
      {Boolean(categoryInitialization.error) && (
        <ErrorState error={categoryInitialization.error} retry={categoryInitialization.retry} />
      )}
      <LedgerStatistics
        ledger={ledger}
        accountId={accountId}
        categories={categories.data ?? []}
        view={filterView}
        memberActions={
          <div className="accounting-member-links" role="group" aria-label="全部时间的成员与分摊统计">
            <span className="muted">全部时间</span>
            <Button variant="ghost" size="sm" onClick={() => setMemberStatsOpen(true)}>
              <Users size={16} />
              成员支出
            </Button>
            {ledger.aa_enabled && (
              <Button variant="ghost" size="sm" onClick={() => setAaOpen(true)}>
                <ChartNoAxesCombined size={16} />
                AA 统计
              </Button>
            )}
          </div>
        }
      />
      {ledger.archived_at && <p className="notice">这个账本已归档，记录仍可查看。取消归档后可以继续记账。</p>}
      <section className="stack accounting-records" aria-label="支出记录">
        <div className="accounting-section-heading">
          <div>
            <h2>明细</h2>
          </div>
          <div className="accounting-records-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={refreshLedger.isPending}
              title="刷新当前账本的记录、统计、分类及账本信息"
              onClick={() => refreshLedger.mutate()}
            >
              <RefreshCw size={15} className={refreshLedger.isPending ? 'spin' : undefined} />
              {refreshLedger.isPending ? '正在刷新账本…' : '刷新账本数据'}
            </Button>
            <AccountingRecordAction disabled={Boolean(ledger.archived_at)} onCreate={() => openTransaction('new')} />
          </div>
        </div>
        {refreshLedger.isError && <ErrorState error={refreshLedger.error} retry={() => refreshLedger.mutate()} />}
        {filterView.error ? (
          <p className="muted">请先完善上方筛选条件。</p>
        ) : transactions.isPending ? (
          <LoadingState label="正在读取支出记录…" />
        ) : transactions.isError && items.length === 0 ? (
          <ErrorState error={transactions.error} retry={() => void transactions.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title="这段时间还没有支出记录"
            description="记下一笔日常花销，或换个时间范围看看。"
            action={!ledger.archived_at ? <Button onClick={() => openTransaction('new')}>记第一笔</Button> : undefined}
          />
        ) : (
          <>
            <TransactionTimeline
              items={items}
              categories={categories.data ?? []}
              currency={ledger.currency}
              archived={Boolean(ledger.archived_at)}
              onOpen={openTransaction}
              onDelete={(item) => {
                deletion.reset();
                setDeleteTarget(item);
              }}
            />
            {transactions.isError && (
              <ErrorState
                error={transactions.error}
                retry={() =>
                  void (transactions.isFetchNextPageError ? transactions.fetchNextPage() : transactions.refetch())
                }
              />
            )}
            {transactions.hasNextPage && (
              <TransactionNextPage
                key={hashKey(transactionKey)}
                queryHash={hashKey(transactionKey)}
                fetchNextPage={transactions.fetchNextPage}
                isFetchingNextPage={transactions.isFetchingNextPage}
              />
            )}
            {!transactions.hasNextPage && <p className="accounting-records-end">已显示当前筛选范围的全部支出记录</p>}
          </>
        )}
      </section>
      {ledgerAction && (
        <LedgerActionDialog
          ledger={ledger}
          mode={ledgerAction}
          onClose={() => setLedgerAction(null)}
          onComplete={async (_mode, count) => {
            setActionNotice(`已清空 ${count} 笔支出。周期规则、成员和分类仍保留。`);
            await invalidate();
          }}
        />
      )}
      {ratesOpen && <ExchangeRatesDialog initialBase={ledger.currency} onClose={() => setRatesOpen(false)} />}
      {aaOpen && <AaStatisticsDialog ledger={ledger} onClose={() => setAaOpen(false)} />}
      {memberStatsOpen && <MemberExpenseDialog ledger={ledger} onClose={() => setMemberStatsOpen(false)} />}
      {transferOpen && <AccountingTransferDialog ledger={ledger} onClose={() => setTransferOpen(false)} />}
      {currencyOpen && <CurrencyChangeDialog ledger={ledger} onClose={() => setCurrencyOpen(false)} />}
      {sharingOpen && (
        <SharingDialog
          ledger={ledger}
          onClose={() => setSharingOpen(false)}
          onLeft={() => {
            const next = new URLSearchParams(params);
            next.delete('ledger');
            if (next.get('category') !== 'uncategorized') next.delete('category');
            setParams(next, { replace: true });
          }}
        />
      )}
      {editingLedger && (
        <LedgerEditor
          accountId={accountId}
          ledger={ledger}
          onClose={() => setEditingLedger(false)}
          onSaved={() => setEditingLedger(false)}
        />
      )}
      {transactionEditor && (
        <TransactionEditor
          key={transactionFlow?.flowId ?? (transactionEditor === 'new' ? 'new' : transactionEditor.id)}
          ledger={ledger}
          analyticsContext={transactionFlow}
          existing={transactionEditor === 'new' ? undefined : transactionEditor}
          categories={categories.data ?? []}
          categoriesLoading={categories.isPending || categoryInitialization.isPending}
          categoriesError={categories.error ?? categoryInitialization.error}
          retryCategories={retryCategories}
          onClose={() => setTransactionEditor(null)}
          onSaved={async () => {
            await invalidate();
            setTransactionEditor(null);
          }}
        />
      )}
      {transactionDetail && (
        <TransactionDetail
          transaction={items.find((item) => item.id === transactionDetail.id) ?? transactionDetail}
          ledger={ledger}
          categories={categories.data ?? []}
          analyticsContext={transactionFlow}
          onClose={() => setTransactionDetail(null)}
          onEdit={editTransactionDetail}
          onDelete={() => {
            if (ledger.archived_at) return;
            deletion.reset();
            setDeleteTarget(items.find((item) => item.id === transactionDetail.id) ?? transactionDetail);
          }}
        />
      )}
      {categoryManager && (
        <CategoryManager
          ledger={ledger}
          accountId={accountId}
          categories={categories.data ?? []}
          loading={categories.isPending || categoryInitialization.isPending}
          error={categories.error ?? categoryInitialization.error}
          retry={retryCategories}
          onClose={() => setCategoryManager(false)}
        />
      )}
      <Dialog
        open={deleteTarget !== null}
        title="删除这笔支出？"
        description="这条记录将从云端账本删除，其他设备同步后也会删除。"
        onClose={() => {
          if (!deletion.isPending) setDeleteTarget(null);
        }}
      >
        {deleteTarget && (
          <p>
            {deleteTarget.category_name ?? '未分类'} · {deleteTarget.currency_code} {displayAmount(deleteTarget.amount)}
          </p>
        )}
        {deletion.isError && <ErrorState error={deletion.error} />}
        <div className="toolbar">
          <Button
            variant="danger"
            disabled={deletion.isPending}
            onClick={() => {
              if (deleteTarget) deletion.mutate({ target: deleteTarget, context: captureProductAnalyticsContext() });
            }}
          >
            {deletion.isPending ? '删除中…' : '确认删除'}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={archiveConfirm}
        title={ledger.archived_at ? '取消账本归档？' : '归档这个账本？'}
        description={
          ledger.archived_at
            ? '取消归档后，这个账本会重新出现在正在使用的列表中。'
            : '归档只改变你自己的账本列表，不会删除记录，也不影响其他成员。可随时取消归档。'
        }
        onClose={() => {
          if (!archive.isPending) setArchiveConfirm(false);
        }}
      >
        {archive.isError && <ErrorState error={archive.error} />}
        <div className="toolbar">
          <Button disabled={archive.isPending} onClick={() => archive.mutate()}>
            {archive.isPending ? '正在处理…' : ledger.archived_at ? '取消归档' : '确认归档'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
