import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { ApiError, unwrap, type components, type paths } from '@sesame-notes/api-client';
import { api, captureSessionOperation, queryClient } from '../../lib/session';
import { Button, Dialog, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { PendingOperationGuard } from './pending-operation-guard';
import { CategoryIcon } from './category-icons';
import './category-conflicts.css';

type Category = components['schemas']['Category'];
type Conflict =
  paths['/api/v1/category-conflicts']['get']['responses'][200]['content']['application/json']['items'][number];
type ResolveBody =
  paths['/api/v1/category-conflicts/{conflict_id}/resolve']['post']['requestBody']['content']['application/json'];
type CategoryValues = Pick<Category, 'name' | 'kind' | 'level' | 'parent_id' | 'icon' | 'sort_order'>;
type Attempt = { id: string; body: ResolveBody };
type Selection = { signature: string; choice: 'cloud' | 'local'; restore: boolean; remove: boolean };

/** 对比同一分类的内容；未知父分类明确标示，不根据同名分类猜测引用。 */
function CategoryComparison({
  title,
  values,
  deleted,
  categories,
}: {
  title: string;
  values: CategoryValues | null;
  deleted: boolean;
  categories: Category[];
}) {
  return (
    <section className="category-conflict-card" aria-label={title}>
      <h3>{title}</h3>
      {deleted && <p className="badge">已删除</p>}
      {values ? (
        <dl>
          <dt>名称</dt>
          <dd>{values.name}</dd>
          <dt>类型</dt>
          <dd>支出</dd>
          <dt>所属分类</dt>
          <dd>
            {values.parent_id
              ? (categories.find((row) => row.id === values.parent_id)?.name ?? '父分类已不可用')
              : '无'}
          </dd>
          <dt>图标</dt>
          <dd>
            <CategoryIcon name={values.icon} />
            <span>{values.icon ?? '通用图标'}</span>
          </dd>
          <dt>排序</dt>
          <dd>{values.sort_order}</dd>
        </dl>
      ) : (
        <p className="muted">删除此分类</p>
      )}
    </section>
  );
}

/** 待确认候选独立于可见分类目录；用户明确选择后才按完整云端版本提交。 */
type CategoryConflictsProps = {
  accountId: string;
  categories: Category[];
  onClose: () => void;
};

/** 账号切换重新建立完整组件生命周期，不保留上一个账号的待确认请求。 */
export function CategoryConflicts(props: CategoryConflictsProps) {
  return <CategoryConflictPanel key={props.accountId} {...props} />;
}

/** 待确认列表、完整版本对比与单次确认共用同一个弹窗。 */
function CategoryConflictPanel({ accountId, categories, onClose }: CategoryConflictsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [notice, setNotice] = useState('');
  const [refreshFailure, setRefreshFailure] = useState<unknown>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const writing = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const queryKey = ['account', accountId, 'category-conflicts', 'pending'];
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, [accountId]);
  const list = useInfiniteQuery({
    queryKey,
    enabled: () => !writing.current,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/v1/category-conflicts', {
          signal,
          params: { query: { status: 'pending', limit: 20, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (last) => (last.has_more ? (last.next_cursor ?? undefined) : undefined),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const rows = [...new Map(list.data?.pages.flatMap((page) => page.items).map((row) => [row.id, row]) ?? []).values()];
  const selected = rows.find((row) => row.id === selectedId);
  const signature = selected
    ? JSON.stringify([selected.id, selected.candidate_version, selected.cloud_snapshot.version_token])
    : '';
  const currentSelection = selection?.signature === signature ? selection : null;
  const restoreRequired = selected?.action === 'upsert' && Boolean(selected.cloud_snapshot.deleted_at);
  const deleteRequired = selected?.action === 'delete';
  const save = useMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: async (current: Attempt) => {
      const controller = lifecycle.current;
      let signal = controller?.signal;
      try {
        if (!controller) throw new Error('请重新打开待确认分类');
        const operation = captureSessionOperation();
        signal = AbortSignal.any([controller.signal, operation.signal]);
        await queryClient.cancelQueries({ queryKey, exact: true });
        signal.throwIfAborted();
        unwrap(
          await operation.client.POST('/api/v1/category-conflicts/{conflict_id}/resolve', {
            signal,
            params: { path: { conflict_id: current.id } },
            body: current.body,
          }),
        );
        operation.assertCurrent();
        signal.throwIfAborted();
        // 权威重新读取可能包括交易分类显示，不把候选直接拼入任何业务缓存。
        writing.current = false;
        await operation.invalidate();
        operation.assertCurrent();
        signal.throwIfAborted();
        attempt.current = null;
        setSelectedId(null);
        setSelection(null);
        setNotice(current.body.choice === 'cloud' ? '已保留云端分类' : '已采用本地修改');
      } catch (error) {
        if (
          !signal?.aborted &&
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        ) {
          attempt.current = null;
          setRefreshRequired(true);
          setSelection(null);
        }
        throw error;
      } finally {
        writing.current = false;
      }
    },
  });
  const uncertain = save.isError && !!attempt.current;
  const busy = save.isPending;
  const ready =
    !!selected &&
    !!currentSelection &&
    !busy &&
    !list.isFetching &&
    !list.isError &&
    !refreshRequired &&
    refreshFailure === null &&
    !uncertain &&
    (currentSelection.choice === 'cloud' ||
      ((!restoreRequired || currentSelection.restore) && (!deleteRequired || currentSelection.remove)));

  /** 同一事件循环内只允许发起一次；未知结果重复提交保留原始请求正文及 mutation。 */
  function submit(retry = false) {
    if (writing.current || busy) return;
    if (!retry) {
      if (!ready || !selected || !currentSelection) return;
      attempt.current = {
        id: selected.id,
        body: {
          mutation_id: crypto.randomUUID(),
          expected_candidate_version: selected.candidate_version,
          expected_cloud_token: selected.cloud_snapshot.version_token,
          choice: currentSelection.choice,
          ...(currentSelection.choice === 'local' && restoreRequired ? { restore_deleted: true } : {}),
        },
      };
    }
    if (!attempt.current) return;
    writing.current = true;
    setNotice('');
    void save.mutateAsync(attempt.current).catch(() => undefined);
  }

  /** 刷新只更新展示和确认基线，不自动提交上一次选择。 */
  async function refresh() {
    if (writing.current || busy) return;
    const controller = lifecycle.current;
    setSelection(null);
    setNotice('');
    setRefreshFailure(null);
    try {
      const operation = captureSessionOperation();
      const result = await list.refetch();
      operation.assertCurrent();
      if (result.isSuccess && controller && lifecycle.current === controller && !controller.signal.aborted) {
        // 丢失回执后重新读取可能已发现候选被处理，也必须重读实际分类而非保留旧缓存。
        await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'accounting'] });
        operation.assertCurrent();
        controller.signal.throwIfAborted();
        attempt.current = null;
        setRefreshRequired(false);
        save.reset();
      }
    } catch (error) {
      if (controller && lifecycle.current === controller && !controller.signal.aborted) setRefreshFailure(error);
    }
  }

  /** 切换候选清除旧确认，避免把恢复或删除许可应用到其他分类。 */
  function choose(row: Conflict) {
    if (busy || uncertain) return;
    setSelectedId(row.id);
    setSelection(null);
    setNotice('');
    save.reset();
  }

  return (
    <Dialog
      open
      title="待确认分类"
      description="不同设备对同一分类有不同修改。确认后仍保留原分类身份。"
      onClose={() => {
        if (!writing.current && !busy) onClose();
      }}
    >
      <div className="stack category-conflicts">
        {busy && <PendingOperationGuard />}
        <div className="toolbar">
          <Button variant="secondary" disabled={busy || list.isFetching} onClick={() => void refresh()}>
            {list.isFetching ? '读取中…' : refreshRequired ? '重新读取分类' : '刷新待确认分类'}
          </Button>
          {rows.length > 0 && (
            <span className="muted">
              已加载 {rows.length} 项{list.hasNextPage ? '，下方可继续加载' : ''}
            </span>
          )}
        </div>
        {notice && <p role="status">{notice}</p>}
        {list.isPending && <LoadingState label="正在读取待确认分类…" />}
        {list.isError && <ErrorState error={list.error} retry={() => void refresh()} />}
        {refreshFailure !== null && <ErrorState error={refreshFailure} retry={() => void refresh()} />}
        {list.isSuccess && rows.length === 0 && (
          <EmptyState title="没有待确认分类" description="分类修改已处理完毕。" />
        )}
        {rows.length > 0 && (
          <ul className="category-conflict-list" aria-label="待确认分类列表">
            {rows.map((row) => (
              <li key={row.id}>
                <Button
                  variant={selectedId === row.id ? 'primary' : 'secondary'}
                  disabled={busy || uncertain}
                  aria-label={[
                    row.local_payload?.name ?? row.cloud_snapshot.name,
                    row.action === 'delete' ? '待删除' : '待修改',
                  ].join(' ')}
                  aria-pressed={selectedId === row.id}
                  onClick={() => choose(row)}
                >
                  <span>{row.local_payload?.name ?? row.cloud_snapshot.name}</span>
                  <span>{row.action === 'delete' ? '待删除' : '待修改'}</span>
                </Button>
                <small className="muted">收到于 {new Date(row.created_at).toLocaleString('zh-CN')}</small>
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <Button
            variant="secondary"
            disabled={busy || list.isFetching || uncertain}
            onClick={() => void list.fetchNextPage({ cancelRefetch: false })}
          >
            加载更多待确认分类
          </Button>
        )}
        {selected && (
          <section className="stack" aria-label="分类修改对比">
            <div className="category-conflict-comparison">
              <CategoryComparison
                title="云端当前内容"
                values={selected.cloud_snapshot}
                deleted={Boolean(selected.cloud_snapshot.deleted_at)}
                categories={categories}
              />
              <CategoryComparison
                title="本地待确认内容"
                values={selected.local_payload}
                deleted={selected.action === 'delete'}
                categories={categories}
              />
            </div>
            <fieldset
              disabled={busy || uncertain || refreshRequired || list.isFetching || list.isError}
              className="category-conflict-choice"
            >
              <legend>选择保留的内容</legend>
              {(['cloud', 'local'] as const).map((choice) => (
                <label key={choice}>
                  <input
                    type="radio"
                    name="category-conflict-choice"
                    checked={currentSelection?.choice === choice}
                    onChange={() => setSelection({ signature, choice, restore: false, remove: false })}
                  />
                  {choice === 'cloud' ? '保留云端' : '采用本地修改'}
                </label>
              ))}
              {currentSelection?.choice === 'local' && restoreRequired && (
                <>
                  <p className="muted">恢复分类不会自动改回已清除的交易分类。</p>
                  <label>
                    <input
                      type="checkbox"
                      checked={currentSelection.restore}
                      onChange={(event) => setSelection({ ...currentSelection, restore: event.target.checked })}
                    />
                    恢复此分类
                  </label>
                </>
              )}
              {currentSelection?.choice === 'local' && deleteRequired && (
                <>
                  <p className="field-error">云端分类会被移除，关联交易和周期规则保留为未分类。</p>
                  <label>
                    <input
                      type="checkbox"
                      checked={currentSelection.remove}
                      onChange={(event) => setSelection({ ...currentSelection, remove: event.target.checked })}
                    />
                    确认删除云端分类
                  </label>
                </>
              )}
            </fieldset>
          </section>
        )}
        {save.isError && (
          <ErrorState
            error={
              save.error instanceof ApiError && save.error.code === 'CATEGORY_HAS_CHILDREN'
                ? new Error('该分类仍有子分类。请先保留云端，或在分类管理中处理子分类后再确认。')
                : save.error instanceof ApiError && save.error.code === 'INVALID_CATEGORY_PARENT'
                  ? new Error('待确认内容中的父分类已不可用。请保留云端，或在来源设备修正后重新同步。')
                  : save.error
            }
          />
        )}
        {refreshRequired && <p className="notice">这次选择未能应用。请重新读取云端内容并核对后再选择。</p>}
        {uncertain && (
          <p className="notice">
            上次选择“{attempt.current?.body.choice === 'cloud' ? '保留云端' : '采用本地修改'}
            ”的结果尚未确认。重试会继续同一次操作，也可以刷新查看处理状态。
          </p>
        )}
        <div className="dialog-actions">
          {uncertain ? (
            <Button disabled={busy} onClick={() => submit(true)}>
              重试原操作
            </Button>
          ) : (
            <Button
              variant={currentSelection?.choice === 'local' && deleteRequired ? 'danger' : 'primary'}
              disabled={!ready}
              onClick={() => submit()}
            >
              {busy ? '处理中…' : '确认选择'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
