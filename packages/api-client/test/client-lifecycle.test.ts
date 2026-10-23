import { afterEach, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/client.js';

/** 构造与接口错误边界相同的 JSON 响应。 */
function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

it('同一过期令牌的迟到 401 使用已经刷新的令牌，不再次轮换会话', async () => {
  let token = 'expired';
  const late = Promise.withResolvers<Response>();
  let originalRequests = 0;
  const send = vi.fn(async (request: Request) => {
    if (request.headers.get('authorization') === 'Bearer refreshed') return response(200, { status: 'ok' });
    return ++originalRequests === 1 ? response(401) : late.promise;
  });
  vi.stubGlobal('fetch', send);
  const refreshAccessToken = vi.fn(async () => {
    token = 'refreshed';
    return token;
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', getAccessToken: async () => token, refreshAccessToken });
  const first = api.client.GET('/api/v1/health');
  const second = api.client.GET('/api/v1/health');
  try {
    await expect(first).resolves.toMatchObject({ data: { status: 'ok' } });
    late.resolve(response(401));
    await expect(second).resolves.toMatchObject({ data: { status: 'ok' } });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(4);
  } finally {
    late.resolve(response(401));
    await Promise.allSettled([first, second]);
  }
});

it.each(['default', 'override', 'request'] as const)(
  '%s 传输在后续中间件替换 Request 后，重放最终实际发送的正文、头部和请求策略',
  async (transport) => {
    const bodies: string[] = [];
    const send = vi.fn(async (request: Request) => {
      bodies.push(await request.text());
      return response(bodies.length === 1 ? 401 : 201, { id: 'ledger' });
    });
    const defaultFetch = transport === 'default' ? send : vi.fn();
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
    const init = { body: { name: '初始正文' }, ...(transport === 'default' ? {} : { fetch: send }) };
    const pending =
      transport === 'request'
        ? api.client.request('post', '/api/v1/ledgers', init)
        : api.client.POST('/api/v1/ledgers', init);
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
    if (transport !== 'default') expect(defaultFetch).not.toHaveBeenCalled();
  },
);

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

it('刷新等待期间外部切换账号时，已完成的旧刷新也不能触发重放', async () => {
  let token = 'account-a';
  const refresh = Promise.withResolvers<string>();
  const send = vi.fn(async () => response(401));
  vi.stubGlobal('fetch', send);
  const refreshAccessToken = vi.fn(() => refresh.promise);
  const api = new ApiClient({ baseUrl: 'https://api.test', getAccessToken: async () => token, refreshAccessToken });
  const request = api.client.POST('/api/v1/ledgers', { body: { name: 'A 的草稿' } });
  const outcome = request.catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledOnce());
    token = 'account-b';
    refresh.resolve('account-a-refreshed');
    await expect(outcome).resolves.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(send).toHaveBeenCalledOnce();
  } finally {
    refresh.resolve('account-a-refreshed');
    await outcome;
  }
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

it('不同请求自带传输共享刷新，替换 Request 的取消信号只终止对应等待者', async () => {
  const refresh = Promise.withResolvers<string>();
  const controller = new AbortController();
  const defaultFetch = vi.fn();
  vi.stubGlobal('fetch', defaultFetch);
  const firstBodies: string[] = [];
  const secondBodies: string[] = [];
  /** 分别记录每个传输收到的正文，确认重放没有串用其他请求的传输。 */
  function transport(bodies: string[]) {
    return vi.fn(async (request: Request) => {
      bodies.push(await request.text());
      return response(request.headers.get('authorization') === 'Bearer refreshed' ? 201 : 401, { id: 'ledger' });
    });
  }
  const firstFetch = transport(firstBodies);
  const secondFetch = transport(secondBodies);
  const refreshAccessToken = vi.fn(() => refresh.promise);
  const api = new ApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: async () => 'expired',
    refreshAccessToken,
  });
  api.client.use({
    /** 只替换第一个请求的取消信号，验证刷新等待使用最终请求携带的信号。 */
    onRequest({ request }) {
      return request.headers.get('x-request-owner') === 'first'
        ? new Request(request, { signal: controller.signal })
        : request;
    },
  });
  const first = api.client
    .POST('/api/v1/ledgers', {
      body: { name: 'first' },
      headers: { 'x-request-owner': 'first' },
      fetch: firstFetch,
    })
    .catch((error: unknown) => error);
  const second = api.client.POST('/api/v1/ledgers', { body: { name: 'second' }, fetch: secondFetch });
  try {
    await vi.waitFor(() => {
      expect(refreshAccessToken).toHaveBeenCalledOnce();
      expect(firstFetch).toHaveBeenCalledOnce();
      expect(secondFetch).toHaveBeenCalledOnce();
    });
    const reason = new DOMException('取消第一个请求', 'AbortError');
    controller.abort(reason);
    await expect(first).resolves.toBe(reason);
    refresh.resolve('refreshed');
    await expect(second).resolves.toMatchObject({ data: { id: 'ledger' } });
    expect(firstBodies).toEqual(['{"name":"first"}']);
    expect(secondBodies).toEqual(['{"name":"second"}', '{"name":"second"}']);
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(defaultFetch).not.toHaveBeenCalled();
  } finally {
    refresh.resolve('refreshed');
    await Promise.allSettled([first, second]);
  }
});

it('凭据读取与取消在同一轮完成时，已取消的请求不能启动刷新', async () => {
  const controller = new AbortController();
  const reason = new DOMException('凭据读取期间取消', 'AbortError');
  let tokenReads = 0;
  const refreshAccessToken = vi.fn(async () => 'refreshed');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(401)),
  );
  const api = new ApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: async () => {
      if (++tokenReads === 2) controller.abort(reason);
      return 'expired';
    },
    refreshAccessToken,
  });
  await expect(api.client.GET('/api/v1/health', { signal: controller.signal })).rejects.toBe(reason);
  expect(refreshAccessToken).not.toHaveBeenCalled();
});

