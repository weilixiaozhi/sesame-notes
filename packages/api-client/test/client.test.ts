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

  it('未登录时不注入 Authorization 头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok', request_id: 'r1' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => null });

    await client.client.GET('/api/v1/health');

    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.has('authorization')).toBe(false);
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

  it('普通请求查询参数包含认证路径片段时仍单飞刷新并重放', async () => {
    const page = { items: [], next_cursor: null };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      return request.headers.get('authorization') === 'Bearer fresh-token'
        ? jsonResponse(200, page)
        : jsonResponse(401, { code: 'UNAUTHORIZED', message: '过期', request_id: 'query-1' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const refreshAccessToken = vi.fn().mockResolvedValue('fresh-token');
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'expired-token',
      refreshAccessToken,
    });

    const searches = ['/auth/login', '/auth/refresh'];
    const results = await Promise.all(
      searches.map((search) =>
        client.client.GET('/api/v1/admin/users', {
          params: { query: { search } },
          // 保留查询值里的斜杠，覆盖合法 URL 中原样出现认证路径片段的情况。
          querySerializer: { allowReserved: true },
        }),
      ),
    );

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.data)).toEqual([page, page]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const replays = fetchMock.mock.calls.map(([input]) => input as Request).slice(2);
    expect(replays.map((request) => request.url)).toEqual(
      searches.map((search) => `http://api.test/api/v1/admin/users?search=${search}`),
    );
    expect(replays.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer fresh-token',
      'Bearer fresh-token',
    ]);
  });

  it('POST 在首次请求体已消费后仍能携带原 body 完成 401 重放', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      bodies.push(await request.text());
      return fetchMock.mock.calls.length === 1
        ? jsonResponse(401, { code: 'UNAUTHORIZED', message: '过期', request_id: 'post-1' })
        : jsonResponse(201, { id: 'ledger-1' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'expired-token',
      refreshAccessToken: async () => 'fresh-token',
    });

    const result = await client.client.POST('/api/v1/ledgers', { body: { name: 'POST body' } });

    expect(result.data).toEqual({ id: 'ledger-1' });
    expect(bodies).toEqual(['{"name":"POST body"}', '{"name":"POST body"}']);
    const replay = fetchMock.mock.calls[1]![0] as Request;
    expect(replay.headers.get('authorization')).toBe('Bearer fresh-token');
  });

  it('刷新重放保留后注册中间件的自定义头与幂等头，只替换过期令牌', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      bodies.push(await request.text());
      return fetchMock.mock.calls.length === 1
        ? jsonResponse(401, { code: 'UNAUTHORIZED', message: '过期', request_id: 'refresh-1' })
        : jsonResponse(201, { id: 'ledger-1' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'expired-token',
      refreshAccessToken: async () => 'fresh-token',
    });
    client.client.use({
      onRequest({ request }) {
        request.headers.set('x-client-context', '1');
        request.headers.set('idempotency-key', 'same-action-after-refresh');
      },
    });
    const result = await client.client.POST('/api/v1/ledgers', { body: { name: '请求重放' } });
    expect(result.data).toEqual({ id: 'ledger-1' });
    expect(bodies).toEqual(['{"name":"请求重放"}', '{"name":"请求重放"}']);
    const replay = fetchMock.mock.calls[1]![0] as Request;
    expect(replay.headers.get('x-client-context')).toBe('1');
    expect(replay.headers.get('idempotency-key')).toBe('same-action-after-refresh');
    expect(replay.headers.get('authorization')).toBe('Bearer fresh-token');
  });

  it('PATCH 在首次请求体已消费后仍能携带原 body 完成 401 重放', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as Request;
      bodies.push(await request.text());
      return fetchMock.mock.calls.length === 1
        ? jsonResponse(401, { code: 'UNAUTHORIZED', message: '过期', request_id: 'patch-1' })
        : jsonResponse(200, { display_name: 'PATCH body' });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => 'expired-token',
      refreshAccessToken: async () => 'fresh-token',
    });

    const result = await client.client.PATCH('/api/v1/profile/me', { body: { display_name: 'PATCH body' } });

    expect(result.data).toEqual({ display_name: 'PATCH body' });
    expect(bodies).toEqual(['{"display_name":"PATCH body"}', '{"display_name":"PATCH body"}']);
    const replay = fetchMock.mock.calls[1]![0] as Request;
    expect(replay.headers.get('authorization')).toBe('Bearer fresh-token');
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

  it('unwrap 把错误载荷转为结构化 ApiError', () => {
    const result = {
      error: { code: 'LEDGER_NOT_FOUND', message: '账本不存在', request_id: 'req-9' },
      response: jsonResponse(404, { code: 'LEDGER_NOT_FOUND', message: '账本不存在', request_id: 'req-9' }),
    };
    expect(() => unwrap(result)).toThrowError(ApiError);
    try {
      unwrap(result);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
      expect((error as ApiError).code).toBe('LEDGER_NOT_FOUND');
      expect((error as ApiError).requestId).toBe('req-9');
    }
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

  it.each([
    { status: 200, explicitLength: false },
    { status: 200, explicitLength: true },
    { status: 201, explicitLength: false },
    { status: 201, explicitLength: true },
  ])('空 $status 响应（零长度声明：$explicitLength）不能解包为有效数据', ({ status, explicitLength }) => {
    try {
      const response = new Response(explicitLength ? '' : null, {
        status,
        headers: { 'x-request-id': 'empty-result', ...(explicitLength ? { 'content-length': '0' } : {}) },
      });
      expect(() => unwrap({ response })).toThrowError(
        expect.objectContaining({ status, code: 'EMPTY_RESPONSE', requestId: 'empty-result' }),
      );
    } catch (cause) {
      throw new Error('缺少正文的业务响应被解包为成功', { cause });
    }
  });

  it.each([
    { status: 200, explicitLength: false },
    { status: 200, explicitLength: true },
    { status: 201, explicitLength: false },
    { status: 201, explicitLength: true },
  ])('空 $status 响应（零长度声明：$explicitLength）不能触发写入成功回调', async ({ status, explicitLength }) => {
    try {
      for (const validateResponse of [undefined, vi.fn()]) {
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(explicitLength ? '' : null, {
            status,
            headers: { 'x-request-id': 'empty-write', ...(explicitLength ? { 'content-length': '0' } : {}) },
          }),
        );
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
        ).rejects.toMatchObject({ status, code: 'EMPTY_RESPONSE', requestId: 'empty-write' });
        expect(completeSave).not.toHaveBeenCalled();
        if (validateResponse) expect(validateResponse).not.toHaveBeenCalled();
      }
    } catch (cause) {
      throw new Error('空响应错误未在请求边界阻止保存成功副作用', { cause });
    }
  });

  it('205 与 HEAD 的无正文语义保留，HEAD 方法和通用 request 返回值均可解包', async () => {
    try {
      const fetchMock = vi.fn().mockImplementation(async (request: Request) => {
        return new Response(null, {
          status: request.method === 'HEAD' ? 200 : 205,
          headers: { 'x-request-id': 'empty-http' },
        });
      });
      globalThis.fetch = fetchMock;
      const validateResponse = vi.fn();
      const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => null, validateResponse });
      expect(
        unwrap(await client.client.POST('/api/v1/auth/logout', { body: { refresh_token: 'test-refresh-token' } })),
      ).toBeUndefined();
      // 当前生成契约未声明 HEAD 路由，此处验证 SDK 保留的通用 HTTP 方法能力。
      expect(unwrap(await client.client.HEAD('/api/v1/health' as never))).toBeUndefined();
      expect(unwrap(await client.client.request('head', '/api/v1/health' as never))).toBeUndefined();
      expect(validateResponse).toHaveBeenCalledTimes(3);
      expect(validateResponse.mock.calls.every(([context]) => context.body === undefined)).toBe(true);
      client.client.use({
        onRequest: () => new Response(null, { status: 200 }),
      });
      expect(unwrap(await client.client.HEAD('/api/v1/health' as never))).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } catch (cause) {
      throw new Error('合法无正文 HTTP 响应被误判', { cause });
    }
  });

  it.each([401, 403, 500])('无正文 HTTP %s 保留失败状态与请求编号', async (status) => {
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status, headers: { 'content-length': '0', 'x-request-id': 'empty-error' } }),
        );
      const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => null });
      const result = await client.client.GET('/api/v1/health');
      expect(() => unwrap(result)).toThrowError(
        expect.objectContaining({ status, code: `HTTP_${status}`, requestId: 'empty-error' }),
      );
    } catch (cause) {
      throw new Error('无正文 HTTP 错误的业务语义丢失', { cause });
    }
  });

  it('缓存复用同一响应时，HEAD 的无正文许可不能传给后续 GET', async () => {
    try {
      const cachedResponse = new Response(null, {
        status: 200,
        headers: { 'content-length': '0', 'x-request-id': 'shared-cache' },
      });
      const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => null });
      client.client.use({ onRequest: () => cachedResponse });
      expect(unwrap(await client.client.HEAD('/api/v1/health' as never))).toBeUndefined();
      const result = await client.client.GET('/api/v1/health');
      expect(() => unwrap(result)).toThrowError(
        expect.objectContaining({ status: 200, code: 'EMPTY_RESPONSE', requestId: 'shared-cache' }),
      );
    } catch (cause) {
      throw new Error('缓存响应复用污染了不同请求的正文契约', { cause });
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

  it('可选响应校验器允许符合边界的响应继续解析', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok', request_id: 'valid-shape' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      getAccessToken: async () => null,
      validateResponse: ({ body }) => {
        if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'ok') {
          throw new Error('status 必须为 ok');
        }
      },
    });

    const result = await client.client.GET('/api/v1/health');

    expect(unwrap(result)).toEqual({ status: 'ok', request_id: 'valid-shape' });
  });

  it('超时中止请求', async () => {
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: 'http://api.test', getAccessToken: async () => null, timeoutMs: 50 });

    await expect(client.client.GET('/api/v1/health')).rejects.toThrow();
  }, 10_000);
});

