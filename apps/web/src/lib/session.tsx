import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiClient, ApiError, unwrap, type paths } from '@sesame-notes/api-client';
import { QueryClient } from '@tanstack/react-query';
import { collectWebDeviceProfile } from './web-device-info';

export type Session = paths['/api/v1/auth/browser/login']['post']['responses'][200]['content']['application/json'];
export type LoginBody = paths['/api/v1/auth/browser/login']['post']['requestBody']['content']['application/json'];
export type SyncChange =
  paths['/api/v1/sync/push']['post']['requestBody']['content']['application/json']['changes'][number];
type Status = 'loading' | 'ready' | 'error';
type Snapshot = { session: Session | null; status: Status; error: unknown };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: { retry: false },
  },
});

let state: Snapshot = { session: null, status: 'loading', error: null };
let generation = 0;
let requests = new AbortController();
let refreshTask: { generation: number; promise: Promise<Session> } | null = null;
let accountClient: { generation: number; client: ApiClient['client'] } | null = null;
let logoutTask: Promise<void> | null = null;
let memoryInstallationId: string | null = null;
const listeners = new Set<(next: Snapshot) => void>();
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sesame-web-session');
const publicApi = new ApiClient({ baseUrl: window.location.origin, getAccessToken: async () => null }).client;

/** 只在内存保存会话，状态切换同步通知界面订阅者。 */
function publish(next: Snapshot) {
  state = next;
  listeners.forEach((listener) => listener(next));
}

/** 会话改变属于终止当前操作，不能自动把旧账号操作重放到新账号。 */
function sessionChanged(): ApiError {
  return new ApiError(409, 'SESSION_CHANGED', '账号已切换，请在当前账号下重新加载。');
}

/** 在异步操作的发送与完成边界验证身份代际。 */
function assertGeneration(expected: number): void {
  if (expected !== generation) throw sessionChanged();
}

/** 同步废弃整代网络请求和缓存；取消完成后也不能清掉新账号刚建立的缓存。 */
async function discardSession(status: Status = 'ready', error: unknown = null): Promise<number> {
  const nextGeneration = ++generation;
  requests.abort(sessionChanged());
  requests = new AbortController();
  accountClient = null;
  const cancellation = queryClient.cancelQueries();
  queryClient.clear();
  publish({ session: null, status, error });
  await cancellation;
  return nextGeneration;
}

/** 标签页共享同一个 Cookie，Web Locks 将刷新、登录、退出串行化。 */
async function withSessionLock<T>(operation: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request('sesame-web-refresh', operation);
  return operation();
}

/** 在已有会话锁内刷新；身份改变时显示新账号，但不给旧请求返回新账号令牌。 */
async function refreshUnlocked(expected: number): Promise<Session> {
  assertGeneration(expected);
  const previous = state.session;
  try {
    const device = await collectWebDeviceProfile();
    assertGeneration(expected);
    const session = unwrap(await publicApi.POST('/api/v1/auth/browser/refresh', { body: { device } }));
    assertGeneration(expected);
    if (previous && (previous.user.user_id !== session.user.user_id || previous.device_id !== session.device_id)) {
      const adoptedGeneration = await discardSession('loading');
      assertGeneration(adoptedGeneration);
      publish({ session, status: 'ready', error: null });
      throw sessionChanged();
    }
    publish({ session, status: 'ready', error: null });
    return session;
  } catch (error) {
    if (expected === generation) {
      if (error instanceof ApiError && error.status === 401) await discardSession();
      else if (!state.session) publish({ session: null, status: 'error', error });
    }
    throw error;
  }
}

/** 同代刷新合并；跨标签页变更后等待旧刷新收尾，再以新代际恢复，避免永久加载。 */
async function refreshSession(expected = generation): Promise<Session> {
  assertGeneration(expected);
  if (refreshTask) {
    if (refreshTask.generation === expected) return refreshTask.promise;
    try {
      await refreshTask.promise;
    } catch {
      /* 旧代失败不决定新代的恢复结果。 */
    }
    assertGeneration(expected);
    return refreshSession(expected);
  }
  const promise = withSessionLock(() => refreshUnlocked(expected));
  const task = { generation: expected, promise };
  refreshTask = task;
  try {
    return await promise;
  } finally {
    if (refreshTask === task) refreshTask = null;
  }
}