it('刷新函数先发布令牌后完成时，间隙到达的旧 401 等待同一次刷新', async () => {
  let token = 'expired';
  const refresh = Promise.withResolvers<string>();
  const late = Promise.withResolvers<Response>();
  let originalRequests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      if (request.headers.get('authorization') === 'Bearer refreshed') return response(200);
      return ++originalRequests === 1 ? response(401) : late.promise;
    }),
  );
  const getAccessToken = vi.fn(async () => token);
  const refreshAccessToken = vi.fn(() => {
    token = 'refreshed';
    return refresh.promise;
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', getAccessToken, refreshAccessToken });
  let lateArrived = false;
  api.client.use({
    /** 标记迟到响应已进入响应链，断言不依赖内部 provider 的调用次数。 */
    onResponse({ response }) {
      if (response.headers.has('x-delayed')) lateArrived = true;
    },
  });
  const first = api.client.GET('/api/v1/health');
  const second = api.client.GET('/api/v1/health').catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledOnce());
    const unauthorized = response(401);
    unauthorized.headers.set('x-delayed', 'true');
    late.resolve(unauthorized);
    await vi.waitFor(() => expect(lateArrived).toBe(true));
    refresh.resolve('refreshed');
    await expect(first).resolves.toMatchObject({ response: { status: 200 } });
    await expect(second).resolves.toMatchObject({ response: { status: 200 } });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  } finally {
    late.resolve(response(401));
    refresh.resolve('refreshed');
    await Promise.allSettled([first, second]);
  }
});

it('最早令牌的迟到 401 会等待已确认后继正在进行的下一轮刷新', async () => {
  let token = 'token-0';
  let accepted = 'token-1';
  const nextRefresh = Promise.withResolvers<string>();
  const late = Promise.withResolvers<Response>();
  let originalRequests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      if (++originalRequests === 1) return late.promise;
      return response(request.headers.get('authorization') === `Bearer ${accepted}` ? 200 : 401);
    }),
  );
  const refreshAccessToken = vi.fn(() => {
    token = accepted;
    return token === 'token-1' ? Promise.resolve(token) : nextRefresh.promise;
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', getAccessToken: async () => token, refreshAccessToken });
  let lateArrived = false;
  api.client.use({
    /** 标记最早请求的迟到响应已进入中间件。 */
    onResponse({ response }) {
      if (response.headers.has('x-delayed')) lateArrived = true;
    },
  });
  const oldest = api.client.GET('/api/v1/health').catch((error: unknown) => error);
  let secondRound: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(originalRequests).toBe(1));
    await expect(api.client.GET('/api/v1/health')).resolves.toMatchObject({ response: { status: 200 } });
    accepted = 'token-2';
    secondRound = api.client.GET('/api/v1/health');
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledTimes(2));
    const unauthorized = response(401);
    unauthorized.headers.set('x-delayed', 'true');
    late.resolve(unauthorized);
    await vi.waitFor(() => expect(lateArrived).toBe(true));
    nextRefresh.resolve('token-2');
    await expect(secondRound).resolves.toMatchObject({ response: { status: 200 } });
    await expect(oldest).resolves.toMatchObject({ response: { status: 200 } });
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
  } finally {
    late.resolve(response(401));
    nextRefresh.resolve('token-2');
    await Promise.allSettled([oldest, secondRound]);
  }
});

