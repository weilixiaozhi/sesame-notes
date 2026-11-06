import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient, ApiError, unwrap } from '../src/index.js';

/** 构造 JSON 响应。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('401 单飞刷新：并发请求只刷新一次并全部重放成功', async () => {
    let refreshCount = 0;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { code: 'UNAUTHORIZED', message: '过期', request_id: 'r1' }))
      .mockResolvedValueOnce(jsonResponse(401, { code: 'UNAUTHORIZED', message: '过期', request_id: 'r2' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ok', request_id: 'r3' }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'ok', request_id: 'r4' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'expired-token',
      refreshAccessToken: async () => {
        refreshCount += 1;
        return 'fresh-token';
      },
      onTokenRefreshed: vi.fn(),
    });

    const [a, b] = await Promise.all([client.client.GET('/api/v1/health'), client.client.GET('/api/v1/health')]);

    expect(refreshCount).toBe(1);
    expect(a.data).toEqual({ status: 'ok', request_id: 'r3' });
    expect(b.data).toEqual({ status: 'ok', request_id: 'r4' });
    // 重放请求必须携带新 token
    const replayCalls = fetchMock.mock.calls.filter(([input]) => {
      const request = input as Request;
      return request.headers.get('authorization') === 'Bearer fresh-token';
    });
    expect(replayCalls.length).toBe(2);
  });

  it('认证服务503按服务故障返回，不刷新令牌或重放请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(503, {
        code: 'AUTH_UNAVAILABLE',
        message: '登录验证服务暂时不可用',
        request_id: 'auth-unavailable',
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const refreshAccessToken = vi.fn().mockResolvedValue('new-token');
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'valid-token',
      refreshAccessToken,
    });
    const result = await client.client.GET('/api/v1/admin/users');
    expect(() => unwrap(result)).toThrow(ApiError);
    try {
      unwrap(result);
    } catch (error) {
      expect(error).toMatchObject({ status: 503, code: 'AUTH_UNAVAILABLE', requestId: 'auth-unavailable' });
    }
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('登录与刷新端点不参与 401 重放', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(401, { code: 'INVALID_CREDENTIALS', message: '账号或密码错误', request_id: 'r1' }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const refreshAccessToken = vi.fn().mockResolvedValue('fresh');
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => null,
      refreshAccessToken,
    });

    const result = await client.client.POST('/api/v1/auth/login', {
      body: {
        country_code: '+86',
        phone: '13800138000',
        password: 'p',
        device: { installation_id: 'i-1', name: 'd', platform: 'p' },
      },
    });
    const refreshResult = await client.client.POST('/api/v1/auth/refresh', {
      body: { refresh_token: 'expired-refresh' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
    expect(refreshResult.error).toBeTruthy();
  });

  it('浏览器请求默认携带 cookie，同时保留 Bearer Authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok', request_id: 'r-cookie' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => 'access-token' });

    await client.client.GET('/api/v1/health');

    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.credentials).toBe('include');
    expect(request.headers.get('authorization')).toBe('Bearer access-token');
  });

  it('unwrap 把合法 204 空响应视为成功', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => 'token' });

    const result = await client.client.DELETE('/api/v1/ledgers/{ledger_id}', {
      params: {
        path: { ledger_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c761' },
        query: { expected_sync_id: '11111111-1111-4111-8111-111111111111', expected_fingerprint: 'a'.repeat(64) },
      },
    });

    expect(unwrap<void>(result)).toBeUndefined();
  });

  it('创建成功状态缺少业务正文时不能触发写入成功回调', async () => {
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 201, headers: { 'x-request-id': 'empty-write' } }));
      const validateResponse = vi.fn();
      const client = new ApiClient({
        baseUrl: 'http://api.test',
        getAccessToken: async () => 'token',
        validateResponse,
      });
      const completeSave = vi.fn();
      await expect(
        client.client
          .POST('/api/v1/ledgers', { body: { name: '账本' } })
          .then(unwrap)
          .then(completeSave),
      ).rejects.toMatchObject({ status: 201, code: 'EMPTY_RESPONSE', requestId: 'empty-write' });
      expect(completeSave).not.toHaveBeenCalled();
      expect(validateResponse).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('空响应错误未在请求边界阻止保存成功副作用', { cause });
    }
  });

  it('非 JSON 错误响应仍转换为含状态和请求编号的友好 ApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('upstream exploded', { status: 503, headers: { 'x-request-id': 'req-503' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => null });

    const result = await client.client.GET('/api/v1/health');

    try {
      unwrap(result);
      expect.unreachable('应抛出 ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 503,
        code: 'HTTP_503',
        message: '服务暂时不可用，请稍后重试',
        requestId: 'req-503',
      });
    }
  });

  it('标准错误响应完整保留 code、message、request_id 和 details', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: '该幂等键已用于不同请求',
        request_id: 'req-conflict',
        details: { field: 'idempotency-key' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => null });

    const result = await client.client.GET('/api/v1/health');

    try {
      unwrap(result);
      expect.unreachable('应抛出 ApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: '该幂等键已用于不同请求',
        requestId: 'req-conflict',
        details: { field: 'idempotency-key' },
      });
    }
  });

  it('可选响应校验器在 JSON 成功响应越过边界前拒绝错误字段类型', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 42, request_id: 'bad-shape' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => null,
      validateResponse: ({ body }) => {
        if (!body || typeof body !== 'object' || !('status' in body) || typeof body.status !== 'string') {
          throw new Error('status 必须是字符串');
        }
      },
    });

    await expect(client.client.GET('/api/v1/health')).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_API_RESPONSE',
      message: '服务返回的数据不符合接口约定',
      requestId: 'bad-shape',
      cause: { message: 'status 必须是字符串' },
    });
  });
});

describe('ApiError', () => {
  it('HTTP 状态来自响应，正文中的私有属性不能覆盖它', () => {
    const body = { code: 'UNAUTHORIZED', message: '请重新登录', request_id: 'r-status', __status: 200 };
    expect(ApiError.from(body, jsonResponse(401, body))).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(ApiError.from(body)).toMatchObject({ status: 0, code: 'UNAUTHORIZED' });
  });
});

describe('浏览器认证端点不触发自动刷新', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  it('Cookie 刷新和退出的 401 直接返回，避免刷新递归或退出时复活会话', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(401, { code: 'UNAUTHORIZED', message: '请重新登录', request_id: 'browser-auth' }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const refreshAccessToken = vi.fn().mockResolvedValue('should-not-refresh');
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => null, refreshAccessToken });
    const refresh = await client.client.POST('/api/v1/auth/browser/refresh', { body: {} });
    const logout = await client.client.POST('/api/v1/auth/browser/logout', { body: {} });
    const login = await client.client.POST('/api/v1/auth/browser/login', {
      body: {
        country_code: '+86',
        phone: '13800138000',
        password: 'password',
        device: { installation_id: '00000000-0000-4000-8000-000000000001', name: 'web', platform: 'web' },
      },
    });
    expect([refresh.response.status, logout.response.status, login.response.status]).toEqual([401, 401, 401]);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('头像二进制仍经过响应校验边界', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });
  it('头像以 Blob 交给校验器并保留原始字节', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      ) as typeof fetch;
    const validateResponse = vi.fn();
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'token',
      validateResponse,
    });
    const result = await client.client.GET('/api/v1/profile/avatar/{user_id}', {
      params: { path: { user_id: '00000000-0000-4000-8000-000000000001' } },
      parseAs: 'blob',
    });
    expect(result.data).toBeInstanceOf(Blob);
    expect(result.data?.size).toBe(4);
    expect(new Uint8Array(await result.data!.arrayBuffer())).toEqual(bytes);
    expect(validateResponse).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/v1/profile/avatar/{user_id}', body: expect.any(Blob) }),
    );
    const validatedBody = validateResponse.mock.calls[0]![0].body as Blob;
    expect(new Uint8Array(await validatedBody.arrayBuffer())).toEqual(bytes);
  });
  it('头像返回 SVG 时拒绝正文并保留错误原因与请求编号', async () => {
    const headers = new Headers({ 'x-request-id': 'avatar-response', 'content-type': 'image/svg+xml' });
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response(new Uint8Array([0, 1, 2, 255]), { status: 200, headers }),
      ) as typeof fetch;
    const validateResponse = vi.fn();
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'token',
      validateResponse,
    });
    await expect(
      client.client.GET('/api/v1/profile/avatar/{user_id}', {
        params: { path: { user_id: '00000000-0000-4000-8000-000000000001' } },
        parseAs: 'blob',
      }),
    ).rejects.toMatchObject({
      status: 200,
      code: 'INVALID_API_RESPONSE',
      requestId: 'avatar-response',
      cause: { message: 'INVALID_AVATAR_CONTENT_TYPE' },
    });
    expect(validateResponse).not.toHaveBeenCalled();
  });
  it('JSON 端点伪装图片不能绕过响应校验', async () => {
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'token',
      validateResponse: vi.fn(),
    });
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response('broken', { status: 200, headers: { 'content-type': 'image/webp' } }),
      ) as typeof fetch;
    await expect(client.client.GET('/api/v1/profile/me')).rejects.toMatchObject({ code: 'INVALID_API_RESPONSE' });
  });
});
