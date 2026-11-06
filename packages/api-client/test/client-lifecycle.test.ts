import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/client.js';

/** 构造与接口错误边界相同的 JSON 响应。 */
function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

it('自定义传输在中间件替换 Request 后重放最终实际发送的完整请求', async () => {
  const bodies: string[] = [];
  const send = vi.fn(async (request: Request) => {
    bodies.push(await request.text());
    return response(bodies.length === 1 ? 401 : 201, { id: 'ledger' });
  });
  const defaultFetch = vi.fn();
  vi.stubGlobal('fetch', defaultFetch);
  const api = new ApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: async () => 'expired',
    refreshAccessToken: async () => 'refreshed',
  });
  api.client.use({
    /** 模拟调用方添加实际传输策略，并以新 Request 返回完整请求。 */
    onRequest({ request }) {
      const headers = new Headers(request.headers);
      headers.set('idempotency-key', 'one-operation');
      return new Request(`${request.url}?transport=final`, {
        method: request.method,
        body: JSON.stringify({ name: '最终正文' }),
        headers,
        signal: request.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    },
  });
  const pending = api.client.POST('/api/v1/ledgers', { body: { name: '初始正文' }, fetch: send });
  await expect(pending).resolves.toMatchObject({
    data: { id: 'ledger' },
  });
  expect(bodies).toEqual(['{"name":"最终正文"}', '{"name":"最终正文"}']);
  const replay = send.mock.calls[1]![0];
  expect(replay.url).toBe('https://api.test/api/v1/ledgers?transport=final');
  expect(replay.headers.get('idempotency-key')).toBe('one-operation');
  expect(replay.headers.get('authorization')).toBe('Bearer refreshed');
  expect(replay.credentials).toBe('omit');
  expect(replay.cache).toBe('no-store');
  expect(replay.redirect).toBe('error');
  expect(defaultFetch).not.toHaveBeenCalled();
});

it('等待共享刷新时取消一个请求立即结束等待，其余请求仍可完成刷新和重放', async () => {
  const refresh = Promise.withResolvers<string>();
  const controller = new AbortController();
  const send = vi.fn(async (request: Request) =>
    request.headers.get('authorization') === 'Bearer refreshed' ? response(200, { status: 'ok' }) : response(401),
  );
  vi.stubGlobal('fetch', send);
  const refreshAccessToken = vi.fn(() => refresh.promise);
  const api = new ApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: async () => 'expired',
    refreshAccessToken,
  });
  let cancelled: unknown;
  const first = api.client.GET('/api/v1/health', { signal: controller.signal }).catch((error: unknown) => {
    cancelled = error;
  });
  const second = api.client.GET('/api/v1/health');
  try {
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledOnce());
    const reason = new DOMException('调用方取消', 'AbortError');
    controller.abort(reason);
    await vi.waitFor(() => expect(cancelled).toBe(reason));
    refresh.resolve('refreshed');
    await expect(second).resolves.toMatchObject({ data: { status: 'ok' } });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(3);
  } finally {
    refresh.resolve('refreshed');
    await Promise.allSettled([first, second]);
  }
});

