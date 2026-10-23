import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiClient, ApiError, unwrap } from '../src/index.js';

/** 构造带标准 JSON 类型的测试响应。 */
function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('后台客户端凭证边界', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('Cookie 请求剔除用户令牌，敏感响应不缓存且不接受重定向', async () => {
    const fetch = vi.fn().mockResolvedValue(response(200, { admin: {} }));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await api.client.GET('/api/v1/admin/auth/me', { headers: { authorization: 'Bearer product-user-token' } });
    const request = fetch.mock.calls[0]![0] as Request;
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.credentials).toBe('include');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('error');
  });

  it('后台凭证不能通过底层客户端发送到应用用户接口', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    await expect(api.client.GET('/api/v1/health')).rejects.toMatchObject({ code: 'ADMIN_REQUEST_SCOPE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('登录写请求包含来源保护头，错误直接交给表单且没有刷新重放', async () => {
    const fetch = vi.fn().mockResolvedValue(response(401, { code: 'ADMIN_LOGIN_FAILED', message: '认证失败' }));
    const onUnauthorized = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example', onUnauthorized });
    await expect(
      api.adminAuth.login({ username: 'operator', password: 'a test-only password' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect((fetch.mock.calls[0]![0] as Request).headers.get('x-admin-request')).toBe('1');
    expect(fetch).toHaveBeenCalledOnce();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('失效会话通知清缓存，写请求仅发送一次', async () => {
    const fetch = vi.fn().mockResolvedValue(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '会话失效' }));
    const onUnauthorized = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example', onUnauthorized });
    await expect(
      api.adminAuth.changePassword({ old_password: 'an old test password', new_password: 'a new test password' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('会话状态读取支持外部取消', async () => {
    const abort = new AbortController();
    let request: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) => {
        request = input;
        return response(200, { admin: {} });
      }),
    );
    const api = new AdminApiClient({ baseUrl: 'https://admin.example' });
    const result = await api.client.GET('/api/v1/admin/auth/me', { signal: abort.signal });
    expect(unwrap(result)).toEqual({ admin: {} });
    abort.abort();
    expect(request?.signal.aborted).toBe(true);
  });

  it('旧会话迟到的401不会退出已重新登录的新会话', async () => {
    const old = Promise.withResolvers<Response>();
    const onUnauthorized = vi.fn();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response(200, { admin: {} }));
    vi.stubGlobal('fetch', fetch);
    const api = new AdminApiClient({ baseUrl: 'https://admin.example', onUnauthorized });
    const expiredRequest = api.adminAuth.me().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await api.adminAuth.login({ username: 'operator', password: 'a test-only password' });
    old.resolve(response(401, { code: 'ADMIN_UNAUTHORIZED', message: '旧会话失效' }));
    expect(await expiredRequest).toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
