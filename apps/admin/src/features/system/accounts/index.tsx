import { useQuery } from '@tanstack/react-query';
import { useListQuerySubmit } from '../../../lib/use-list-query-submit';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useId, useState } from 'react';
import { z } from 'zod';
import {
  Button,
  ConfirmDialog,
  Empty,
  Loading,
  Modal,
  Pagination,
  RequestError,
  StatusBadge,
} from '../../../components/ui';
import { GroupSelect } from '../../../components/group-select';
import { api, errorMessage, request, InputError } from '../../../api/client';
import { useClampPage } from '../../../api/paging';
import { useSession, queryClient } from '../../../auth/session';
import { accountName, password, reason, validationError } from '../../../lib/validation';
import {
  contactsChanged,
  normalizeEmail,
  normalizePhone,
  optionalEmail,
  optionalPhone,
} from '../../../lib/contact-input';
import { dateTime, identityLabel, initialPaging } from '../../../api/types';
import type { Account, Paging } from '../../../api/types';
import { newAccountGroupSelection } from './default-assignment';

const formSchema = z.object({
  username: accountName,
  display_name: z.string().trim().min(1, '请输入显示名称。').max(64),
  email: optionalEmail,
  phone: optionalPhone,
  group_id: z.string(),
  password: z.string(),
  is_enabled: z.boolean(),
  reason: z.string().max(500),
});
type AccountDialog = { kind: 'edit' | 'more' | 'identity' | 'password' | 'delete'; account?: Account } | null;