describe('ApiError', () => {
  it('HTTP 状态来自响应，正文中的私有属性不能覆盖它', () => {
    const body = { code: 'UNAUTHORIZED', message: '请重新登录', request_id: 'r-status', __status: 200 };
    expect(ApiError.from(body, jsonResponse(401, body))).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(ApiError.from(body)).toMatchObject({ status: 0, code: 'UNAUTHORIZED' });
  });

  it('from 对非标准载荷返回兜底错误', () => {
    const error = ApiError.from('oops');
    expect(error.code).toBe('API_ERROR');
    expect(error.message).toBeTruthy();
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
  it.each(['image/png', 'image/jpeg', 'image/webp', 'IMAGE/PNG; charset=binary', ' image/jpeg ; charset=binary '])(
    '%s 以 Blob 交给校验器，同时保留调用方 parseAs blob 的原始字节',
    async (contentType) => {
      const bytes = new Uint8Array([0, 1, 2, 255]);
      globalThis.fetch = vi
        .fn()
        .mockImplementation(
          async () => new Response(bytes, { status: 200, headers: { 'content-type': contentType } }),
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
    },
  );
  it.each(['image/gif', 'image/svg+xml', 'application/json', undefined])(
    '头像返回非契约类型 %s 时保留错误原因与请求编号',
    async (contentType) => {
      const headers = new Headers({ 'x-request-id': 'avatar-response' });
      if (contentType) headers.set('content-type', contentType);
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
    },
  );
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
