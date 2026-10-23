import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
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
import { api, errorMessage, InputError, reportError, request } from '../../../api/client';
import { queryClient, useSession } from '../../../auth/session';
import { useClampPage } from '../../../api/paging';
import { useListQuerySubmit } from '../../../lib/use-list-query-submit';
import { dateTime, identityLabel, initialPaging } from '../../../api/types';
import type { Account, Group, Paging, PermissionCatalog } from '../../../api/types';
import { reason, validationError } from '../../../lib/validation';
import {
  businessPages,
  changePermissions,
  permissionDirectories,
  permissionLeaves,
  permittedCatalog,
  selectionState,
} from './permissions';
import type { PermissionSelection } from './permissions';
import { groupFormSchema as groupSchema, GROUP_SORT_MIN, GROUP_SORT_MAX } from './group-form';
type GroupDialog = { kind: 'edit' | 'permissions' | 'members' | 'delete'; group?: Group } | null;

/** 自定义组列表、配置和成员来自服务端，内部编码不进入界面。 */
export function GroupsPage({ active }: { active: boolean }) {
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [dialog, setDialog] = useState<GroupDialog>(null);
  const queryKey = ['admin', 'groups', 'list', search, paging];
  const submitQuery = useListQuerySubmit(queryKey, active);
  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: ({ signal }) =>
      request(() => api.adminGroups.list({ ...paging, q: search || undefined }, signal), 'list-groups'),
  });
  useClampPage(query.data?.total, paging, setPaging);
  /** 服务端核对当前成员与版本后删除，失败刷新状态。 */
  async function remove(reason: string) {
    const group = dialog?.group;
    if (!group) return;
    if (group.is_default) throw new InputError('默认用户组不能删除。');
    try {
      await request(() => api.adminGroups.delete(group.id, { version: group.version, reason }), 'delete-group');
    } finally {
      await invalidateGroups();
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>用户组管理</h1>
        <Button variant="primary" onClick={() => setDialog({ kind: 'edit' })}>
          新增用户组
        </Button>
      </div>
      <section className="panel">
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const nextSearch = draft.trim();
            const nextPaging = { ...paging, page: 1 };
            submitQuery(['admin', 'groups', 'list', nextSearch, nextPaging], () => {
              setSearch(nextSearch);
              setPaging(nextPaging);
            });
          }}
        >
          <label className="field search-field">
            名称
            <input value={draft} onChange={(event) => setDraft(event.target.value)} />
          </label>
          <Button type="submit" variant="primary" disabled={query.isFetching}>
            查询
          </Button>
          <Button
            onClick={() => {
              setDraft('');
              setSearch('');
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
                  <th>名称</th>
                  <th>说明</th>
                  <th>成员数</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((group) => (
                  <tr key={group.id}>
                    <td data-label="名称">
                      <div>
                        {group.name}
                        {group.is_default && (
                          <>
                            {' '}
                            <span className="badge">默认</span>
                          </>
                        )}
                      </div>
                    </td>
                    <td data-label="说明">{group.description || '未填写'}</td>
                    <td data-label="成员数">{group.member_count}</td>
                    <td data-label="状态">
                      <StatusBadge enabled={group.is_enabled} />
                    </td>
                    <td data-label="更新时间">{dateTime(group.updated_at)}</td>
                    <td data-label="操作">
                      <div className="row-actions">
                        <Button variant="ghost" onClick={() => setDialog({ kind: 'edit', group })}>
                          修改
                        </Button>
                        <Button variant="ghost" onClick={() => setDialog({ kind: 'permissions', group })}>
                          权限配置
                        </Button>
                        <Button variant="ghost" onClick={() => setDialog({ kind: 'members', group })}>
                          成员管理
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={group.is_default}
                          aria-describedby={group.is_default ? `default-group-${group.id}` : undefined}
                          onClick={() => setDialog({ kind: 'delete', group })}
                        >
                          删除
                        </Button>
                        {group.is_default && <small id={`default-group-${group.id}`}>默认组不能删除</small>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>没有匹配的用户组</Empty>
        )}
        {query.data && (
          <Pagination value={paging} total={query.data.total} onChange={setPaging} disabled={query.isFetching} />
        )}
      </section>
      {dialog?.kind === 'edit' && <GroupEditor group={dialog.group} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'permissions' && dialog.group && (
        <GroupPermissions group={dialog.group} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'members' && dialog.group && (
        <GroupMembers group={dialog.group} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && dialog.group && (
        <ConfirmDialog title="删除用户组" confirmText="确认删除" onConfirm={remove} onClose={() => setDialog(null)}>
          <div className="impact">
            <strong>{dialog.group.name}</strong>
            <p>
              {dialog.group.member_count > 0
                ? '该组仍有成员，需要先转移成员后才能删除。'
                : '删除后不能再分配给账号，历史操作记录保留。'}
            </p>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}

/** 组变更同步刷新账号、成员和日志查询。 */
async function invalidateGroups() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin', 'groups'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'accounts'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
  ]);
}

/** 基础资料与权限分开编辑，名称唯一性由服务端核对。 */
function GroupEditor({ group, onClose }: { group?: Group; onClose: () => void }) {
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof groupSchema>>({
    resolver: zodResolver(groupSchema),
    defaultValues: {
      name: group?.name || '',
      description: group?.description || '',
      sort: group?.sort ?? 50,
      is_enabled: group?.is_enabled ?? true,
      reason: '',
    },
  });
  const enabledChanged = group && form.watch('is_enabled') !== group.is_enabled;
  /** 启停变更必须填写原因，名称和排序不会隐式改变授权。 */
  async function submit(value: z.infer<typeof groupSchema>) {
    setError('');
    if (group?.is_default && !value.is_enabled) {
      setError('默认用户组不能停用。');
      return;
    }
    const invalid = enabledChanged ? validationError(reason, value.reason) : null;
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      if (group)
        await request(
          () =>
            api.adminGroups.update(group.id, {
              version: group.version,
              name: value.name,
              description: value.description,
              sort: value.sort,
              is_enabled: value.is_enabled,
              reason: value.reason.trim() || undefined,
            }),
          'edit-group',
        );
      else
        await request(
          () =>
            api.adminGroups.create({
              name: value.name,
              description: value.description,
              sort: value.sort,
              is_enabled: value.is_enabled,
            }),
          'create-group',
        );
      await invalidateGroups();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      await invalidateGroups();
    }
  }
  return (
    <Modal title={group ? '修改用户组' : '新增用户组'} busy={form.formState.isSubmitting} onClose={onClose}>
      <form className="form-stack" onSubmit={form.handleSubmit(submit)}>
        {group?.is_default && <div className="notice">默认用户组不能停用或删除，名称、说明和权限可以修改。</div>}
        <label className="field">
          名称
          <input {...form.register('name')} maxLength={32} />
        </label>
        <label className="field">
          说明
          <textarea {...form.register('description')} maxLength={200} />
        </label>
        <div className="field-row">
          <label className="field">
            排序
            <input
              {...form.register('sort', { valueAsNumber: true })}
              type="number"
              min={GROUP_SORT_MIN}
              max={GROUP_SORT_MAX}
              step={1}
            />
          </label>
          <label className="field">
            启用状态
            <select
              value={form.watch('is_enabled') ? 'true' : 'false'}
              disabled={group?.is_default}
              onChange={(event) => form.setValue('is_enabled', event.target.value === 'true')}
            >
              <option value="true">已启用</option>
              <option value="false">已禁用</option>
            </select>
          </label>
        </div>
        {enabledChanged && (
          <>
            <div className="notice">状态变化会撤销受影响普通用户的后台会话。</div>
            <label className="field">
              操作原因
              <textarea {...form.register('reason')} maxLength={500} />
            </label>
          </>
        )}
        {!group && <p className="muted">新用户组默认没有业务权限，创建后可配置授权。</p>}
        {group && (
          <dl className="detail-grid">
            <div>
              <dt>创建人</dt>
              <dd>{group.created_by || '未提供'}</dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{dateTime(group.created_at)}</dd>
            </div>
            <div>
              <dt>修改人</dt>
              <dd>{group.updated_by || '未提供'}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{dateTime(group.updated_at)}</dd>
            </div>
          </dl>
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

/** 父复选框通过原生 indeterminate 显示部分选中。 */
function TreeCheck({
  label,
  state,
  onChange,
}: {
  label: string;
  state: 'all' | 'some' | 'none';
  onChange: (enabled: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <label className="check-row">
      <input
        ref={ref}
        type="checkbox"
        checked={state === 'all'}
        aria-checked={state === 'some' ? 'mixed' : state === 'all'}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

/** 权限只修改草稿，取消不写入，保存带版本防止并发覆盖。 */
function GroupPermissions({ group, onClose }: { group: Group; onClose: () => void }) {
  const [selection, setSelection] = useState<PermissionSelection>({
    permissions: [...group.permissions],
    page_ids: [...group.page_ids],
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    application: true,
    system: true,
    users: true,
    audit: true,
  });
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ['admin', 'permission-catalog'],
    queryFn: ({ signal }) => request(() => api.adminCatalog.permissions(signal), 'permission-catalog'),
  });
  /** 统一依赖算法保证联动，未知节点不会进入提交载荷。 */
  function change(keys: string[], enabled: boolean) {
    if (!query.data) return;
    try {
      setSelection(changePermissions(selection, keys, enabled, query.data));
      setError('');
    } catch (failure) {
      reportError('permission-selection', failure);
      setError('权限目录不可用，请刷新后重试。');
    }
  }
  /** 保存授权与原因，后端同事务记录日志并撤相关会话。 */
  async function save() {
    const invalid = validationError(reason, value);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request(
        () => api.adminGroups.setPermissions(group.id, { version: group.version, ...selection, reason: value.trim() }),
        'save-group-permissions',
      );
      await invalidateGroups();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      await invalidateGroups();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="用户组权限" busy={busy} onClose={onClose}>
      <div className="form-stack">
        <div>
          <h3>{group.name}</h3>
          <p className="muted">共 {group.member_count} 名成员。授权变化后，受影响普通用户需要重新登录。</p>
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <RequestError error={query.error} retry={() => void query.refetch()} />
        ) : (
          <>
            <div className="tree-toolbar">
              <TreeCheck
                label="全选业务权限"
                state={selectionState(selection, permissionLeaves(query.data))}
                onChange={(enabled) => change(permissionLeaves(query.data), enabled)}
              />
              <Button
                variant="ghost"
                onClick={() =>
                  setExpanded(
                    Object.fromEntries(
                      [...permissionDirectories.map((directory) => directory.id), ...Object.keys(businessPages)].map(
                        (id) => [id, true],
                      ),
                    ),
                  )
                }
              >
                全部展开
              </Button>
              <Button variant="ghost" onClick={() => setExpanded({})}>
                全部收起
              </Button>
              <Button variant="ghost" onClick={() => setSelection({ permissions: [], page_ids: [] })}>
                清空
              </Button>
            </div>
            <PermissionTree
              catalog={query.data}
              selection={selection}
              expanded={expanded}
              toggle={(id) => setExpanded({ ...expanded, [id]: !expanded[id] })}
              change={change}
            />
            <p className="muted">
              勾选操作会同时勾选必要的查询权限；取消查询会取消依赖操作。访问页面与业务操作分别配置。
            </p>
            <label className="field">
              操作原因
              <textarea value={value} maxLength={500} onChange={(event) => setValue(event.target.value)} />
            </label>
          </>
        )}
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={busy || !query.data} onClick={() => void save()}>
            保存权限
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** 树目录仅组织节点，后台控制能力显示锁定并排除于全选。 */
function PermissionTree({
  catalog,
  selection,
  expanded,
  toggle,
  change,
}: {
  catalog: PermissionCatalog;
  selection: PermissionSelection;
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
  change: (keys: string[], enabled: boolean) => void;
}) {
  const allowed = permittedCatalog(catalog);
  return (
    <div className="permission-tree">
      {permissionDirectories.map((directory) => (
        <section key={directory.id}>
          <div className="tree-heading">
            <Button
              variant="ghost"
              aria-label={`${expanded[directory.id] ? '收起' : '展开'}${directory.label}`}
              aria-expanded={!!expanded[directory.id]}
              onClick={() => toggle(directory.id)}
            >
              {expanded[directory.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </Button>
            <TreeCheck
              label={directory.label}
              state={selectionState(selection, permissionLeaves(catalog, directory.id))}
              onChange={(enabled) => change(permissionLeaves(catalog, directory.id), enabled)}
            />
          </div>
          {expanded[directory.id] && (
            <div className="tree-children">
              {directory.pages.map((pageId) => (
                <div key={pageId}>
                  <div className="tree-heading">
                    <Button
                      variant="ghost"
                      aria-label={`${expanded[pageId] ? '收起' : '展开'}${businessPages[pageId]}权限`}
                      aria-expanded={!!expanded[pageId]}
                      onClick={() => toggle(pageId)}
                    >
                      {expanded[pageId] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </Button>
                    <TreeCheck
                      label={businessPages[pageId]}
                      state={selectionState(selection, permissionLeaves(catalog, pageId))}
                      onChange={(enabled) => change(permissionLeaves(catalog, pageId), enabled)}
                    />
                  </div>
                  {expanded[pageId] && (
                    <div className="tree-children">
                      {permissionLeaves(catalog, pageId).map((key) => (
                        <TreeCheck
                          key={key}
                          label={
                            key.startsWith('page:')
                              ? '访问页面'
                              : allowed.permissions.find((permission) => permission.id === key.slice(11))?.label ||
                                '未知权限'
                          }
                          state={selectionState(selection, [key])}
                          onChange={(enabled) => change([key], enabled)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {directory.id === 'fitness' &&
                allowed.permissions
                  .filter((permission) => permission.id.startsWith('fitness:'))
                  .map((permission) => (
                    <TreeCheck
                      key={permission.id}
                      label={permission.label}
                      state={selectionState(selection, [`permission:${permission.id}`])}
                      onChange={(enabled) => change([`permission:${permission.id}`], enabled)}
                    />
                  ))}
              {directory.id === 'system' && (
                <>
                  {allowed.permissions.some((permission) => permission.id === 'status:read') && (
                    <TreeCheck
                      label={allowed.permissions.find((permission) => permission.id === 'status:read')!.label}
                      state={selectionState(selection, ['permission:status:read'])}
                      onChange={(enabled) => change(['permission:status:read'], enabled)}
                    />
                  )}
                  <p className="muted tree-locked">后台用户、用户组管理 · 仅超级管理员</p>
                </>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** 成员跨页勾选保存账号和原组版本，后端原子检查后批量转入唯一目标组。 */
function GroupMembers({ group, onClose }: { group: Group; onClose: () => void }) {
  const [mode, setMode] = useState<'members' | 'candidates' | 'confirm'>('members');
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<Record<string, Account>>({});
  const session = useSession();
  const queryKey = ['admin', 'groups', group.id, mode === 'members' ? 'members' : 'candidates', search, paging];
  const submitQuery = useListQuerySubmit(queryKey, mode !== 'confirm');
  const query = useQuery({
    queryKey,
    enabled: mode !== 'confirm',
    queryFn: ({ signal }) =>
      request(
        () =>
          mode === 'members'
            ? api.adminGroups.members(group.id, { ...paging, q: search || undefined }, signal)
            : api.adminGroups.candidates(group.id, { ...paging, q: search || undefined }, signal),
        'group-members',
      ),
  });
  useClampPage(query.data?.total, paging, setPaging);
  /** 全批成功才结束选择，失败保留快照等待重新核对。 */
  async function transfer(reason: string) {
    const members = Object.values(selected).map((account) => ({
      admin_id: account.id,
      version: account.version,
      group_id: account.group_id,
      group_version: account.group.version,
    }));
    try {
      const result = await request(
        () => api.adminGroups.transferMembers(group.id, { version: group.version, members, reason }),
        'transfer-group-members',
      );
      await invalidateGroups();
      if (result.self_session_revoked) session.end('所属用户组已变化，请重新登录。');
      else onClose();
    } catch (error) {
      await invalidateGroups();
      throw error;
    }
  }
  if (mode === 'confirm')
    return (
      <ConfirmDialog
        title="确认添加成员"
        confirmText="确认转入"
        danger={false}
        onClose={() => setMode('candidates')}
        onConfirm={transfer}
      >
        <p>以下账号将转入「{group.name}」，替换原归属并撤销后台会话：</p>
        <ul className="transfer-list">
          {Object.values(selected).map((account) => (
            <li key={account.id}>
              <strong>{account.username}</strong>
              <span>
                {account.group.name} → {group.name}
              </span>
            </li>
          ))}
        </ul>
        {!group.is_enabled && <div className="notice">目标组已停用，转入的普通用户将只有本人中心权限。</div>}
        {selected[session.session!.admin.id] && <div className="notice">包含当前账号，成功后你需要重新登录。</div>}
      </ConfirmDialog>
    );
  return (
    <Modal title={`${group.name} · 成员管理`} onClose={onClose}>
      <div className="form-stack">
        <div className="page-heading">
          <span>{mode === 'members' ? '当前成员' : `已选择 ${Object.keys(selected).length} 个账号`}</span>
          {mode === 'members' && (
            <Button
              variant="primary"
              onClick={() => {
                setMode('candidates');
                setPaging(initialPaging);
                setSearch('');
                setDraft('');
              }}
            >
              添加成员
            </Button>
          )}
        </div>
        <form
          className="inline-fields"
          onSubmit={(event) => {
            event.preventDefault();
            const nextSearch = draft.trim();
            const nextPaging = { ...paging, page: 1 };
            submitQuery(
              ['admin', 'groups', group.id, mode === 'members' ? 'members' : 'candidates', nextSearch, nextPaging],
              () => {
                setSearch(nextSearch);
                setPaging(nextPaging);
              },
            );
          }}
        >
          <input
            aria-label="搜索成员登录账号、显示名称、邮箱或手机号"
            placeholder="登录账号 / 显示名称 / 邮箱 / 手机号"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" disabled={query.isFetching}>
            查询
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
                  <th>{mode === 'members' ? '身份' : '原用户组'}</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((account) => (
                  <tr key={account.id}>
                    <td data-label="登录账号">
                      {mode === 'candidates' ? (
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={!!selected[account.id]}
                            onChange={(event) =>
                              setSelected((current) => {
                                const next = { ...current };
                                if (event.target.checked) next[account.id] = account;
                                else delete next[account.id];
                                return next;
                              })
                            }
                          />
                          {account.username}
                        </label>
                      ) : (
                        account.username
                      )}
                    </td>
                    <td data-label="显示名称">{account.display_name}</td>
                    <td data-label="邮箱">{account.email || '未设置'}</td>
                    <td data-label="手机号">{account.phone || '未设置'}</td>
                    <td data-label={mode === 'members' ? '身份' : '原用户组'}>
                      {mode === 'members' ? identityLabel(account.identity_type) : account.group.name}
                    </td>
                    <td data-label="状态">
                      <StatusBadge enabled={account.is_enabled} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{mode === 'members' ? '暂无成员' : '没有可转入的匹配账号'}</Empty>
        )}
        {query.data && <Pagination value={paging} total={query.data.total} onChange={setPaging} />}
        <div className="dialog-actions">
          {mode === 'candidates' && (
            <>
              <Button
                onClick={() => {
                  setMode('members');
                  setSelected({});
                  setPaging(initialPaging);
                  setSearch('');
                  setDraft('');
                }}
              >
                取消选择
              </Button>
              <Button variant="primary" disabled={!Object.keys(selected).length} onClick={() => setMode('confirm')}>
                下一步
              </Button>
            </>
          )}
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Modal>
  );
}