/** 每代独立客户端保留刷新闭包，迟到的 401 永远不能读取新账号令牌。 */
function currentApi(): ApiClient['client'] {
  if (!state.session) throw new ApiError(401, 'SESSION_REQUIRED', '请先登录。');
  if (accountClient?.generation === generation) return accountClient.client;
  const expected = generation;
  const userId = state.session.user.user_id;
  const client = new ApiClient({
    baseUrl: window.location.origin,
    getAccessToken: async () => {
      assertGeneration(expected);
      return state.session?.access_token ?? null;
    },
    refreshAccessToken: async () => {
      assertGeneration(expected);
      const session = await refreshSession(expected);
      assertGeneration(expected);
      if (session.user.user_id !== userId) throw sessionChanged();
      return session.access_token;
    },
    validateResponse: () => {
      assertGeneration(expected);
    },
  }).client;
  client.use({
    /** 错误响应也必须先通过代际检查，随后才允许 SDK 判断是否刷新。 */
    onResponse() {
      assertGeneration(expected);
    },
  });
  accountClient = { generation: expected, client };
  return client;
}

const requestMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'request']);
type SessionApi = Omit<ApiClient['client'], 'use' | 'eject'>;

/** 保留生成客户端完整类型，只为每次调用合并取消信号；重放继承同一信号。 */
export const api: SessionApi = guardedApi(currentApi, () => requests.signal);

/** 公共传输边界保留全部生成方法，普通请求与多步任务共用取消机制。 */
function guardedApi(resolveClient: () => ApiClient['client'], resolveSignal: () => AbortSignal): SessionApi {
  return new Proxy(publicApi, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || !requestMethods.has(property)) return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        const client = resolveClient();
        const optionsIndex = property === 'request' ? 2 : 1;
        const options = args[optionsIndex] as { signal?: AbortSignal | null } | undefined;
        const sessionSignal = resolveSignal();
        const signal = options?.signal ? AbortSignal.any([sessionSignal, options.signal]) : sessionSignal;
        // 私有账号响应不进入浏览器 HTTP 缓存；可失效的查询缓存只保留在当前会话内存。
        args[optionsIndex] = { ...options, cache: 'no-store', signal };
        return Reflect.apply(Reflect.get(client, property), client, args);
      };
    },
  });
}

/** 文件解析和多批 REST 导入固定初始账号；返回原生成客户端类型，不重新定义 DTO。 */
export function captureSessionOperation(expectedUserId?: string) {
  const expected = generation;
  const client = currentApi();
  const signal = requests.signal;
  const userId = state.session!.user.user_id;
  if (expectedUserId !== undefined && expectedUserId !== userId) throw sessionChanged();
  const assertCurrent = () => assertGeneration(expected);
  return {
    signal,
    client: guardedApi(
      () => {
        assertCurrent();
        return client;
      },
      () => signal,
    ),
    assertCurrent,
    async invalidate() {
      if (expected === generation) await queryClient.invalidateQueries({ queryKey: ['account', userId] });
    },
  };
}

/** 安装标识不包含身份或令牌；禁用存储时也保持本页面生命周期内稳定。 */
export function installationId(): string {
  if (memoryInstallationId) return memoryInstallationId;
  try {
    const existing = localStorage.getItem('sesame-web-installation');
    if (existing && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(existing)) {
      memoryInstallationId = existing;
      return existing;
    }
    memoryInstallationId = crypto.randomUUID();
    localStorage.setItem('sesame-web-installation', memoryInstallationId);
  } catch {
    memoryInstallationId ??= crypto.randomUUID();
  }
  return memoryInstallationId;
}

/** 登录表单留在原地显示进度；并发登录只有最新代际可以发出请求与发布会话。 */
async function login(body: LoginBody, register = false) {
  const expected = await discardSession('ready');
  try {
    assertGeneration(expected);
    const session = await withSessionLock(async () => {
      assertGeneration(expected);
      return register
        ? unwrap(await publicApi.POST('/api/v1/auth/browser/register', { body }))
        : unwrap(await publicApi.POST('/api/v1/auth/browser/login', { body }));
    });
    assertGeneration(expected);
    publish({ session, status: 'ready', error: null });
    channel?.postMessage({ type: 'changed' });
  } catch (error) {
    if (expected === generation) publish({ session: null, status: 'ready', error: null });
    throw error;
  }
}