it('外部账号切换后，旧请求不能借用链外令牌或再次调用刷新', async () => {
  let token = 'account-a';
  const late = Promise.withResolvers<Response>();
  const send = vi.fn(async (request: Request) => {
    if (request.method === 'POST') return late.promise;
    return request.headers.get('authorization') === 'Bearer account-a-fresh' ? response(200) : response(401);
  });
  vi.stubGlobal('fetch', send);
  const refreshAccessToken = vi.fn(async () => {
    token = 'account-a-fresh';
    return token;
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', getAccessToken: async () => token, refreshAccessToken });
  const oldWrite = api.client.POST('/api/v1/ledgers', { body: { name: 'A 的记录' } });
  const outcome = oldWrite.catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await api.client.GET('/api/v1/health');
    token = 'account-b';
    late.resolve(response(401));
    await expect(outcome).resolves.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(send.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(1);
    expect(send.mock.calls.some(([request]) => request.headers.get('authorization') === 'Bearer account-b')).toBe(
      false,
    );
  } finally {
    late.resolve(response(401));
    await outcome;
  }
});

it('经过两轮已确认刷新后，最早请求的迟到 401 仍使用同会话最新令牌', async () => {
  let token = 'token-0';
  let accepted = 'token-1';
  const late = Promise.withResolvers<Response>();
  let delayed = false;
  const send = vi.fn(async (request: Request) => {
    if (!delayed) {
      delayed = true;
      return late.promise;
    }
    return request.headers.get('authorization') === `Bearer ${accepted}` ? response(200) : response(401);
  });
  vi.stubGlobal('fetch', send);
  const refreshAccessToken = vi.fn(async () => {
    token = accepted;
    return token;
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', getAccessToken: async () => token, refreshAccessToken });
  const oldest = api.client.GET('/api/v1/health');
  try {
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await api.client.GET('/api/v1/health');
    accepted = 'token-2';
    await api.client.GET('/api/v1/health');
    late.resolve(response(401));
    await expect(oldest).resolves.toMatchObject({ data: {} });
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.at(-1)![0].headers.get('authorization')).toBe('Bearer token-2');
  } finally {
    late.resolve(response(401));
    await oldest;
  }
});

it('刷新返回相同字符串时，新请求仍可独立刷新，重放的 401 不形成循环', async () => {
  const send = vi.fn(async () => response(401));
  vi.stubGlobal('fetch', send);
  const refreshAccessToken = vi.fn(async () => 'same-token');
  const api = new ApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: async () => 'same-token',
    refreshAccessToken,
  });
  await expect(api.client.GET('/api/v1/health')).resolves.toMatchObject({ response: { status: 401 } });
  await expect(api.client.GET('/api/v1/health')).resolves.toMatchObject({ response: { status: 401 } });
  expect(send).toHaveBeenCalledTimes(4);
  expect(refreshAccessToken).toHaveBeenCalledTimes(2);
});

it('旧刷新完成前必须检查外部换号，令牌更新回调不能覆盖新账号', async () => {
  let token = 'account-a';
  const refresh = Promise.withResolvers<string>();
  const send = vi.fn(async () => response(401));
  vi.stubGlobal('fetch', send);
  const refreshAccessToken = vi.fn(() => refresh.promise);
  const onTokenRefreshed = vi.fn((next: string) => {
    token = next;
  });
  const api = new ApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: async () => token,
    refreshAccessToken,
    onTokenRefreshed,
  });
  const outcome = api.client.GET('/api/v1/health').catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledOnce());
    token = 'account-b';
    refresh.resolve('account-a-refreshed');
    await expect(outcome).resolves.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(onTokenRefreshed).not.toHaveBeenCalled();
    expect(token).toBe('account-b');
    expect(send).toHaveBeenCalledOnce();
  } finally {
    refresh.resolve('account-a-refreshed');
    await outcome;
  }
});

it.each([false, true])('慢凭据读取返回旧快照，外部换号=%s 时仍按原链校验身份', async (switchAccount) => {
  let token = 'token-0';
  let reads = 0;
  const initialRead = Promise.withResolvers<string>();
  const send = vi.fn(async (request: Request) =>
    response(request.headers.get('authorization') === 'Bearer token-1' ? 200 : 401),
  );
  vi.stubGlobal('fetch', send);
  const refreshAccessToken = vi.fn(async () => {
    token = 'token-1';
    return token;
  });
  const api = new ApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: async () => (++reads === 1 ? initialRead.promise : token),
    refreshAccessToken,
  });
  const slow = api.client.GET('/api/v1/health').catch((error: unknown) => error);
  try {
    await expect(api.client.GET('/api/v1/health')).resolves.toMatchObject({ response: { status: 200 } });
    await expect(api.client.GET('/api/v1/health')).resolves.toMatchObject({ response: { status: 200 } });
    if (switchAccount) token = 'account-b';
    initialRead.resolve('token-0');
    if (switchAccount) {
      await expect(slow).resolves.toMatchObject({ code: 'SESSION_CHANGED' });
      expect(send.mock.calls.at(-1)![0].headers.get('authorization')).toBe('Bearer token-0');
    } else {
      await expect(slow).resolves.toMatchObject({ response: { status: 200 } });
      expect(send.mock.calls.at(-1)![0].headers.get('authorization')).toBe('Bearer token-1');
    }
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  } finally {
    initialRead.resolve('token-0');
    await slow;
  }
});