it('提前发布期间成功的新请求归入已确认刷新链，最早请求仍可跨两轮刷新重放', async () => {
  let token = 'token-0';
  let accepted = 'token-1';
  const refresh = Promise.withResolvers<string>();
  const late = Promise.withResolvers<Response>();
  const send = vi.fn(async (request: Request) => {
    if (
      request.headers.get('x-request-owner') === 'oldest' &&
      request.headers.get('authorization') === 'Bearer token-0'
    )
      return late.promise;
    return response(request.headers.get('authorization') === `Bearer ${accepted}` ? 200 : 401);
  });
  vi.stubGlobal('fetch', send);
  let refreshCount = 0;
  const refreshAccessToken = vi.fn(async () => {
    token = accepted;
    return ++refreshCount === 1 ? refresh.promise : token;
  });
  const api = new ApiClient({ baseUrl: 'https://api.test', getAccessToken: async () => token, refreshAccessToken });
  const oldest = api.client
    .GET('/api/v1/health', { headers: { 'x-request-owner': 'oldest' } })
    .catch((error: unknown) => error);
  const first = api.client.GET('/api/v1/health');
  try {
    await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledOnce());
    await expect(api.client.GET('/api/v1/health')).resolves.toMatchObject({ response: { status: 200 } });
    refresh.resolve('token-1');
    await first;
    accepted = 'token-2';
    await expect(api.client.GET('/api/v1/health')).resolves.toMatchObject({ response: { status: 200 } });
    late.resolve(response(401));
    await expect(oldest).resolves.toMatchObject({ response: { status: 200 } });
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.at(-1)![0].headers.get('authorization')).toBe('Bearer token-2');
  } finally {
    refresh.resolve('token-1');
    late.resolve(response(401));
    await Promise.allSettled([oldest, first]);
  }
});

it('各层异步恢复期间取消均不能在刷新入口已取消时启动新刷新', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(401)),
  );
  for (let turns = 0; turns < 9; turns++) {
    const controller = new AbortController();
    let reads = 0;
    const refreshSawAborted: boolean[] = [];
    /** 改变取消与异步恢复的先后，验证刷新入口的取消状态而非内部 await 次数。 */
    function cancelAfter(remaining: number) {
      if (remaining === 0) controller.abort();
      else queueMicrotask(() => cancelAfter(remaining - 1));
    }
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      getAccessToken: async () => {
        if (++reads === 2) cancelAfter(turns);
        return 'expired';
      },
      refreshAccessToken: async () => {
        refreshSawAborted.push(controller.signal.aborted);
        return 'fresh';
      },
    });
    await api.client.GET('/api/v1/health', { signal: controller.signal }).catch(() => undefined);
    expect(refreshSawAborted).not.toContain(true);
  }
});

it.each(['refreshed', 'account-b'] as const)(
  '刷新期间新请求使用 %s 时，仅本次返回令牌可以确认归属并重放',
  async (candidateToken) => {
    let token = 'expired';
    let candidateCalls = 0;
    const refresh = Promise.withResolvers<string>();
    const send = vi.fn(async (request: Request) => {
      if (request.headers.has('x-candidate') && ++candidateCalls === 1) return response(401);
      return response(request.headers.get('authorization') === 'Bearer refreshed' ? 200 : 401);
    });
    vi.stubGlobal('fetch', send);
    const refreshAccessToken = vi.fn(() => {
      token = 'refreshed';
      return refresh.promise;
    });
    const onTokenRefreshed = vi.fn((next: string) => {
      token = next;
    });
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      getAccessToken: async () => token,
      refreshAccessToken,
      onTokenRefreshed,
    });
    const first = api.client.GET('/api/v1/health').catch((error: unknown) => error);
    let candidate: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(refreshAccessToken).toHaveBeenCalledOnce());
      token = candidateToken;
      candidate = api.client
        .GET('/api/v1/health', { headers: { 'x-candidate': 'true' } })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(candidateCalls).toBe(1));
      refresh.resolve('refreshed');
      if (candidateToken === 'refreshed') {
        await expect(first).resolves.toMatchObject({ response: { status: 200 } });
        await expect(candidate).resolves.toMatchObject({ response: { status: 200 } });
        expect(candidateCalls).toBe(2);
        expect(onTokenRefreshed).toHaveBeenCalledOnce();
      } else {
        await expect(first).resolves.toMatchObject({ code: 'SESSION_CHANGED' });
        await expect(candidate).resolves.toMatchObject({ code: 'SESSION_CHANGED' });
        expect(candidateCalls).toBe(1);
        expect(onTokenRefreshed).not.toHaveBeenCalled();
        expect(token).toBe('account-b');
      }
      expect(refreshAccessToken).toHaveBeenCalledOnce();
    } finally {
      refresh.resolve('refreshed');
      await Promise.allSettled([first, candidate]);
    }
  },
);

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
