import { useState } from 'react';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { useMutation } from '@tanstack/react-query';
import { unwrap, type paths } from '@sesame-notes/api-client';
import { api, queryClient, useSession } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';

/** 先预览邀请的账本与权限，再由用户明确确认加入。 */
export function JoinLedgerDialog({
  initialCode = '',
  onClose,
  onJoined,
}: {
  initialCode?: string;
  onClose: () => void;
  onJoined: (id: string) => void;
}) {
  useProductAnalyticsPage('accounting.ledgers.join');
  const { session } = useSession();
  const [code, setCode] = useState(initialCode);
  const [previewedCode, setPreviewedCode] = useState('');
  const [validationError, setValidationError] = useState('');
  const preview = useMutation({
    mutationFn: async (value: string) =>
      unwrap(await api.GET('/api/v1/invites/{code}', { params: { path: { code: value } } })),
    onSuccess: (_data, value) => setPreviewedCode(value),
  });
  const accept = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST('/api/v1/invites/{code}/accept', { params: { path: { code: previewedCode } } })),
    onSuccess: completeSave,
  });
  const { close, finish, confirmation } = useDraftClose(
    code !== initialCode,
    preview.isPending || accept.isPending,
    onClose,
  );
  /** 完成权威数据刷新后放行成功退出，避免草稿保护拦截程序内导航。 */
  async function completeSave(
    result: paths['/api/v1/invites/{code}/accept']['post']['responses'][200]['content']['application/json'],
  ) {
    await queryClient.invalidateQueries({ queryKey: ['account', session?.user.user_id] });
    finish(() => onJoined(result.ledger_id));
  }

  return (
    <Dialog open title="加入共享账本" description="粘贴朋友提供的邀请码，先确认账本，再决定是否加入。" onClose={close}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const value = code.trim();
          if (value.length < 8 || value.length > 32) {
            setValidationError('请输入 8 至 32 位邀请码。');
            return;
          }
          setValidationError('');
          preview.mutate(value);
        }}
      >
        <Field label="邀请码" error={validationError}>
          <input
            autoFocus
            autoComplete="off"
            value={code}
            readOnly={preview.isPending || accept.isPending}
            onChange={(event) => {
              setCode(event.target.value);
              setPreviewedCode('');
            }}
          />
        </Field>
        <Button type="submit" disabled={preview.isPending || accept.isPending}>
          {preview.isPending ? '正在查询…' : '预览邀请'}
        </Button>
        {preview.isError && <ErrorState error={preview.error} />}
      </form>
      {preview.data && previewedCode === code.trim() && (
        <section className="panel stack">
          <h3>{preview.data.ledger_name}</h3>
          <p>加入后可以查看和编辑此账本。</p>
          <p className="muted">邀请有效至 {new Date(preview.data.expires_at).toLocaleString('zh-CN')}</p>
          <Button
            disabled={accept.isPending || new Date(preview.data.expires_at).getTime() <= Date.now()}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? '正在加入…' : '确认加入账本'}
          </Button>
          {accept.isError && <ErrorState error={accept.error} />}
        </section>
      )}
      {confirmation}
    </Dialog>
  );
}