/** 后台用户列表由服务端筛选分页，身份和组归属保持独立维度。 */
export function AccountsPage({ active }: { active: boolean }) {
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ q: '', identity: '', group: '', enabled: '' });
  const [draftFilters, setDraftFilters] = useState(filters);
  const [dialog, setDialog] = useState<AccountDialog>(null);
  const session = useSession();
  const queryKey = ['admin', 'accounts', filters, paging];
  const submitQuery = useListQuerySubmit(queryKey, active);
  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: ({ signal }) =>
      request(
        () =>
          api.adminAccounts.list(
            {
              ...paging,
              q: filters.q || undefined,
              identity_type: filters.identity ? (filters.identity as Account['identity_type']) : undefined,
              group_id: filters.group || undefined,
              is_enabled: filters.enabled ? filters.enabled === 'true' : undefined,
            },
            signal,
          ),
        'list-accounts',
      ),
  });
  useClampPage(query.data?.total, paging, setPaging);
  /** 删除成功后刷新账号、用户组及日志；服务端负责本人和最后超级管理员保护。 */
  async function remove(reason: string) {
    const account = dialog?.account;
    if (!account) return;
    try {
      await request(() => api.adminAccounts.delete(account.id, { version: account.version, reason }), 'delete-account');
    } finally {
      await invalidateAccountData();
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>后台用户</h1>
        <Button variant="primary" onClick={() => setDialog({ kind: 'edit' })}>
          新增后台用户
        </Button>
      </div>
      <section className="panel">
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const nextFilters = { ...draftFilters, q: q.trim() };
            const nextPaging = { ...paging, page: 1 };
            submitQuery(['admin', 'accounts', nextFilters, nextPaging], () => {
              setFilters(nextFilters);
              setPaging(nextPaging);
            });
          }}
        >
          <div className="filter-grid">
            <label className="field">
              登录账号 / 显示名称 / 邮箱 / 手机号
              <input value={q} onChange={(event) => setQ(event.target.value)} autoComplete="off" />
            </label>
            <label className="field">
              身份
              <select
                value={draftFilters.identity}
                onChange={(event) => setDraftFilters({ ...draftFilters, identity: event.target.value })}
              >
                <option value="">全部身份</option>
                <option value="super_admin">超级管理员</option>
                <option value="standard_user">普通用户</option>
              </select>
            </label>
            <div className="field">
              用户组
              <GroupSelect
                value={draftFilters.group}
                mode="filter"
                onChange={(group) => setDraftFilters({ ...draftFilters, group })}
              />
            </div>
            <label className="field">
              启用状态
              <select
                value={draftFilters.enabled}
                onChange={(event) => setDraftFilters({ ...draftFilters, enabled: event.target.value })}
              >
                <option value="">全部状态</option>
                <option value="true">已启用</option>
                <option value="false">已禁用</option>
              </select>
            </label>
          </div>
          <Button type="submit" variant="primary" disabled={query.isFetching}>
            查询
          </Button>
          <Button
            onClick={() => {
              const empty = { q: '', identity: '', group: '', enabled: '' };
              setFilters(empty);
              setDraftFilters(empty);
              setQ('');
              setPaging(initialPaging);
            }}
          >
            重置
          </Button>
        </form>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <RequestError error={query.error} retry={() => void query.refetch()} />
        ) : query.data.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>登录账号</th>
                  <th>显示名称</th>
                  <th>邮箱</th>
                  <th>手机号</th>
                  <th>身份</th>
                  <th>用户组</th>
                  <th>状态</th>
                  <th>最近登录</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((account) => (
                  <tr key={account.id}>
                    <td data-label="登录账号">
                      {account.username}
                      {account.id === session.session!.admin.id && <small className="muted"> 本人</small>}
                    </td>
                    <td data-label="显示名称">{account.display_name}</td>
                    <td data-label="邮箱">{account.email || '未设置'}</td>
                    <td data-label="手机号">{account.phone || '未设置'}</td>
                    <td data-label="身份">{identityLabel(account.identity_type)}</td>
                    <td data-label="用户组">{account.group.name}</td>
                    <td data-label="状态">
                      <StatusBadge enabled={account.is_enabled} />
                    </td>
                    <td data-label="最近登录">{dateTime(account.last_login_at)}</td>
                    <td data-label="操作">
                      <div className="row-actions">
                        <Button variant="ghost" onClick={() => setDialog({ kind: 'edit', account })}>
                          修改
                        </Button>
                        <Button variant="ghost" onClick={() => setDialog({ kind: 'more', account })}>
                          更多
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>没有匹配的后台用户</Empty>
        )}
        {query.data && (
          <Pagination value={paging} total={query.data.total} onChange={setPaging} disabled={query.isFetching} />
        )}
      </section>
      {dialog?.kind === 'edit' && <AccountEditor account={dialog.account} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'more' && dialog.account && (
        <Modal
          title={dialog.account.username}
          titleAside={<StatusBadge enabled={dialog.account.is_enabled} />}
          onClose={() => setDialog(null)}
        >
          <dl className="detail-grid">
            {[
              ['显示名称', dialog.account.display_name],
              ['邮箱', dialog.account.email || '未设置'],
              ['手机号', dialog.account.phone || '未设置'],
              ['创建人', dialog.account.created_by || '未提供'],
              ['创建时间', dateTime(dialog.account.created_at)],
              ['修改人', dialog.account.updated_by || '未提供'],
              ['更新时间', dateTime(dialog.account.updated_at)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="action-menu">
            <Button onClick={() => setDialog({ ...dialog, kind: 'identity' })}>设置身份</Button>
            {dialog.account.id !== session.session!.admin.id && (
              <Button onClick={() => setDialog({ ...dialog, kind: 'password' })}>重置密码</Button>
            )}
            <Button
              variant="danger"
              disabled={dialog.account.id === session.session!.admin.id}
              onClick={() => setDialog({ ...dialog, kind: 'delete' })}
            >
              删除后台用户
            </Button>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'identity' && dialog.account && (
        <IdentityEditor account={dialog.account} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'password' && dialog.account && (
        <PasswordReset account={dialog.account} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && dialog.account && (
        <ConfirmDialog title="删除后台用户" confirmText="确认删除" onClose={() => setDialog(null)} onConfirm={remove}>
          <div className="impact">
            <strong>{dialog.account.username}</strong>
            <p>删除后无法登录，旧会话失效。登录账号与历史操作记录保留。</p>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}

/** 账号变更关联多个列表，失败时也重新读取以核对不确定结果。 */
async function invalidateAccountData() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
  ]);
}

/** 创建和编辑共享资料表单，修改登录账号只读，新账号默认普通用户。 */
function AccountEditor({ account, onClose }: { account?: Account; onClose: () => void }) {
  const contactInputId = useId();
  const session = useSession();
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: account?.username || '',
      display_name: account?.display_name || '',
      email: account?.email || '',
      phone: account?.phone || '',
      group_id: account?.group_id || '',
      password: '',
      is_enabled: account?.is_enabled ?? true,
      reason: '',
    },
  });
  const groupId = form.watch('group_id');
  const enabled = form.watch('is_enabled');
  const email = form.watch('email');
  const phone = form.watch('phone');
  const changesAuth =
    account &&
    (account.group_id !== groupId || account.is_enabled !== enabled || contactsChanged(account, { email, phone }));
  /** 保存时携带读取版本，登录联系方式、状态或换组变更必须记录原因。 */
  async function submit(value: z.infer<typeof formSchema>) {
    setError('');
    if (account && !value.group_id) {
      setError('请选择默认分组或其他用户组。');
      return;
    }
    const invalid = account
      ? changesAuth
        ? validationError(reason, value.reason)
        : null
      : validationError(password, value.password);
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      if (account)
        await request(
          () =>
            api.adminAccounts.update(account.id, {
              version: account.version,
              display_name: value.display_name,
              email: normalizeEmail(value.email),
              phone: normalizePhone(value.phone),
              group_id: value.group_id,
              is_enabled: value.is_enabled,
              reason: value.reason.trim() || undefined,
            }),
          'edit-account',
        );
      else
        await request(
          () =>
            api.adminAccounts.create({
              username: value.username,
              display_name: value.display_name,
              email: normalizeEmail(value.email),
              phone: normalizePhone(value.phone),
              ...newAccountGroupSelection(value.group_id),
              password: value.password,
            }),
          'create-account',
        );
      form.resetField('password');
      await invalidateAccountData();
      if (account?.id === session.session!.admin.id && changesAuth) session.end('登录信息或权限已变化，请重新登录。');
      else {
        if (account?.id === session.session!.admin.id) await session.verify();
        onClose();
      }
    } catch (failure) {
      setError(errorMessage(failure));
      await invalidateAccountData();
    }
  }
  return (
    <Modal title={account ? '修改后台用户' : '新增后台用户'} onClose={onClose} busy={form.formState.isSubmitting}>
      <form className="form-stack" onSubmit={form.handleSubmit(submit)}>
        <div className="field-row">
          <label className="field">
            登录账号
            <input {...form.register('username')} readOnly={!!account} autoComplete="off" />
          </label>
          <label className="field">
            显示名称
            <input {...form.register('display_name')} maxLength={64} />
          </label>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor={`${contactInputId}-email`}>邮箱（选填）</label>
            <div className="inline-fields">
              <input
                id={`${contactInputId}-email`}
                {...form.register('email')}
                inputMode="email"
                autoComplete="off"
                maxLength={254}
              />
              {account?.email && (
                <Button
                  variant="ghost"
                  disabled={!normalizeEmail(email) || form.formState.isSubmitting}
                  onClick={() => form.setValue('email', '', { shouldDirty: true, shouldValidate: true })}
                >
                  解绑邮箱
                </Button>
              )}
            </div>
            {account?.email && !normalizeEmail(email) && <small>保存后解绑邮箱。</small>}
          </div>
          <div className="field">
            <label htmlFor={`${contactInputId}-phone`}>手机号（选填）</label>
            <div className="inline-fields">
              <input
                id={`${contactInputId}-phone`}
                {...form.register('phone')}
                type="tel"
                autoComplete="off"
                placeholder="国内手机号或 +国际区号"
              />
              {account?.phone && (
                <Button
                  variant="ghost"
                  disabled={!normalizePhone(phone) || form.formState.isSubmitting}
                  onClick={() => form.setValue('phone', '', { shouldDirty: true, shouldValidate: true })}
                >
                  解绑手机号
                </Button>
              )}
            </div>
            {account?.phone && !normalizePhone(phone) && <small>保存后解绑手机号。</small>}
          </div>
        </div>
        <div className="field">
          用户组
          <GroupSelect
            value={groupId}
            selected={account?.group}
            mode={account ? 'edit' : 'create'}
            defaultGroup={session.session!.admin.group.is_default ? session.session!.admin.group : undefined}
            onChange={(id) => form.setValue('group_id', id, { shouldValidate: true })}
          />
          {!account && <small>未手动选择时，账号会自动归入默认用户组。</small>}
        </div>
        {account ? (
          <label className="field">
            启用状态
            <select
              value={enabled ? 'true' : 'false'}
              disabled={account.id === session.session!.admin.id}
              onChange={(event) => form.setValue('is_enabled', event.target.value === 'true')}
            >
              <option value="true">已启用</option>
              <option value="false">已禁用</option>
            </select>
            {account.id === session.session!.admin.id && <small>不能停用当前登录账号。</small>}
          </label>
        ) : (
          <label className="field">
            登录密码
            <input {...form.register('password')} type="password" autoComplete="new-password" />
          </label>
        )}
        {changesAuth && (
          <>
            <div className="notice">变更将撤销该账号的后台会话，需要重新登录。</div>
            <label className="field">
              操作原因
              <textarea {...form.register('reason')} maxLength={500} />
            </label>
          </>
        )}
        {(error || Object.keys(form.formState.errors).length > 0) && (
          <div role="alert" className="form-error">
            {error || Object.values(form.formState.errors)[0]?.message}
          </div>
        )}
        <div className="dialog-actions">
          <Button disabled={form.formState.isSubmitting} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={form.formState.isSubmitting}
            onClick={() => void form.handleSubmit(submit)()}
          >
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** 身份选项来自受控目录，保存单个身份字段并保留用户组。 */
function IdentityEditor({ account, onClose }: { account: Account; onClose: () => void }) {
  const session = useSession();
  const [identity, setIdentity] = useState(account.identity_type);
  const catalog = useQuery({
    queryKey: ['admin', 'identity-catalog'],
    queryFn: ({ signal }) => request(() => api.adminCatalog.identities(signal), 'identity-catalog'),
  });
  /** 设置本人身份成功时结束旧会话，其他账号变更仅刷新列表。 */
  async function save(reason: string) {
    try {
      if (identity !== account.identity_type)
        await request(
          () =>
            api.adminAccounts.setIdentity(account.id, { version: account.version, identity_type: identity, reason }),
          'set-identity',
        );
      await invalidateAccountData();
      if (identity !== account.identity_type && account.id === session.session!.admin.id)
        session.end('身份已变化，请重新登录。');
    } catch (error) {
      await invalidateAccountData();
      throw error;
    }
  }
  return (
    <ConfirmDialog title="设置身份" confirmText="保存身份" danger={false} onClose={onClose} onConfirm={save}>
      <p>{account.username}</p>
      {catalog.isPending ? (
        <Loading />
      ) : catalog.isError ? (
        <RequestError error={catalog.error} retry={() => void catalog.refetch()} />
      ) : (
        <label className="field">
          身份
          <select value={identity} onChange={(event) => setIdentity(event.target.value as Account['identity_type'])}>
            {catalog.data.items.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="notice">身份变化会撤销旧会话，原用户组归属保留。</div>
    </ConfirmDialog>
  );
}

/** 重置密码不回显或保存新密码，成功后账号必须重新登录。 */
function PasswordReset({ account, onClose }: { account: Account; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [invalid, setInvalid] = useState('');
  /** 重置前验证字符限制与确认值，失败保留表单等待用户处理。 */
  async function save(reason: string) {
    const problem = validationError(password, value) || (value !== confirmation ? '两次输入的密码不一致。' : '');
    if (problem) {
      setInvalid(problem);
      throw new InputError(problem);
    }
    try {
      await request(
        () => api.adminAccounts.resetPassword(account.id, { version: account.version, new_password: value, reason }),
        'reset-account-password',
      );
      setValue('');
      setConfirmation('');
      await invalidateAccountData();
    } catch (error) {
      await invalidateAccountData();
      throw error;
    }
  }
  return (
    <ConfirmDialog title="重置密码" confirmText="确认重置" onClose={onClose} onConfirm={save}>
      <p>后台用户：{account.username}</p>
      <label className="field">
        新密码
        <input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <label className="field">
        确认新密码
        <input
          type="password"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      {invalid && (
        <div role="alert" className="form-error">
          {invalid}
        </div>
      )}
      <p>重置后该账号的全部后台会话失效。</p>
    </ConfirmDialog>
  );
}