/** 锁内公共刷新和退出避免嵌套锁、过期令牌和 Cookie 换号间隙；网络失败保留重试。 */
async function logout() {
  if (logoutTask) return logoutTask;
  const expected = generation;
  const operation = withSessionLock(async () => {
    assertGeneration(expected);
    try {
      const session = await refreshUnlocked(expected);
      assertGeneration(expected);
      unwrap(
        await publicApi.POST('/api/v1/auth/browser/logout', {
          body: {},
          headers: { authorization: `Bearer ${session.access_token}` },
        }),
      );
      assertGeneration(expected);
      await discardSession();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      // 已失效的会话无需再次撤销；若期间变成另一账号，不能清理另一账号。
      if (expected === generation) await discardSession();
      else if (state.session) throw sessionChanged();
    }
    channel?.postMessage({ type: 'logout' });
  });
  logoutTask = operation;
  try {
    await operation;
  } finally {
    if (logoutTask === operation) logoutTask = null;
  }
}

/** 在线写操作沿用同步协议，冲突不能当作成功后直接关闭编辑器。 */
export async function pushChange(change: SyncChange, options: { invalidate?: boolean } = {}): Promise<void> {
  const session = state.session;
  if (!session) throw new ApiError(401, 'SESSION_REQUIRED', '请先登录。');
  const expected = generation;
  const result = unwrap(
    await api.POST('/api/v1/sync/push', { body: { device_id: session.device_id, changes: [change] } }),
  );
  assertGeneration(expected);
  const outcome = result.outcomes.find((item) => item.mutation_id === change.mutation_id);
  // 有事件编号的 ignored 是已成功请求的幂等重放；无编号则未应用本次修改。
  const replayed = outcome?.status === 'ignored' && outcome.change_id != null;
  if (!outcome || (outcome.status !== 'accepted' && !replayed)) {
    await queryClient.invalidateQueries({ queryKey: ['account', session.user.user_id] });
    throw new ApiError(
      outcome?.status === 'conflict' || outcome?.status === 'ignored' ? 409 : 400,
      'SYNC_WRITE_FAILED',
      outcome?.message ??
        (outcome?.status === 'ignored'
          ? '修改未应用，数据已在其他设备变更。请重新核对后保存。'
          : '保存未完成，请刷新后重试。'),
    );
  }
  if (options.invalidate !== false) {
    await queryClient.invalidateQueries({ queryKey: ['account', session.user.user_id] });
  }
}

/** 批量导入固定启动时的会话代次；切换账号后禁止后续记录写入新账号。 */
export function createChangeBatch() {
  const expected = generation;
  const session = state.session;
  if (!session) throw new ApiError(401, 'SESSION_REQUIRED', '请先登录');
  return {
    async push(change: SyncChange) {
      assertGeneration(expected);
      await pushChange(change, { invalidate: false });
      assertGeneration(expected);
    },
    async invalidate() {
      if (expected !== generation) return;
      await queryClient.invalidateQueries({ queryKey: ['account', session.user.user_id] });
    },
  };
}

/** 恢复失败保留明确错误状态；新代恢复会等待旧代 Promise，不复用其过期结果。 */
async function restore(expected = generation) {
  if (expected !== generation) return;
  publish({ ...state, status: 'loading', error: null });
  try {
    await refreshSession(expected);
  } catch {
    /* 刷新入口发布错误、未登录或新身份状态。 */
  }
}

channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!event.data || typeof event.data !== 'object' || !('type' in event.data)) return;
  if (event.data.type === 'logout') void discardSession();
  if (event.data.type === 'changed') void discardSession('loading').then(restore);
});

const SessionContext = createContext({ ...state, login, logout, retry: () => restore() });

/** Provider 订阅会话状态，不把凭证写入浏览器存储。 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    listeners.add(setSnapshot);
    void restore();
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);
  return (
    <SessionContext.Provider value={{ ...snapshot, login, logout, retry: () => restore() }}>
      {children}
    </SessionContext.Provider>
  );
}

/** 页面通过上下文读取当前身份，不直接操作令牌。 */
export function useSession() {
  return useContext(SessionContext);
}
