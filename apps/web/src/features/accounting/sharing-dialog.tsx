import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { unwrap, type components, type paths } from '@sesame-notes/api-client';
import { api, pushChange, queryClient, useSession } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { PendingOperationGuard } from './pending-operation-guard';
import { Button, Dialog, EmptyState, ErrorState, Field, LoadingState } from '../../components/ui';

type Ledger = components['schemas']['Ledger'];
type Member = components['schemas']['Member'];
type SharedMember =
  paths['/api/v1/ledgers/{ledger_id}/members']['get']['responses'][200]['content']['application/json'][number];
const nameSchema = z.object({ name: z.string().trim().min(1, '请输入成员名称').max(100, '最多 100 个字符') });

/** 管理真实共享成员与用于 AA 的虚拟成员，所有身份变化由服务端权限校验。 */
export function SharingDialog({
  ledger,
  onClose,
  onLeft,
}: {
  ledger: Ledger;
  onClose: () => void;
  onLeft: () => void;
}) {
  const { session } = useSession();
  const accountId = session?.user.user_id ?? '';
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [removing, setRemoving] = useState<
    { type: 'registered'; member: SharedMember } | { type: 'placeholder'; member: Member } | { type: 'self' } | null
  >(null);
  const [copyError, setCopyError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [expiresIn, setExpiresIn] = useState('24');
  const participants = useQuery({
    queryKey: ['account', accountId, 'accounting', ledger.id, 'participants'],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/participants', {
          signal,
          params: { path: { ledger_id: ledger.id } },
        }),
      ),
  });
  const members = useQuery({
    queryKey: ['account', accountId, 'accounting', ledger.id, 'shared-members'],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/ledgers/{ledger_id}/members', { signal, params: { path: { ledger_id: ledger.id } } }),
      ),
  });
  const invite = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST('/api/v1/ledgers/{ledger_id}/invites', {
          params: { path: { ledger_id: ledger.id } },
          body: { expires_in_hours: Number(expiresIn) },
        }),
      ),
    onSuccess: () => {
      setCopied(false);
      setCopyError(null);
    },
  });
  const pending = invite.isPending;
  const inviteUrl = invite.data
    ? `${window.location.origin}/accounting?invite=${encodeURIComponent(invite.data.code)}`
    : '';
  return (
    <>
      <Dialog
        open
        title="共享与成员"
        description={ledger.name}
        onClose={() => {
          if (!pending) onClose();
        }}
      >
        {pending && <PendingOperationGuard />}
        <div className="stack">
          <h3>共享成员</h3>
          {members.isPending ? (
            <LoadingState />
          ) : members.isError ? (
            <ErrorState error={members.error} retry={() => void members.refetch()} />
          ) : (
            <ul className="category-list">
              {members.data.map((member) => (
                <li key={member.member_id} className="toolbar">
                  <span>
                    {member.display_name || member.sesame_number || '账本成员'}
                    {member.user_id === accountId ? '（我）' : ''}{' '}
                    <span className="badge">{member.role === 'owner' ? '所有者' : '可编辑'}</span>
                  </span>
                  {ledger.role === 'owner' && member.role !== 'owner' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRemoving({ type: 'registered', member })}
                      aria-label={`移除共享成员 ${member.display_name || member.sesame_number}`}
                    >
                      <Trash2 size={16} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {ledger.role === 'owner' ? (
            <div className="stack">
              <Field label="邀请有效期">
                <select value={expiresIn} onChange={(event) => setExpiresIn(event.target.value)} disabled={pending}>
                  <option value="1">1 小时</option>
                  <option value="24">24 小时</option>
                  <option value="168">7 天</option>
                </select>
              </Field>
              <Button variant="secondary" disabled={pending} onClick={() => invite.mutate()}>
                {pending ? '生成中…' : invite.data ? '生成新的邀请码' : '生成邀请码'}
              </Button>
              {invite.data && (
                <div className="panel stack">
                  <Field label="邀请码">
                    <input readOnly value={invite.data.code} />
                  </Field>
                  <Field label="邀请链接">
                    <input readOnly value={inviteUrl} />
                  </Field>
                  <p className="muted">
                    有效至 {new Date(invite.data.expires_at).toLocaleString('zh-CN')}
                    。接受邀请后，对方可查看和编辑这个账本。
                  </p>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteUrl);
                        setCopied(true);
                        setCopyError(null);
                      } catch (error) {
                        setCopyError(error);
                      }
                    }}
                  >
                    <Copy size={16} />
                    {copied ? '已复制链接' : '复制邀请链接'}
                  </Button>
                  {copyError ? <ErrorState error={copyError} /> : null}
                </div>
              )}
              {invite.isError && <ErrorState error={invite.error} />}
            </div>
          ) : (
            <Button variant="danger" onClick={() => setRemoving({ type: 'self' })}>
              退出这个共享账本
            </Button>
          )}
          <h3>虚拟成员</h3>
          <p className="muted">用于记录没有账号的参与人，不会授予账号访问权限。</p>
          {participants.isPending ? (
            <LoadingState />
          ) : participants.isError ? (
            <ErrorState error={participants.error} retry={() => void participants.refetch()} />
          ) : (
            <>
              {!participants.data.some(
                (member) => member.member_type === 'PLACEHOLDER' && member.status === 'ACTIVE',
              ) ? (
                <EmptyState title="还没有虚拟成员" />
              ) : (
                <ul className="category-list">
                  {participants.data
                    .filter((member) => member.member_type === 'PLACEHOLDER' && member.status === 'ACTIVE')
                    .map((member) => (
                      <li className="toolbar" key={member.id}>
                        <span>{member.display_name}</span>
                        <div className="toolbar">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`编辑虚拟成员 ${member.display_name}`}
                            onClick={() => setEditing(member)}
                          >
                            <Pencil size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`移除虚拟成员 ${member.display_name}`}
                            onClick={() => setRemoving({ type: 'placeholder', member })}
                          >
                            <Trash2 size={16} />
                          </Button>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
              <Button variant="secondary" onClick={() => setEditing('new')}>
                <Plus size={16} />
                添加虚拟成员
              </Button>
            </>
          )}
        </div>
      </Dialog>
      {editing && (
        <PlaceholderEditor
          ledger={ledger}
          member={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <MemberRemoval
          ledger={ledger}
          target={removing}
          accountId={accountId}
          onClose={() => setRemoving(null)}
          onLeft={() => {
            setRemoving(null);
            onClose();
            onLeft();
          }}
        />
      )}
    </>
  );
}

/** 虚拟成员写入沿用统一同步协议；同一内容重试固定 mutation ID 与时间。 */
function PlaceholderEditor({ ledger, member, onClose }: { ledger: Ledger; member?: Member; onClose: () => void }) {
  const form = useForm<z.infer<typeof nameSchema>>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: member?.display_name ?? '' },
  });
  const [id] = useState(() => member?.id ?? crypto.randomUUID());
  const attempt = useRef({ value: '', mutationId: crypto.randomUUID(), at: new Date().toISOString() });
  const save = useMutation({
    mutationFn: async ({ name }: z.infer<typeof nameSchema>) => {
      if (attempt.current.value !== name)
        attempt.current = { value: name, mutationId: crypto.randomUUID(), at: new Date().toISOString() };
      await pushChange({
        entity_type: 'member',
        entity_id: id,
        ledger_id: ledger.id,
        sync_id: ledger.sync_id,
        mutation_id: attempt.current.mutationId,
        updated_at: attempt.current.at,
        action: 'upsert',
        payload: { display_name: name },
      });
    },
    onSuccess: completeSave,
  });
  const { close, finish, confirmation } = useDraftClose(form.formState.isDirty, save.isPending, onClose);
  /** 完成权威数据刷新后放行成功退出，避免草稿保护拦截程序内导航。 */
  function completeSave() {
    finish();
  }

  return (
    <Dialog open title={member ? '编辑虚拟成员' : '添加虚拟成员'} onClose={close}>
      <form className="stack" onSubmit={form.handleSubmit((value) => save.mutate(value))}>
        <fieldset disabled={save.isPending} className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Field label="成员名称" error={form.formState.errors.name?.message}>
            <input autoFocus {...form.register('name')} readOnly={save.isPending} />
          </Field>
          {save.isError && <ErrorState error={save.error} />}
          <div className="toolbar">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? '保存中…' : '保存成员'}
            </Button>
          </div>
        </fieldset>
      </form>
      {confirmation}
    </Dialog>
  );
}

