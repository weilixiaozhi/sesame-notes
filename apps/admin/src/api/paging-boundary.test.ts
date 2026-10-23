// @vitest-environment jsdom
import { ApiError } from '@sesame-notes/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, errorMessage, request } from './client';

const endpoints: Array<{
  name: string;
  path: string;
  read: () => Promise<{ items: unknown[]; page: number; page_size: number; total: number }>;
}> = [
  { name: '后台用户', path: '/api/v1/admin/accounts', read: () => api.adminAccounts.list() },
  { name: '用户组', path: '/api/v1/admin/groups', read: () => api.adminGroups.list() },
  { name: '组成员', path: '/api/v1/admin/groups/group-1/members', read: () => api.adminGroups.members('group-1') },
  {
    name: '待转入成员',
    path: '/api/v1/admin/groups/group-1/candidates',
    read: () => api.adminGroups.candidates('group-1'),
  },
  { name: '应用用户', path: '/api/v1/admin/users', read: () => api.adminUsers.list() },
  { name: '用户设备', path: '/api/v1/admin/users/user-1/devices', read: () => api.adminUsers.devices('user-1') },
  { name: '操作日志', path: '/api/v1/admin/audit-logs', read: () => api.adminAudit.list() },
];

const fetchMock = vi.fn<typeof fetch>();
const emptyPage = { items: [], page: 1, page_size: 10, total: 0 };

/** 使用真正的后台客户端处理 HTTP 响应，确保页面收到数据前已建立分页契约。 */
function respond(body: unknown): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'paging-request' },
    }),
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('后台分页 HTTP 边界', () => {
  it.each(endpoints)('$name：合法空页保留服务端分页信息', async ({ path, read }) => {
    respond(emptyPage);

    await expect(request(read, 'paging-read')).resolves.toEqual(emptyPage);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL((fetchMock.mock.calls[0]![0] as Request).url).pathname).toBe(path);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(endpoints)('$name：缺失或非法分页不能进入页面成功分支', async ({ read }) => {
    for (const invalid of [
      { items: [] },
      { ...emptyPage, items: null },
      { ...emptyPage, page: 0 },
      { ...emptyPage, page: 1.5 },
      { ...emptyPage, page_size: 25 },
      { ...emptyPage, total: -1 },
      { ...emptyPage, total: 0.5 },
      { ...emptyPage, total: undefined },
    ]) {
      respond(invalid);
      await expect(read()).rejects.toMatchObject({
        name: 'ApiError',
        code: 'INVALID_API_RESPONSE',
        requestId: 'paging-request',
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('正常结果保留真实记录和总数，不由当前页条数推算总数', async () => {
    const row = {
      id: 'user-1',
      phone: '+8613812345678',
      sesame_number: null,
      display_name: '用户昵称',
      gender: 'UNSPECIFIED',
      is_enabled: true,
      created_at: '2026-10-01T00:00:00Z',
      avatar_url: null,
      avatar_version: 0,
    };
    const page = { items: [row], page: 2, page_size: 20, total: 21 };
    respond(page);

    await expect(request(() => api.adminUsers.list({ page: 2, page_size: 20 }), 'list-users')).resolves.toEqual(page);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('响应违约由请求边界记录一次并保留友好错误，记录结构仍受校验', async () => {
    respond({ ...emptyPage, items: [{ id: 'incomplete-row' }], total: 1 });

    try {
      await request(() => api.adminUsers.list(), 'list-users');
      throw new Error('不完整记录不能作为成功结果返回');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'INVALID_API_RESPONSE', requestId: 'paging-request' });
      expect(errorMessage(error)).toBe('服务返回的数据不符合约定，请稍后重试。');
    }

    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      '[Sesame Admin]',
      expect.objectContaining({ context: 'list-users', code: 'INVALID_API_RESPONSE', requestId: 'paging-request' }),
    );
  });
});
