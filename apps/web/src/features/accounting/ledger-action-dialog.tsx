import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, unwrap, type components, type paths } from '@sesame-notes/api-client';
import { api, captureSessionOperation, queryClient, useSession } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, ErrorState, Field, LoadingState } from '../../components/ui';
type ActionPreview =
  paths['/api/v1/ledgers/{ledger_id}/action-preview']['get']['responses'][200]['content']['application/json'];

/** 删除与清空绑定完整影响预览；服务器会在同一事务核对同步身份及内容指纹。 */
export function LedgerActionDialog({
  ledger,
  mode,
  onClose,
  onComplete,
}: {
  ledger: components['schemas']['Ledger'];
  mode: 'clear' | 'delete';
  onClose: () => void;
  onComplete: (mode: 'clear' | 'delete', count: number) => Promise<void>;
}) {
  const { session } = useSession();
  const [review, setReview] = useState<ActionPreview | null>(null);
  const [name, setName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const attempt = useRef({ fingerprint: '', mutationId: crypto.randomUUID() });
  const submitting = useRef(false);
  const preview = useQuery({
    queryKey: ['account', session!.user.user_id, 'accounting', ledger.id, 'action-preview', mode],
    enabled: () => !submitting.current,
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/action-preview', {
          signal,
          params: { path: { ledger_id: ledger.id } },
        }),
      ),
  });
  useEffect(() => {
    if (!preview.data || preview.data.fingerprint === review?.fingerprint) return;
    setReview(preview.data);
    setName('');
    setAcknowledged(false);
  }, [preview.data, review?.fingerprint]);
  const save = useMutation({
    mutationFn: async () => {
      const operation = captureSessionOperation();
      if (!review || name !== review.name || !acknowledged) throw new Error('请完整输入账本名称并确认影响。');
      if (attempt.current.fingerprint !== review.fingerprint)
        attempt.current = { fingerprint: review.fingerprint, mutationId: crypto.randomUUID() };
      await queryClient.cancelQueries({
        queryKey: ['account', session!.user.user_id, 'accounting', ledger.id, 'action-preview', mode],
      });
      operation.assertCurrent();
      if (mode === 'clear') {
        const result = unwrap(
          await operation.client.POST('/api/v1/ledgers/{ledger_id}/clear', {
            signal: operation.signal,
            params: { path: { ledger_id: ledger.id } },
            body: {
              mutation_id: attempt.current.mutationId,
              expected_sync_id: review.sync_id,
              expected_fingerprint: review.fingerprint,
            },
          }),
        );
        operation.assertCurrent();
        return result.deleted_count;
      }
      unwrap(
        await operation.client.DELETE('/api/v1/ledgers/{ledger_id}', {
          signal: operation.signal,
          params: {
            path: { ledger_id: ledger.id },
            query: { expected_sync_id: review.sync_id, expected_fingerprint: review.fingerprint },
          },
        }),
      );
      operation.assertCurrent();
      return review.transaction_count;
    },
    onSuccess: completeSave,
    onSettled: () => {
      submitting.current = false;
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
        setName('');
        setAcknowledged(false);
        void preview.refetch();
      }
    },
  });
  const { close, finish, confirmation } = useDraftClose(name !== '' || acknowledged, save.isPending, onClose);
  /** 只有服务器确认操作完成后才退出确认页面并更新账本列表。 */
  async function completeSave(count: number) {
    finish();
    await onComplete(mode, count);
  }
  const allowed = Boolean(
    review &&
    name === review.name &&
    acknowledged &&
    !preview.isError &&
    !preview.isFetching &&
    ledger.role === 'owner' &&
    !ledger.archived_at,
  );
  return (
    <Dialog
      open
      title={mode === 'clear' ? '清空账本支出' : '删除云端账本'}
      description="请核对全部影响。此操作会同步到其他设备，并影响这个账本的所有共享成员。"
      onClose={close}
    >
      {preview.isPending ? (
        <LoadingState label="正在核对账本内容…" />
      ) : preview.isError ? (
        <ErrorState error={preview.error} retry={() => void preview.refetch()} />
      ) : (
        review && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              // React 尚未刷新 pending 状态时也只能接受一次确认。
              if (!allowed || save.isPending || submitting.current) return;
              submitting.current = true;
              save.mutate();
            }}
          >
            <div className="notice">
              <p>
                <strong>{review.name}</strong> · {review.currency}
              </p>
              <p>
                {review.transaction_count} 笔支出 · {review.recurring_count} 条周期规则 · {review.member_count} 位成员
              </p>
            </div>
            <p>
              {mode === 'clear'
                ? '仅删除这个账本的现有支出。账本、分类、成员和周期规则会保留；已启用的周期规则之后仍可能生成新支出。'
                : '账本及其支出、周期规则和成员关系将被删除，所有共享成员失去访问权限。账号分类与其他账本不受影响。'}
            </p>
            <Field label="输入完整账本名称" hint={`请输入：${review.name}`}>
              <input
                autoComplete="off"
                value={name}
                readOnly={save.isPending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={save.isPending}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              我已核对影响，确认要{mode === 'clear' ? '清空这些支出' : '删除整个云端账本'}。
            </label>
            {save.isError && <ErrorState error={save.error} />}
            <div className="toolbar">
              <Button variant="danger" type="submit" disabled={!allowed || save.isPending}>
                {save.isPending ? '处理中…' : mode === 'clear' ? '确认清空支出' : '确认删除账本'}
              </Button>
            </div>
          </form>
        )
      )}
      {confirmation}
    </Dialog>
  );
}
