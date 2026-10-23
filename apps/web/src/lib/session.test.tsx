import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, LoginBody, SyncChange } from './session';

type SessionModule = typeof import('./session');
type Snapshot = ReturnType<SessionModule['useSession']>;
type Handler = (request: Request) => Response | Promise<Response>;
let current: Snapshot;
let module: SessionModule;
let handler: Handler;
let sent: Request[];
let channels: TestChannel[];
let refreshResponse: Session;
let lockQueue: Promise<unknown>;

/** 手工控制响应完成顺序，以覆盖真实网络中迟到的请求。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** 只模拟跨标签页通知传输，不模拟生产会话逻辑。 */
class TestChannel {
  listener?: (event: MessageEvent<unknown>) => void;
  postMessage = vi.fn();
  constructor() {
    channels.push(this);
  }
  addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) {
    this.listener = listener;
  }
  emit(data: unknown) {
    this.listener?.({ data } as MessageEvent<unknown>);
  }
}

/** 所有响应类型来自生成契约，测试不会另建 HTTP DTO。 */
function session(user: string, token = `${user}-token`): Session {
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: 900,
    device_id: `${user}-device`,
    scopes: ['sync:read', 'sync:write'],
    user: {
      user_id: user,
      sesame_number: '100001',
      display_name: user,
      avatar_url: null,
      avatar_version: 0,
      phone: '+8613900000000',
      gender: 'UNSPECIFIED',
    },
  };
}

/** 生成标准 JSON 响应，保留 ApiClient、openapi-fetch 与错误映射的真实行为。 */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 浏览器凭据采用已有契约生成类型。 */
function credentials(phone: string): LoginBody {
  return {
    country_code: '+86',
    phone,
    password: 'test-password',
    device: { installation_id: 'f18d8716-c4ad-4e61-bd34-cae3a008e41a', name: 'test browser', platform: 'web' },
  };
}

/** 挂载真实 Provider 并读取最终用户可见的身份状态。 */
async function mount(waitUntilReady = true) {
  module = await import('./session');
  function Probe() {
    current = module.useSession();
    return <output>{`${current.status}:${current.session?.user.user_id ?? 'anonymous'}`}</output>;
  }
  render(
    <module.SessionProvider>
      <Probe />
    </module.SessionProvider>,
  );
  if (waitUntilReady) await waitFor(() => expect(current.status).toBe('ready'));
}

/** flush 异步会话更新，使断言覆盖 React 真正发布后的状态。 */
async function settle(operation: () => Promise<unknown>) {
  await act(async () => {
    await operation();
  });
}

beforeEach(() => {
  vi.resetModules();
  sent = [];
  channels = [];
  lockQueue = Promise.resolve();
  refreshResponse = session('A');
  vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('navigator', {
    locks: {
      request: vi.fn((_name: string, operation: () => Promise<unknown>) => {
        const pending = lockQueue.then(operation);
        lockQueue = pending.catch(() => undefined);
        return pending;
      }),
    },
  });
  handler = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/refresh')) return json(refreshResponse);
    if (path.endsWith('/login') || path.endsWith('/register')) {
      const body = (await request.json()) as LoginBody;
      return json(session(body.phone));
    }
    if (path.endsWith('/logout')) return new Response(null, { status: 204 });
    return json({ items: [], ledgers: [] });
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      sent.push(request);
      return handler(request);
    }),
  );
});

it('普通鉴权请求与批量操作均禁止浏览器缓存私人数据', async () => {
  await mount();
  await module.api.GET('/api/v1/ledgers');
  const operation = module.captureSessionOperation();
  await operation.client.GET('/api/v1/ledgers');
  const business = sent.filter((request) => new URL(request.url).pathname === '/api/v1/ledgers');
  expect(business).toHaveLength(2);
  expect(business.every((request) => request.cache === 'no-store')).toBe(true);
});

afterEach(() => {
  module?.queryClient.clear();
  vi.unstubAllGlobals();
});

