import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { unwrap, type components, type paths } from '@sesame-notes/api-client';
import { api, queryClient } from '../../lib/session';
import { Button, Dialog, ErrorState, Field, LoadingState } from '../../components/ui';
import { PendingOperationGuard } from './pending-operation-guard';
type Category = components['schemas']['Category'];
type Body =
  paths['/api/v1/ledgers/{ledger_id}/categories/remove']['post']['requestBody']['content']['application/json'];

/** 所有影响范围来自服务端预览；完整名称与预览版本绑定，更新后必须重新确认。 */
export function CategoryRemoval({
  ledgerId,
  accountId,
  sources,
  categories,
  onClose,
}: {
  ledgerId: string;
  accountId: string;
  sources: Category[];
  categories: Category[];
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Body['mode']>('delete');
  const [target, setTarget] = useState('');
  const [confirmation, setConfirmation] = useState({ token: '', name: '' });
  const writingRef = useRef(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const ids = sources.map((source) => source.id).sort();
  const queryKey = ['account', accountId, 'category-removal-preview', ledgerId, ids];
  const preview = useQuery({
    queryKey,
    enabled: () => !writingRef.current,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.POST('/api/v1/ledgers/{ledger_id}/categories/removal-preview', {
          signal,
          params: { path: { ledger_id: ledgerId } },
          body: { category_ids: ids },
        }),
      ),
  });
  const label = sources
    .map((source) => preview.data?.categories.find((row) => row.id === source.id)?.name ?? source.name)
    .join('、');
  const excluded = new Set(preview.data?.categories.map((row) => row.id) ?? ids);
  const targets = categories.filter((row) => !excluded.has(row.id) && !excluded.has(row.parent_id ?? ''));
  const targetCategory = targets.find((row) => row.id === target);
  const confirmationToken = JSON.stringify([
    preview.data?.preview_token,
    mode,
    mode === 'migrate' ? [targetCategory?.id, targetCategory?.updated_at] : null,
  ]);
  const confirmed = !!preview.data && confirmation.token === confirmationToken && confirmation.name === label;
  const save = useMutation({
    mutationFn: async () => {
      if (!preview.data || !confirmed) throw new Error('请重新核对分类范围并输入完整名称');
      writingRef.current = true;
      await queryClient.cancelQueries({ queryKey, exact: true });
      const body: Body = {
        category_ids: ids,
        mode,
        preview_token: preview.data.preview_token,
        ...(mode === 'migrate'
          ? { target_category_id: target, expected_target_updated_at: targetCategory?.updated_at }
          : {}),
      };
      const signature = JSON.stringify(body);
      if (!attempt.current || attempt.current.signature !== signature)
        attempt.current = { signature, key: crypto.randomUUID() };
      return unwrap(
        await api.POST('/api/v1/ledgers/{ledger_id}/categories/remove', {
          params: { path: { ledger_id: ledgerId }, header: { 'idempotency-key': attempt.current.key } },
          body,
        }),
      );
    },
    onSuccess: async () => {
      onClose();
      await queryClient.invalidateQueries({ queryKey: ['account', accountId] });
    },
    onError: () => {
      writingRef.current = false;
    },
  });
  return (
    <Dialog
      open
      title="处理所选分类"
      description="分类属于当前所有者，操作会影响该所有者所有云端账本。请核对关联记录后确认。"
      onClose={() => {
        if (!save.isPending) onClose();
      }}
    >
      <div className="stack">
        {save.isPending && <PendingOperationGuard />}
        {preview.isPending ? (
          <LoadingState />
        ) : preview.isError ? (
          <ErrorState error={preview.error} retry={() => void preview.refetch()} />
        ) : (
          preview.data && (
            <>
              <p>
                <strong>{label}</strong>
              </p>
              <p className="muted">
                包含 {preview.data.categories.length} 个分类、{preview.data.transaction_count} 笔关联交易和{' '}
                {preview.data.recurring_count} 条周期规则。
              </p>
              <Field label="处理方式">
                <select
                  value={mode}
                  disabled={save.isPending}
                  onChange={(event) => {
                    setMode(event.target.value as Body['mode']);
                    setConfirmation({ token: '', name: '' });
                  }}
                >
                  <option value="delete">删除分类、子分类及其交易</option>
                  <option value="migrate">迁移全部交易到其他分类，再移除源分类</option>
                  {sources.every((row) => row.parent_id === null) && (
                    <option value="promote">删除分类及直属交易，保留并移出其子分类</option>
                  )}
                </select>
              </Field>
              {mode === 'migrate' ? (
                <Field label="迁移到分类">
                  <select
                    value={target}
                    disabled={save.isPending}
                    onChange={(event) => {
                      setTarget(event.target.value);
                      setConfirmation({ token: '', name: '' });
                    }}
                  >
                    <option value="">请选择保留的分类</option>
                    {targets.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.parent_id ? `${categories.find((parent) => parent.id === row.parent_id)?.name} / ` : ''}
                        {row.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {preview.data.recurring_count > 0 && (
                <p className="notice">关联周期规则将清空分类，并按原设置继续运行。</p>
              )}
              {mode === 'delete' && (
                <p role="note" className="field-error">
                  分类树中的关联交易也会从云端删除，并同步到手机。
                </p>
              )}
              {mode === 'promote' && (
                <p role="note" className="field-error">
                  直接记在所选分类下的交易会删除；子分类改为无所属分类，其身份和交易保持不变。
                </p>
              )}
              <Field label="输入完整分类名称确认" hint={label}>
                <input
                  value={confirmation.token === confirmationToken ? confirmation.name : ''}
                  disabled={save.isPending}
                  onChange={(event) => setConfirmation({ token: confirmationToken, name: event.target.value })}
                />
              </Field>
            </>
          )
        )}
        {save.isError && (
          <>
            <ErrorState error={save.error} />
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmation({ token: '', name: '' });
                void Promise.all([
                  preview.refetch(),
                  queryClient.invalidateQueries({ queryKey: ['account', accountId, 'accounting'] }),
                ]);
              }}
            >
              重新核对最新范围
            </Button>
          </>
        )}
        <div className="dialog-actions">
          <Button
            variant={mode === 'migrate' ? 'primary' : 'danger'}
            disabled={!confirmed || save.isPending || (mode === 'migrate' && !targets.some((row) => row.id === target))}
            onClick={() => save.mutate()}
          >
            {save.isPending ? '处理中…' : mode === 'migrate' ? '确认迁移并移除' : '确认处理分类'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
