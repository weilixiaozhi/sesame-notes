import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Button, ConfirmDialog, Empty, Loading, Pagination, RequestError, StatusBadge } from '../../../components/ui';
import { api, request } from '../../../api/client';
import { useSession, queryClient } from '../../../auth/session';
import { dateTime, initialPaging } from '../../../api/types';
import type { Device, Paging, User, UserDetail } from '../../../api/types';
import { useClampPage } from '../../../api/paging';
import { ChangeAvatarDialog, ChangePhoneDialog, DeleteAvatarDialog, ResetPasswordDialog } from './account-dialogs';
import { UserAvatar, userAvatarUrl } from './user-avatar';
import { useListQuerySubmit } from '../../../lib/use-list-query-submit';

/** 性别只显示用户自填值，不依据昵称或头像推断。 */
function gender(value: string): string {
  return value === 'MALE' ? '男' : value === 'FEMALE' ? '女' : '未设置';
}

/** 应用用户页状态只驻留组件内存，页签切换不卸载，手机号查询不进入 URL。 */
export function UsersPage({
  active,
  userId,
  navigate,
}: {
  active: boolean;
  userId?: string;
  navigate: (path: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [target, setTarget] = useState<User | UserDetail | null>(null);
  const admin = useSession().session!.admin;
  const canWrite = admin.permissions.includes('users:write');
  const queryKey = ['admin', 'users', search, status, paging];
  const submitQuery = useListQuerySubmit(queryKey, active && !userId);
  const list = useQuery({
    queryKey,
    enabled: active && !userId,
    queryFn: ({ signal }) =>
      request(
        () =>
          api.adminUsers.list(
            { ...paging, search: search || undefined, is_enabled: status ? status === 'true' : undefined },
            signal,
          ),
        'list-users',
      ),
  });
  useClampPage(list.data?.total, paging, setPaging);
  /** 用户启停成功后同步刷新所有列表与详情，不乐观覆盖服务端状态。 */
  async function changeEnabled(reason: string) {
    if (!target) return;
    try {
      await request(() => api.adminUsers.setEnabled(target.id, !target.is_enabled, { reason }), 'change-user-status');
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    }
  }
  return (
    <>
      <h1 className="sr-only">用户管理</h1>
      {userId ? (
        <UserDetails
          key={userId}
          userId={userId}
          active={active}
          back={() => navigate('/application/users')}
          onStatus={setTarget}
        />
      ) : (
        <section className="panel">
          <form
            className="toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              const nextSearch = draft.trim();
              const nextPaging = { ...paging, page: 1 };
              submitQuery(['admin', 'users', nextSearch, status, nextPaging], () => {
                setSearch(nextSearch);
                setPaging(nextPaging);
              });
            }}
          >
            <label className="field search-field">
              手机号 / 芝麻号
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="搜索手机号或芝麻号"
                autoComplete="off"
              />
            </label>
            <label className="field">
              用户状态
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setPaging({ ...paging, page: 1 });
                }}
              >
                <option value="">全部状态</option>
                <option value="true">已启用</option>
                <option value="false">已禁用</option>
              </select>
            </label>
            <Button type="submit" variant="primary" disabled={list.isFetching}>
              查询
            </Button>
            <Button
              onClick={() => {
                setDraft('');
                setSearch('');
                setStatus('');
                setPaging(initialPaging);
              }}
            >
              重置
            </Button>
          </form>
          {list.isPending ? (
            <Loading />
          ) : list.isError ? (
            <RequestError error={list.error} retry={() => void list.refetch()} />
          ) : list.data.items.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>头像</th>
                    <th>昵称</th>
                    <th>芝麻号</th>
                    <th>手机号</th>
                    <th>性别</th>
                    <th>注册时间</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((user) => (
                    <tr key={user.id}>
                      <td data-label="头像">
                        <UserAvatar user={user} />
                      </td>
                      <td data-label="昵称">{user.display_name || '未设置'}</td>
                      <td data-label="芝麻号">{user.sesame_number}</td>
                      <td data-label="手机号">{user.phone}</td>
                      <td data-label="性别">{gender(user.gender)}</td>
                      <td data-label="注册时间">{dateTime(user.created_at)}</td>
                      <td data-label="状态">
                        <StatusBadge enabled={user.is_enabled} />
                      </td>
                      <td data-label="操作">
                        <div className="row-actions">
                          <Button
                            variant="ghost"
                            onClick={() => navigate(`/application/users/${encodeURIComponent(user.id)}`)}
                          >
                            查看详情
                          </Button>
                          {canWrite && (
                            <Button variant="ghost" onClick={() => setTarget(user)}>
                              {user.is_enabled ? '禁用用户' : '启用用户'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>没有匹配的用户</Empty>
          )}
          {list.data && (
            <Pagination value={paging} total={list.data.total} onChange={setPaging} disabled={list.isFetching} />
          )}
        </section>
      )}
      {target && (
        <ConfirmDialog
          title={target.is_enabled ? '禁用用户' : '启用用户'}
          confirmText={target.is_enabled ? '确认禁用用户' : '确认启用用户'}
          danger={target.is_enabled}
          onClose={() => setTarget(null)}
          onConfirm={changeEnabled}
        >
          <div className="impact">
            <strong>{target.display_name || '未设置昵称'}</strong>
            <p>芝麻号：{target.sesame_number}</p>
            <p>手机号：{target.phone}</p>
          </div>
          <p>
            {target.is_enabled
              ? '禁用后，该用户无法继续使用服务，现有登录将失效。用户资料和业务数据保留。'
              : '恢复该用户的登录资格。此前已撤销的登录不会恢复，用户需要重新登录。'}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** 详情通过专用接口加载，浏览器刷新和列表外直接进入也能取得准确资料。 */
function UserDetails({
  userId,
  active,
  back,
  onStatus,
}: {
  userId: string;
  active: boolean;
  back: () => void;
  onStatus: (user: UserDetail) => void;
}) {
  const admin = useSession().session!.admin;
  const [operation, setOperation] = useState<{
    kind: 'phone' | 'password' | 'avatar' | 'delete-avatar';
    user: UserDetail;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const detail = useQuery({
    queryKey: ['admin', 'users', 'detail', userId],
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminUsers.detail(userId, signal), 'user-detail'),
  });
  if (detail.isPending) return <Loading />;
  if (detail.isError)
    return (
      <>
        <Button onClick={back}>
          <ArrowLeft size={16} />
          返回列表
        </Button>
        <RequestError error={detail.error} retry={() => void detail.refetch()} />
      </>
    );
  const user = detail.data;
  const canWrite = admin.permissions.includes('users:write');
  const avatar = userAvatarUrl(user);
  /** 保存弹窗使用资料快照进行并发核对，避免后台刷新悄悄更新原值。 */
  function edit(kind: NonNullable<typeof operation>['kind']) {
    setNotice('');
    setOperation({ kind, user });
  }
  return (
    <>
      <div className="page-heading">
        <Button variant="ghost" onClick={back}>
          <ArrowLeft size={16} />
          返回用户列表
        </Button>
        {canWrite && <Button onClick={() => onStatus(user)}>{user.is_enabled ? '禁用用户' : '启用用户'}</Button>}
      </div>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <section className="panel detail-panel">
        <div className="user-heading">
          <UserAvatar user={user} />
          <div>
            <div className="detail-title">
              <h2>{user.display_name || '未设置昵称'}</h2>
              <StatusBadge enabled={user.is_enabled} />
            </div>
            <p>{user.sesame_number}</p>
          </div>
        </div>
        {canWrite && (
          <div className="row-actions">
            <Button onClick={() => edit('avatar')}>更换头像</Button>
            {avatar && <Button onClick={() => edit('delete-avatar')}>恢复默认头像</Button>}
            <Button onClick={() => edit('phone')}>换绑手机号</Button>
            <Button onClick={() => edit('password')}>重置密码</Button>
          </div>
        )}
        <dl className="detail-grid">
          <div>
            <dt>手机号</dt>
            <dd>{user.phone}</dd>
          </div>
          <div>
            <dt>性别</dt>
            <dd>{gender(user.gender)}</dd>
          </div>
          <div>
            <dt>注册时间</dt>
            <dd>{dateTime(user.created_at)}</dd>
          </div>
          <div>
            <dt>资料更新时间</dt>
            <dd>{dateTime(user.profile_updated_at)}</dd>
          </div>
          <div>
            <dt>主币种</dt>
            <dd>{user.primary_currency || '未设置'}</dd>
          </div>
          <div>
            <dt>主题主色</dt>
            <dd>{user.theme_primary_color || '未设置'}</dd>
          </div>
        </dl>
      </section>
      {admin.permissions.includes('devices:read') ? (
        <UserDevices userId={user.id} active={active} />
      ) : (
        <section className="panel detail-panel">
          <h2>设备</h2>
          <p>当前账号无设备查看权限。</p>
        </section>
      )}
      {canWrite && operation?.kind === 'phone' && (
        <ChangePhoneDialog user={operation.user} onClose={() => setOperation(null)} onSaved={setNotice} />
      )}
      {canWrite && operation?.kind === 'password' && (
        <ResetPasswordDialog user={operation.user} onClose={() => setOperation(null)} onSaved={setNotice} />
      )}
      {canWrite && operation?.kind === 'avatar' && (
        <ChangeAvatarDialog user={operation.user} onClose={() => setOperation(null)} onSaved={setNotice} />
      )}
      {canWrite && operation?.kind === 'delete-avatar' && (
        <DeleteAvatarDialog user={operation.user} onClose={() => setOperation(null)} onSaved={setNotice} />
      )}
    </>
  );
}

/** 设备查询和撤销独立鉴权，登录时间与撤销状态不代表在线状态。 */
function UserDevices({ userId, active }: { userId: string; active: boolean }) {
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [target, setTarget] = useState<Device | null>(null);
  const admin = useSession().session!.admin;
  const query = useQuery({
    queryKey: ['admin', 'users', 'devices', userId, paging],
    enabled: active,
    queryFn: ({ signal }) => request(() => api.adminUsers.devices(userId, paging, signal), 'user-devices'),
  });
  useClampPage(query.data?.total, paging, setPaging);
  /** 撤销请求同时携带用户与设备关联，失败后刷新核对真实状态。 */
  async function revoke(reason: string) {
    if (!target) return;
    try {
      await request(() => api.adminUsers.revokeDevice(userId, target.id, { reason }), 'revoke-user-device');
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users', 'devices', userId] });
    }
  }
  return (
    <section className="device-section">
      <h2>设备</h2>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {query.data.items.length ? (
            query.data.items.map((device) => (
              <article key={device.id} className="panel detail-panel">
                <div className="page-heading">
                  <h3>{device.name || '未提供'}</h3>
                  <span className="badge">{device.revoked_at ? '已撤销' : '未撤销'}</span>
                </div>
                <dl className="detail-grid">
                  {[
                    ['平台', device.platform],
                    ['设备型号', device.device_model],
                    ['系统版本', device.os_version],
                    ['App 版本', device.app_version],
                    ['最近登录时间', dateTime(device.last_seen_at)],
                    ['最近 IP', device.last_ip],
                    ['登记时间', dateTime(device.created_at)],
                    ['撤销时间', device.revoked_at ? dateTime(device.revoked_at) : '未撤销'],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value || '未提供'}</dd>
                    </div>
                  ))}
                </dl>
                {!device.revoked_at && admin.permissions.includes('devices:revoke') && (
                  <div className="dialog-actions">
                    <Button onClick={() => setTarget(device)}>撤销设备登录</Button>
                  </div>
                )}
              </article>
            ))
          ) : (
            <Empty>该用户暂无设备记录</Empty>
          )}
          <Pagination value={paging} total={query.data.total} onChange={setPaging} />
        </>
      )}
      {target && (
        <ConfirmDialog
          title="撤销设备登录"
          confirmText="确认撤销设备"
          onClose={() => setTarget(null)}
          onConfirm={revoke}
        >
          <p>
            设备：{target.name || '未提供'} · {target.device_model || '未提供型号'}
          </p>
          <p>仅撤销该设备的登录，设备需要重新登录才能继续使用；其他设备不受影响。</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