/** 成员退出不会删除历史记录；占位成员删除与共享账号移除使用各自领域入口。 */
function MemberRemoval({
  ledger,
  target,
  accountId,
  onClose,
  onLeft,
}: {
  ledger: Ledger;
  target: { type: 'registered'; member: SharedMember } | { type: 'placeholder'; member: Member } | { type: 'self' };
  accountId: string;
  onClose: () => void;
  onLeft: () => void;
}) {
  const [mutationId] = useState(() => crypto.randomUUID());
  const [at] = useState(() => new Date().toISOString());
  const remove = useMutation({
    mutationFn: async () => {
      if (target.type === 'self')
        return unwrap(
          await api.POST('/api/v1/ledgers/{ledger_id}/leave', { params: { path: { ledger_id: ledger.id } } }),
        );
      if (target.type === 'registered')
        return unwrap(
          await api.DELETE('/api/v1/ledgers/{ledger_id}/members/{member_id}', {
            params: { path: { ledger_id: ledger.id, member_id: target.member.member_id } },
          }),
        );
      return pushChange({
        entity_type: 'member',
        entity_id: target.member.id,
        ledger_id: ledger.id,
        sync_id: ledger.sync_id,
        mutation_id: mutationId,
        updated_at: at,
        action: 'delete',
        payload: {},
      });
    },
    onSuccess: completeSave,
  });
  const { close, finish, confirmation } = useDraftClose(false, remove.isPending, onClose);
  /** 完成权威数据刷新后放行成功退出，避免草稿保护拦截程序内导航。 */
  async function completeSave() {
    await queryClient.invalidateQueries({ queryKey: ['account', accountId, 'accounting'] });
    finish(target.type === 'self' ? onLeft : undefined);
  }

  return (
    <Dialog
      open
      title={target.type === 'self' ? '退出共享账本？' : `移除 ${target.member.display_name ?? '这个成员'}？`}
      description={
        target.type === 'self'
          ? '退出后将无法访问此账本，已创建的记录仍由账本保留。重新加入需要邀请码。'
          : target.type === 'placeholder'
            ? '虚拟成员移除后不能恢复。仍被支出或 AA 分摊引用的成员无法移除，请先调整相关记录。'
            : '历史记录会保留。移除共享成员后，对方将无法继续访问账本。'
      }
      onClose={close}
    >
      {remove.isError && <ErrorState error={remove.error} />}
      <div className="toolbar">
        <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? '处理中…' : '确认移除或退出'}
        </Button>
      </div>
      {confirmation}
    </Dialog>
  );
}
