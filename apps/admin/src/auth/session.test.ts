// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@sesame-notes/api-client';
import { api, errorMessage } from '../api/client';
import { createAdminCreation } from '../api/create-intent';
import type { SessionResponse } from '../api/types';
import { queryClient, SessionProvider, useSession } from './session';

let root: Root;
let container: HTMLDivElement;
let latest: ReturnType<typeof useSession>;
const fetchMock = vi.fn<typeof fetch>();

const authenticated: SessionResponse = {
  admin: {
    id: 'admin-test',
    username: 'operator',
    email: null,
    phone: null,
    display_name: '测试管理员',
    identity_type: 'super_admin',
    group_id: 'group-test',
    group: { id: 'group-test', name: '默认组', is_enabled: true, is_default: true, version: 1 },
    is_enabled: true,
    permissions: [],
    allowed_pages: [],
    authorization_version: '1',
  },
  expires_at: '2099-01-01T00:00:00Z',
};

/** 构造真实客户端可解析的认证响应，保留状态码和业务错误码。 */
function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 读取会话上下文，直接验证认证状态与缓存隔离。 */
function SessionScreen() {
  latest = useSession();
  return null;
}

/** 等待初始会话查询结束，取得可调用的会话操作。 */
async function renderSession(): Promise<void> {
  await act(async () => {
    root.render(createElement(SessionProvider, { children: createElement(SessionScreen) }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  fetchMock.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  api.invalidateSessionRequests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('后台会话认证与隔离', () => {
  it.each(['身份变化', '授权变化', '核验错误', '登录失败', '退出失败'] as const)(
    '%s 后旧编辑器不能继续创建',
    async (boundary) => {
      fetchMock.mockResolvedValueOnce(response(200, authenticated));
      await renderSession();
      const create = vi.fn(async () => ({ id: 'created' }));
      const save = createAdminCreation({ create, update: vi.fn() });
      if (boundary === '身份变化' || boundary === '授权变化') {
        fetchMock.mockResolvedValueOnce(
          response(200, {
            ...authenticated,
            admin: {
              ...authenticated.admin,
              id: boundary === '身份变化' ? 'another-admin' : authenticated.admin.id,
              authorization_version: boundary === '授权变化' ? '2' : authenticated.admin.authorization_version,
            },
          }),
        );
        await act(async () => latest.verify());
      } else if (boundary === '核验错误') {
        fetchMock.mockRejectedValueOnce(new TypeError('核验连接失败'));
        await act(async () => latest.verify());
      } else if (boundary === '登录失败') {
        fetchMock.mockResolvedValueOnce(response(401, { code: 'INVALID_CREDENTIALS', message: '密码错误' }));
        await act(async () => {
          await expect(latest.login('operator', 'incorrect-password')).rejects.toMatchObject({ status: 401 });
        });
      } else {
        fetchMock.mockRejectedValueOnce(new TypeError('退出连接失败'));
        await act(async () => latest.logout());
      }
      await expect(save({ name: '旧页面输入' })).rejects.toMatchObject({ code: 'ADMIN_SESSION_CHANGED' });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('恢复创建响应期间切换管理员，旧流程不能继续向新会话发送更新', async () => {
    const nextSession: SessionResponse = {
      ...authenticated,
      admin: { ...authenticated.admin, id: 'admin-next', username: 'next-operator' },
    };
    const original = {
      slot: 'fitness-plan-library' as const,
      image_id: 'a'.repeat(64),
      target: 'fitness-plan-library' as const,
      target_id: null,
      sort_order: 0,
    };
    const created = {
      id: '11111111-1111-4111-8111-111111111111',
      slot: original.slot,
      image_path: `/api/v1/banners/media/${original.image_id}`,
      target: original.target,
      source: 'remote',
      target_id: null,
      target_name: null,
      sort_order: 0,
      version: 1,
      updated_at: '2026-11-06T00:00:00Z',
      updated_by: 'operator',
    };
    let resolveRecovery!: (result: Response) => void;
    let recoveryStarted!: () => void;
    const recovery = new Promise<Response>((resolve) => {
      resolveRecovery = resolve;
    });
    const recovering = new Promise<void>((resolve) => {
      recoveryStarted = resolve;
    });
    let currentSession = authenticated;
    let creationRequests = 0;
    const writes: Array<{ method: string; admin: string }> = [];
    fetchMock.mockImplementation(async (input) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/admin/auth/me') return response(200, currentSession);
      if (path === '/api/v1/admin/auth/logout') return new Response(null, { status: 204 });
      if (path === '/api/v1/admin/auth/login') {
        currentSession = nextSession;
        return response(200, currentSession);
      }
      writes.push({ method: request.method, admin: currentSession.admin.id });
      if (request.method === 'POST') {
        creationRequests++;
        if (creationRequests === 1) throw new TypeError('创建成功后响应丢失');
        recoveryStarted();
        return recovery;
      }
      return response(200, { ...created, sort_order: 5, version: 2 });
    });
    await renderSession();
    const save = createAdminCreation({
      create: api.adminBanners.create,
      update: (saved, body) => api.adminBanners.update(saved.id, { ...body, version: saved.version }),
    });
    await expect(save(original)).rejects.toThrow('响应丢失');
    const outcome = save({ ...original, sort_order: 5 }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await recovering;
    await act(async () => latest.logout());
    await act(async () => latest.login('next-operator', 'next-test-password'));
    expect(latest.session?.admin.id).toBe('admin-next');
    resolveRecovery(response(201, created));
    const result = await outcome;
    expect(writes.filter((entry) => entry.method === 'PATCH')).toEqual([]);
    expect(result.error).toMatchObject({ code: 'ADMIN_SESSION_CHANGED' });
  });

  it('首次未登录保持匿名状态，不标记会话过期', async () => {
    fetchMock.mockResolvedValue(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '请先登录管理后台' }));
    await renderSession();

    expect(latest.phase).toBe('anonymous');
    expect(latest.message).toBe('');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('已建立的会话失效时仍提示重新登录，并清空后台缓存', async () => {
    fetchMock.mockResolvedValueOnce(response(200, authenticated));
    await renderSession();
    expect(latest.phase).toBe('authenticated');
    queryClient.setQueryData(['private-data'], { value: '当前用户资料' });
    fetchMock.mockResolvedValueOnce(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '会话失效' }));

    await act(async () => latest.verify());

    expect(latest.phase).toBe('anonymous');
    expect(latest.session).toBeNull();
    expect(latest.message).toBe('登录状态已失效，请重新登录。');
    expect(queryClient.getQueryData(['private-data'])).toBeUndefined();
  });

  it('账号密码错误交给登录表单，不触发会话过期通知', async () => {
    fetchMock.mockResolvedValueOnce(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '请先登录管理后台' }));
    await renderSession();
    fetchMock.mockResolvedValueOnce(response(401, { code: 'INVALID_CREDENTIALS', message: '账号或密码错误' }));

    await act(async () => {
      await expect(latest.login('operator', 'incorrect-test-password')).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        status: 401,
      });
    });

    expect(latest.message).toBe('');
    expect(latest.phase).toBe('anonymous');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('登录成功响应后的会话核验失败时说明登录未确认，允许用户重试', async () => {
    fetchMock.mockResolvedValueOnce(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '请先登录管理后台' }));
    await renderSession();
    fetchMock
      .mockResolvedValueOnce(response(200, authenticated))
      .mockResolvedValueOnce(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '请先登录管理后台' }));

    await act(async () => latest.login('operator', 'test-password'));

    expect(latest.phase).toBe('anonymous');
    expect(latest.session).toBeNull();
    expect(latest.message).toBe('登录状态未能确认，请重试。');
    expect(fetchMock.mock.calls.map(([input]) => new URL((input as Request).url).pathname)).toEqual([
      '/api/v1/admin/auth/me',
      '/api/v1/admin/auth/login',
      '/api/v1/admin/auth/me',
    ]);

    fetchMock.mockResolvedValueOnce(response(200, authenticated)).mockResolvedValueOnce(response(200, authenticated));
    await act(async () => latest.login('operator', 'test-password'));
    expect(latest.phase).toBe('authenticated');
    expect(latest.session).toEqual(authenticated);
    expect(latest.message).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('旧登录的会话核验迟到 401 不覆盖新登录已经确认的会话', async () => {
    fetchMock.mockResolvedValueOnce(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '请先登录管理后台' }));
    await renderSession();
    let resolveOld!: (result: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    fetchMock.mockResolvedValueOnce(response(200, authenticated)).mockReturnValueOnce(oldResponse);
    let oldLogin!: Promise<void>;
    await act(async () => {
      oldLogin = latest.login('operator', 'first-test-password');
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    fetchMock.mockResolvedValueOnce(response(200, authenticated)).mockResolvedValueOnce(response(200, authenticated));
    await act(async () => latest.login('operator', 'second-test-password'));
    await act(async () => {
      resolveOld(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '旧会话失效' }));
      await oldLogin;
    });

    expect(latest.phase).toBe('authenticated');
    expect(latest.session).toEqual(authenticated);
    expect(latest.message).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe('后台登录错误分类', () => {
  it('工作区操作失效提示重新打开编辑器，不误报网络错误或退出新登录', () => {
    expect(errorMessage(new ApiError(409, 'ADMIN_SESSION_CHANGED', '内部错误'))).toBe(
      '后台登录或权限已变化，请重新打开编辑页面。',
    );
  });

  it.each([
    [401, 'INVALID_CREDENTIALS', '账号或密码不正确，请检查后重试。'],
    [401, 'HTTP_401', '登录验证未通过，请检查账号和密码后重试。'],
    [429, 'RATE_LIMITED', '操作过于频繁，请稍后重试。'],
    [503, 'ADMIN_AUTH_UNAVAILABLE', '后台登录验证暂时不可用，请稍后重试。'],
    [502, 'HTTP_502', '登录服务暂时不可用，请稍后重试。'],
    [403, 'ORIGIN_DENIED', '请求未通过安全验证，请刷新页面后重试。'],
  ])('%s / %s 使用可操作的登录提示', (status, code, message) => {
    expect(errorMessage(new ApiError(status, code, '不显示内部原始错误'), 'login')).toBe(message);
  });

  it('网络错误与已登录请求的会话过期提示各自保留', () => {
    expect(errorMessage(new TypeError('Failed to fetch'), 'login')).toBe('连接暂时不可用，请检查网络后重试。');
    expect(errorMessage(new ApiError(401, 'ADMIN_UNAUTHORIZED', '内部错误'))).toBe('登录状态已失效，请重新登录。');
  });
});