describe('browser session isolation', () => {
  it('刷新会话附带当前发布和可得设备资料，不接受设备归属字段', async () => {
    vi.stubGlobal('__WEB_APP_VERSION__', '2.6.1');
    Object.assign(navigator, {
      userAgentData: {
        platform: 'Android',
        getHighEntropyValues: async () => ({ model: 'Pixel 8', platformVersion: '14.0.0' }),
      },
    });
    await mount();
    expect(await sent[0]!.clone().json()).toEqual({
      device: { platform: 'web', app_version: '2.6.1', os_version: 'Android 14.0.0', device_model: 'Pixel 8' },
    });
  });

  it('刷新缺少 Client Hints 时省略空资料，既有设备字段无需被清空', async () => {
    vi.stubGlobal('__WEB_APP_VERSION__', '2.6.1');
    await mount();
    expect(await sent[0]!.clone().json()).toEqual({ device: { platform: 'web', app_version: '2.6.1' } });
  });

  it('等待设备资料时退出账号，迟到资料不能继续发送旧代际的刷新请求', async () => {
    const hints = deferred<Record<string, unknown>>();
    const readHints = vi.fn(() => hints.promise);
    Object.assign(navigator, { userAgentData: { getHighEntropyValues: readHints } });
    await mount(false);
    await waitFor(() => expect(readHints).toHaveBeenCalledOnce());
    await act(async () => channels[0]!.emit({ type: 'logout' }));
    await act(async () => hints.resolve({ platformVersion: '14.0.0', model: 'Pixel 8' }));
    expect(current.status).toBe('ready');
    expect(current.session).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('首次打开没有 Cookie 时保持正常未登录，登录失败不刷新会话且可重新登录', async () => {
    handler = (request) =>
      request.url.endsWith('/refresh')
        ? json({ code: 'REFRESH_TOKEN_REQUIRED', message: '登录状态已失效，请重新登录' }, 401)
        : json({ code: 'INVALID_CREDENTIALS', message: '手机号或密码错误' }, 401);
    await mount();
    expect(current.session).toBeNull();
    expect(current.error).toBeNull();
    await settle(async () => {
      await expect(current.login(credentials('A'))).rejects.toMatchObject({
        status: 401,
        code: 'INVALID_CREDENTIALS',
      });
    });
    expect(current.status).toBe('ready');
    expect(current.error).toBeNull();
    expect(current.session).toBeNull();
    expect(sent.filter((request) => request.url.endsWith('/refresh'))).toHaveLength(1);
    handler = () => json(session('A'));
    await settle(() => current.login(credentials('A')));
    expect(current.session?.user.user_id).toBe('A');
  });

  it('protects the generated generic request method with the same account and cancellation boundary', async () => {
    await mount();
    const delayed = deferred<Response>();
    handler = () => delayed.promise;
    const pending = module.api.request('get', '/api/v1/ledgers').catch((error: unknown) => error);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.headers.get('authorization')).toBe('Bearer A-token');
    await act(async () => {
      channels[0]!.emit({ type: 'logout' });
    });
    delayed.resolve(json({ ledgers: [] }));
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' });
    expect(sent[1]!.signal.aborted).toBe(true);
  });

  it('keeps initial network errors visible and can restore after reconnecting', async () => {
    handler = () => {
      throw new TypeError('offline');
    };
    await mount(false);
    await waitFor(() => expect(current.status).toBe('error'));
    expect(current.session).toBeNull();
    handler = () => json(session('A'));
    await settle(() => current.retry());
    expect(current.status).toBe('ready');
    expect(current.session?.user.user_id).toBe('A');
  });

  it('shares one refresh for concurrent unauthorized requests', async () => {
    await mount();
    const refresh = deferred<Response>();
    handler = (request) => {
      if (request.url.endsWith('/refresh')) return refresh.promise;
      return request.headers.get('authorization') === 'Bearer A-token'
        ? json({ code: 'UNAUTHORIZED', message: 'expired' }, 401)
        : json({ ledgers: [] });
    };
    const first = module.api.GET('/api/v1/ledgers');
    const second = module.api.GET('/api/v1/ledgers');
    await waitFor(() => expect(sent.filter((item) => item.url.endsWith('/refresh'))).toHaveLength(2));
    await settle(async () => {
      refresh.resolve(json(session('A', 'fresh-A')));
      await Promise.all([first, second]);
    });
    expect(sent.filter((item) => item.url.endsWith('/refresh'))).toHaveLength(2);
    expect(sent.filter((item) => item.headers.get('authorization') === 'Bearer fresh-A')).toHaveLength(2);
    expect(sent.filter((item) => item.url.endsWith('/ledgers')).every((item) => item.cache === 'no-store')).toBe(true);
  });

  it.each([200, 401])(
    'rejects a late %s response after account switching without refreshing or replaying',
    async (status) => {
      await mount();
      module.queryClient.setQueryData(['account', 'A', 'secret'], 'private-A');
      const delayed = deferred<Response>();
      const normal = handler;
      handler = (request) => (request.url.endsWith('/ledgers') ? delayed.promise : normal(request));
      const pending = module.api.POST('/api/v1/ledgers', {
        body: { id: '089b3e65-2aa7-40cd-8617-88c77025d9d8', name: 'A private ledger', currency: 'CNY' },
      });
      const result = pending.catch((error: unknown) => error);
      await waitFor(() => expect(sent.some((item) => item.url.endsWith('/ledgers'))).toBe(true));
      const original = sent.find((item) => item.url.endsWith('/ledgers'))!;
      await settle(() => current.login(credentials('B')));
      module.queryClient.setQueryData(['account', 'B', 'safe'], 'private-B');
      delayed.resolve(json(status === 200 ? { id: 'old-A' } : { code: 'UNAUTHORIZED' }, status));
      expect(await result).toMatchObject({ code: 'SESSION_CHANGED' });
      expect(original.signal.aborted).toBe(true);
      expect(sent.filter((item) => item.url.endsWith('/ledgers'))).toHaveLength(1);
      expect(sent.filter((item) => item.url.endsWith('/refresh'))).toHaveLength(1);
      expect(module.queryClient.getQueryData(['account', 'A', 'secret'])).toBeUndefined();
      expect(module.queryClient.getQueryData(['account', 'B', 'safe'])).toBe('private-B');
      expect(current.session?.user.user_id).toBe('B');
    },
  );

  it('never replays an A operation using a different account returned by the refresh cookie', async () => {
    await mount();
    module.queryClient.setQueryData(['account', 'A', 'secret'], 'private-A');
    handler = (request) =>
      request.url.endsWith('/refresh') ? json(session('B')) : json({ code: 'UNAUTHORIZED' }, 401);
    let error: unknown;
    await settle(async () => {
      error = await module.api
        .POST('/api/v1/ledgers', { body: { name: 'A ledger', currency: 'CNY' } })
        .catch((value: unknown) => value);
    });
    expect(error).toMatchObject({ code: 'SESSION_CHANGED' });
    expect(sent.filter((item) => item.url.endsWith('/ledgers'))).toHaveLength(1);
    expect(current.session?.user.user_id).toBe('B');
    expect(module.queryClient.getQueryData(['account', 'A', 'secret'])).toBeUndefined();
  });

  it('resumes a changed notification after an obsolete initial refresh finishes', async () => {
    const firstRefresh = deferred<Response>();
    let count = 0;
    handler = () => (++count === 1 ? firstRefresh.promise : json(session('B')));
    await mount(false);
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => {
      channels[0]!.emit({ type: 'changed' });
    });
    await act(async () => {
      firstRefresh.resolve(json(session('A')));
    });
    await waitFor(() => expect(current.status).toBe('ready'));
    expect(current.session?.user.user_id).toBe('B');
    expect(count).toBe(2);
  });

  it('does not restore an obsolete refresh after a logout notification', async () => {
    const delayed = deferred<Response>();
    handler = () => delayed.promise;
    await mount(false);
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => {
      channels[0]!.emit({ type: 'logout' });
    });
    await act(async () => {
      delayed.resolve(json(session('A')));
    });
    expect(current.status).toBe('ready');
    expect(current.session).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('cancels old in-flight refresh replay when a new login supersedes it', async () => {
    await mount();
    const refresh = deferred<Response>();
    const normal = handler;
    handler = (request) =>
      request.url.endsWith('/refresh')
        ? refresh.promise
        : request.url.endsWith('/ledgers')
          ? json({ code: 'UNAUTHORIZED' }, 401)
          : normal(request);
    const pending = module.api.GET('/api/v1/ledgers').catch((error: unknown) => error);
    await waitFor(() => expect(sent.filter((item) => item.url.endsWith('/refresh'))).toHaveLength(2));
    await settle(async () => {
      const login = current.login(credentials('B'));
      refresh.resolve(json(session('A', 'late-A')));
      await login;
    });
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' });
    expect(current.session?.user.user_id).toBe('B');
    expect(sent.filter((item) => item.url.endsWith('/ledgers'))).toHaveLength(1);
  });

  it('retains caller cancellation alongside session cancellation', async () => {
    await mount();
    const delayed = deferred<Response>();
    handler = () => delayed.promise;
    const controller = new AbortController();
    const pending = module.api.GET('/api/v1/ledgers', { signal: controller.signal });
    await waitFor(() => expect(sent).toHaveLength(2));
    controller.abort();
    expect(sent[1]!.signal.aborted).toBe(true);
    delayed.resolve(json({ ledgers: [] }));
    await pending;
  });

  it('only sends the newest of simultaneous logins and leaves the login form mounted', async () => {
    await mount();
    let results: PromiseSettledResult<void>[] = [];
    await settle(async () => {
      results = await Promise.allSettled([current.login(credentials('A')), current.login(credentials('B'))]);
    });
    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('fulfilled');
    expect(sent.filter((item) => item.url.endsWith('/login'))).toHaveLength(1);
    expect(current.status).toBe('ready');
    expect(current.session?.user.user_id).toBe('B');
  });

  it('keeps an installation identifier stable when browser storage is denied', async () => {
    await mount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const first = module.installationId();
    expect(module.installationId()).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('browser logout', () => {
  it('refreshes an expired access token within a single lock and clears all private caches', async () => {
    await mount();
    module.queryClient.setQueryData(['account', 'A', 'secret'], 'private-A');
    refreshResponse = session('A', 'fresh-A');
    await settle(() => current.logout());
    const logout = sent.find((item) => item.url.endsWith('/logout'));
    expect(logout?.headers.get('authorization')).toBe('Bearer fresh-A');
    expect(current.session).toBeNull();
    expect(module.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(channels[0]!.postMessage).toHaveBeenCalledWith({ type: 'logout' });
  });

  it('treats an already revoked session as signed out without a nested lock or request loop', async () => {
    await mount();
    handler = () => json({ code: 'INVALID_REFRESH_TOKEN', message: 'expired' }, 401);
    await settle(() => current.logout());
    expect(current.session).toBeNull();
    expect(current.status).toBe('ready');
    expect(sent.filter((item) => item.url.endsWith('/logout'))).toHaveLength(0);
  });

  it('retains the current session and reports network failure so logout can be retried', async () => {
    await mount();
    const normal = handler;
    handler = () => {
      throw new TypeError('offline');
    };
    await expect(current.logout()).rejects.toThrow('offline');
    expect(current.session?.user.user_id).toBe('A');
    expect(channels[0]!.postMessage).not.toHaveBeenCalled();
    handler = normal;
    await settle(() => current.logout());
    expect(current.session).toBeNull();
  });

  it('does not sign out B when the initiating tab still shows A', async () => {
    await mount();
    refreshResponse = session('B');
    let error: unknown;
    await settle(async () => {
      error = await current.logout().catch((value: unknown) => value);
    });
    expect(error).toMatchObject({ code: 'SESSION_CHANGED' });
    expect(current.session?.user.user_id).toBe('B');
    expect(sent.filter((item) => item.url.endsWith('/logout'))).toHaveLength(0);
    expect(channels[0]!.postMessage).not.toHaveBeenCalled();
  });

  it('coalesces repeated clicks into one server logout', async () => {
    await mount();
    await settle(() => Promise.all([current.logout(), current.logout()]));
    expect(sent.filter((item) => item.url.endsWith('/logout'))).toHaveLength(1);
  });
});

describe('bulk import session boundary', () => {
  it('keeps generated REST methods tied to the original identity across asynchronous file parsing', async () => {
    await mount();
    const operation = module.captureSessionOperation();
    const stopRendering = vi.fn();
    operation.signal.addEventListener('abort', stopRendering, { once: true });
    await settle(() => current.login(credentials('B')));
    expect(operation.signal.aborted).toBe(true);
    expect(stopRendering).toHaveBeenCalledOnce();
    expect(operation.assertCurrent).toThrow();
    await expect(operation.client.GET('/api/v1/ledgers')).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(sent.filter((item) => item.url.endsWith('/ledgers'))).toHaveLength(0);
  });

  it('cancels captured REST requests that are in flight when the account changes', async () => {
    await mount();
    const operation = module.captureSessionOperation();
    const delayed = deferred<Response>();
    const normal = handler;
    handler = (request) => (request.url.endsWith('/ledgers') ? delayed.promise : normal(request));
    const pending = operation.client.GET('/api/v1/ledgers').catch((error: unknown) => error);
    await waitFor(() => expect(sent.filter((item) => item.url.endsWith('/ledgers'))).toHaveLength(1));
    await settle(() => current.login(credentials('B')));
    expect(sent.find((item) => item.url.endsWith('/ledgers'))!.signal.aborted).toBe(true);
    delayed.resolve(json([]));
    expect(await pending).toMatchObject({ code: 'SESSION_CHANGED' });
  });
  const change: SyncChange = {
    mutation_id: '26b59cb9-daa4-4c43-bbd7-d6fe7065e8f3',
    entity_type: 'memo_book',
    entity_id: 'bfa4debb-5cc4-4e53-9f0b-82c57f923856',
    ledger_id: null,
    memo_book_id: 'bfa4debb-5cc4-4e53-9f0b-82c57f923856',
    day_book_id: null,
    base_revision: 0,
    action: 'upsert',
    payload: {
      name: '导入测试本',
      type: 'normal',
      created_at: '2026-09-30T08:00:00.000Z',
      updated_at: '2026-09-30T08:00:00.000Z',
    },
    updated_at: '2026-09-30T08:00:00.000Z',
  };

  it('defers successful per-record refresh until the caller completes the batch', async () => {
    await mount();
    const invalidate = vi.spyOn(module.queryClient, 'invalidateQueries');
    handler = () => json({ outcomes: [{ mutation_id: change.mutation_id, status: 'accepted' }] });
    const batch = module.createChangeBatch();
    await batch.push(change);
    await batch.push({ ...change, entity_id: 'bfa4debb-5cc4-4e53-9f0b-82c57f923857' });
    expect(invalidate).not.toHaveBeenCalled();
    await batch.invalidate();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['account', 'A'] });
  });

  it('rejects subsequent records after switching accounts, including a later return to the original user', async () => {
    await mount();
    const batch = module.createChangeBatch();
    await settle(() => current.login(credentials('B')));
    await settle(() => current.login(credentials('A')));
    const invalidate = vi.spyOn(module.queryClient, 'invalidateQueries');
    await expect(batch.push(change)).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await batch.invalidate();
    expect(sent.filter((item) => item.url.endsWith('/sync/push'))).toHaveLength(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refreshes authoritative state and stops the batch when a write conflicts', async () => {
    await mount();
    const invalidate = vi.spyOn(module.queryClient, 'invalidateQueries');
    handler = () =>
      json({ outcomes: [{ mutation_id: change.mutation_id, status: 'conflict', message: '版本已更新' }] });
    await expect(module.createChangeBatch().push(change)).rejects.toMatchObject({ status: 409 });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['account', 'A'] });
  });

  it('keeps a stale ignored write from being reported as saved and stops subsequent import work', async () => {
    await mount();
    const invalidate = vi.spyOn(module.queryClient, 'invalidateQueries');
    handler = () => json({ outcomes: [{ mutation_id: change.mutation_id, status: 'ignored', change_id: null }] });
    await expect(module.pushChange(change)).rejects.toMatchObject({ status: 409, code: 'SYNC_WRITE_FAILED' });
    await expect(module.createChangeBatch().push(change)).rejects.toMatchObject({ status: 409 });
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('accepts an ignored replay with the original event receipt after an unknown response', async () => {
    await mount();
    const invalidate = vi.spyOn(module.queryClient, 'invalidateQueries');
    const batch = module.createChangeBatch();
    let delivered = false;
    handler = () => {
      if (!delivered) {
        delivered = true;
        throw new TypeError('response lost after server commit');
      }
      return json({ outcomes: [{ mutation_id: change.mutation_id, status: 'ignored', change_id: '123' }] });
    };
    await expect(batch.push(change)).rejects.toThrow('response lost');
    await expect(batch.push(change)).resolves.toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
    await batch.invalidate();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ['account', 'A'] });
  });
});
