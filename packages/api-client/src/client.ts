import createClient, { type Middleware } from 'openapi-fetch';

import type { paths } from './generated/api.js';
import { ApiError } from './errors.js';

type AuthProvider = () => Promise<string | null>;
type RefreshHandler = () => Promise<string>;
type TokenGeneration = { authorization: string | null; next?: TokenGeneration };
type RefreshTask = {
  generation: TokenGeneration;
  promise: Promise<TokenGeneration>;
  observed: Set<TokenGeneration>;
};
type RequestTransport = (request: Request, init?: RequestInit) => Promise<Response>;
type ReplayableRequest = { request: Request; transport: RequestTransport; init?: RequestInit };

// HEAD 的无正文语义属于本次调用结果，不能由远端零长度头或跨请求复用的响应冒充。
const headResults = new WeakSet<object>();

type ResponseValidationContext = {
  method: string;
  path: string;
  status: number;
  body: unknown;
};

export type ResponseValidator = (context: ResponseValidationContext) => void | Promise<void>;

export interface ApiClientOptions {
  /** API 根地址，例如 https://api.example.com */
  baseUrl: string;
  /** 返回当前 Access Token；未登录返回 null。 */
  getAccessToken: AuthProvider;
  /** 刷新并返回新 Access Token；提供后启用 401 单飞刷新与请求重放。 */
  refreshAccessToken?: RefreshHandler;
  /** 刷新成功后回调，调用方把新 token 写回内存，供下次请求使用。 */
  onTokenRefreshed?: (token: string) => void;
  /** 请求超时毫秒数，默认 15000。 */
  timeoutMs?: number;
  /** 浏览器凭证策略，默认 include，以支持跨子域 HttpOnly Refresh Cookie。 */
  credentials?: RequestCredentials;
  /** 可选的运行时响应校验器；调用方可按 path 校验关键响应，失败时抛出错误。 */
  validateResponse?: ResponseValidator;
}

/** 携带超时与外部取消信号的 fetch 封装：内部信号与调用方信号取并集， 任一触发都会中止请求，符合规范对 AbortController 取消的要求。 */
function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // openapi-fetch 以 fetch(request, requestInitExt) 调用：调用方信号在 Request.signal 上
    const inputSignal = input instanceof Request ? input.signal : init?.signal;
    const combined = inputSignal ? AbortSignal.any([inputSignal, timeoutSignal]) : timeoutSignal;
    return fetch(input, { ...init, signal: combined });
  };
}

/** 调用方取消只结束自己的等待，共享身份刷新仍可继续服务其他请求。 */
async function awaitRequestOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: (() => void) | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }),
    ]);
    // 已完成的 Promise 可能先赢得竞争；继续身份操作前仍需确认取消状态。
    signal.throwIfAborted();
    return result;
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
  }
}

/** 按契约路径精确识别登录与刷新端点，避免 401 重放形成无限循环。 */
function isAuthEndpoint(schemaPath: string): boolean {
  return /^\/api\/v1\/auth\/(?:browser\/)?(?:login|register|refresh|logout)$/.test(schemaPath);
}

/**
 * 类型安全的 API 客户端。
 *
 * 职责边界：
 * - 请求路径与载荷类型来自 OpenAPI 生成类型（packages/api-contract）。
 * - 中间件透明处理 Access Token 注入、401 单飞刷新重放与响应校验。
 * - 调用方通过 unwrap() 拿到强类型数据或结构化 ApiError。
 */
export class ApiClient {
  readonly client: ReturnType<typeof createClient<paths>>;

  /** 初始化请求超时、身份注入、刷新重放和响应校验中间件。 */
  constructor(options: ApiClientOptions) {
    const timeoutFetch = createTimeoutFetch(options.timeoutMs ?? 15_000);
    let refreshTask: RefreshTask | null = null;
    let currentGeneration: TokenGeneration | undefined;
    let tokenReads = 0;
    const tokenReadRoots = new Set<TokenGeneration>();
    const requestGenerations = new WeakMap<object, TokenGeneration>();
    const replayableRequests = new WeakMap<Request, ReplayableRequest>();

    /** 只沿本客户端确认的刷新链识别令牌；外部身份变更建立独立节点。 */
    function tokenGeneration(authorization: string | null): TokenGeneration {
      let matching: TokenGeneration | undefined;
      for (const root of [currentGeneration, ...tokenReadRoots]) {
        for (let known = root; known; known = known.next) {
          if (known.authorization === authorization) matching = known;
        }
        if (matching) break;
      }
      // 刷新服务可能返回相同字符串，新请求仍属于最新一次已确认的刷新状态。
      currentGeneration = matching ?? { authorization };
      if (tokenReads > 0) tokenReadRoots.add(currentGeneration);
      // 提前发布期间的新请求先独立记录，只有刷新实际返回相同令牌后才能确认归属。
      if (!matching) refreshTask?.observed.add(currentGeneration);
      return currentGeneration;
    }

    /** 仅已确认的刷新后继属于当前请求，链外凭据不能接管旧请求。 */
    function latestConfirmedGeneration(original: TokenGeneration, authorization: string | null): TokenGeneration {
      let latest = original;
      let sameSession = original.authorization === authorization;
      while (latest.next) {
        latest = latest.next;
        sameSession ||= latest.authorization === authorization;
      }
      if (!sameSession) throw new ApiError(409, 'SESSION_CHANGED', '请求身份已变化，请重新发起操作');
      return latest;
    }

    /** 在途刷新必须由本请求或已确认的后继发起，其他身份的任务不能接管本请求。 */
    function assertRefreshGeneration(original: TokenGeneration, refreshing: TokenGeneration): void {
      for (let known: TokenGeneration | undefined = original; known; known = known.next) {
        if (known === refreshing) return;
      }
      throw new ApiError(409, 'SESSION_CHANGED', '请求身份已变化，请重新发起操作');
    }

    /** 等同会话的在途刷新完成再校验凭据，允许刷新函数在返回前发布新令牌。 */
    async function confirmedGeneration(original: TokenGeneration, signal: AbortSignal): Promise<TokenGeneration> {
      while (true) {
        const pending = refreshTask;
        if (pending) {
          const awaitingPublication = pending.observed.has(original);
          if (!awaitingPublication) assertRefreshGeneration(original, pending.generation);
          const refreshed = await awaitRequestOperation(pending.promise, signal);
          if (awaitingPublication) assertRefreshGeneration(original, refreshed);
        }
        const token = await awaitRequestOperation(options.getAccessToken(), signal);
        // 凭据读取期间也可能启动下一轮刷新；先等该轮身份关系确定，避免把提前发布误判为换号。
        if (refreshTask && refreshTask !== pending) continue;
        return latestConfirmedGeneration(original, token ? `Bearer ${token}` : null);
      }
    }

    /** 实际发送前保存最终请求及其传输函数，重放沿用本次调用选择的完整传输策略。 */
    function captureTransport(transport: RequestTransport): RequestTransport {
      return (request, init) => {
        if (options.refreshAccessToken) replayableRequests.set(request, { request: request.clone(), transport, init });
        return transport(request, init);
      };
    }

    const responseBoundaryMiddleware: Middleware = {
      /** 在生成类型接管响应前执行可选的运行时校验，并规范无内容成功响应。 校验只读取 clone，不会消费 openapi-fetch 后续需要解析的原响应。 */
      async onResponse({ response, request, schemaPath }) {
        const normalized = normalizeEmptyResponse(response, request.method);
        if (!options.validateResponse || !normalized.ok) return normalized;

        const body = await parseValidationBody(normalized, request.method, schemaPath);
        try {
          await options.validateResponse({
            method: request.method,
            path: schemaPath,
            status: normalized.status,
            body,
          });
          return normalized;
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(
            normalized.status,
            'INVALID_API_RESPONSE',
            '服务返回的数据不符合接口约定',
            responseRequestId(normalized, body),
            undefined,
            { cause: error },
          );
        }
      },
    };

    const authMiddleware: Middleware = {
      /** 每个请求注入当前 Access Token。 */
      async onRequest({ request, options: requestOptions }) {
        request.signal.throwIfAborted();
        tokenReads++;
        if (currentGeneration) tokenReadRoots.add(currentGeneration);
        try {
          const token = await awaitRequestOperation(options.getAccessToken(), request.signal);
          if (token) request.headers.set('authorization', `Bearer ${token}`);
          requestGenerations.set(requestOptions, tokenGeneration(request.headers.get('authorization')));
        } finally {
          // 慢读取可能返回刷新前快照；读取窗口结束即释放祖先锚点，不积累历史令牌。
          if (--tokenReads === 0) tokenReadRoots.clear();
        }
      },
    };

    const refreshMiddleware: Middleware = {
      /** 401 单飞刷新：并发请求共享同一个刷新 Promise，只触发一次刷新； 成功后用新 token 重放原请求。 */
      async onResponse({ response, request, schemaPath, options: requestOptions }) {
        if (response.status !== 401 || !options.refreshAccessToken || isAuthEndpoint(schemaPath)) {
          return response;
        }
        request.signal.throwIfAborted();
        const replayable = replayableRequests.get(request);
        if (!replayable) throw new ApiError(0, 'REQUEST_REPLAY_FAILED', '请求重试失败，请稍后重试');
        const original = requestGenerations.get(requestOptions);
        if (!original || original.authorization !== replayable.request.headers.get('authorization'))
          throw new ApiError(409, 'SESSION_CHANGED', '请求身份已变化，请重新发起操作');
        let latest = await confirmedGeneration(original, request.signal);
        request.signal.throwIfAborted();
        if (latest === original) {
          if (refreshTask) assertRefreshGeneration(original, refreshTask.generation);
          if (!refreshTask) {
            const generation = original;
            const observed = new Set<TokenGeneration>();
            const promise = options.refreshAccessToken().then(async (token) => {
              const refreshed = { authorization: `Bearer ${token}` };
              const activeToken = await options.getAccessToken();
              const activeAuthorization = activeToken ? `Bearer ${activeToken}` : null;
              // 刷新函数可自行发布新令牌；其余情况必须先确认原身份仍有效，再通知调用方写入。
              if (activeAuthorization !== refreshed.authorization)
                latestConfirmedGeneration(generation, activeAuthorization);
              options.onTokenRefreshed?.(token);
              generation.next = refreshed;
              // 提前发布产生的节点与原请求共用同一个后继，后续刷新才能保持整条链连通。
              for (const candidate of observed) {
                if (candidate.authorization === refreshed.authorization) candidate.next = refreshed;
              }
              return refreshed;
            });
            const task = { generation, promise, observed };
            refreshTask = task;
            // 无论刷新是否成功都释放单飞任务，取消某个等待者不会提前清理其他等待者的任务。
            void promise
              .finally(() => {
                if (refreshTask === task) refreshTask = null;
              })
              .catch(() => undefined);
          }
          await awaitRequestOperation(refreshTask.promise, request.signal);
          latest = await confirmedGeneration(original, request.signal);
        }
        request.signal.throwIfAborted();
        const retry = new Request(replayable.request);
        retry.headers.set('authorization', latest.authorization!);
        return replayable.transport(retry, replayable.init);
      },
    };

    const client = createClient<paths>({
      baseUrl: options.baseUrl,
      fetch: captureTransport(timeoutFetch),
      credentials: options.credentials ?? 'include',
    });
    const requestMethods = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE', 'request']);
    // openapi-fetch 允许单次调用覆盖 fetch，入口包装确保该传输同样能保存最终中间件请求。
    this.client = new Proxy(client, {
      /** 保留客户端方法签名和中间件能力，仅包装请求选项里的传输覆盖。 */
      get(target, property, receiver) {
        const method: unknown = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || !requestMethods.has(property) || typeof method !== 'function')
          return method;
        return (...args: unknown[]) => {
          const initIndex = property === 'request' ? 2 : 1;
          const init = args[initIndex] as { fetch?: RequestTransport } | undefined;
          if (init?.fetch) args[initIndex] = { ...init, fetch: captureTransport(init.fetch) };
          const result = Reflect.apply(method, target, args) as Promise<{ response: Response }>;
          if (property === 'HEAD' || (property === 'request' && args[0] === 'head')) {
            // 请求中间件可以直接返回缓存响应；以调用方法保存语义，涵盖跳过传输的 HEAD。
            return result.then((value) => {
              headResults.add(value);
              return value;
            });
          }
          return result;
        };
      },
    });
    // 响应中间件逆序执行：刷新先完成重放，再由边界校验器检查最终响应。
    this.client.use(responseBoundaryMiddleware, authMiddleware, refreshMiddleware);
  }
}

/** 把 openapi-fetch 结果解包为强类型数据；存在错误时抛出结构化 ApiError。 */
export function unwrap<T>(result: { data?: T; error?: unknown; response?: Response }): T {
  if (result.error !== undefined || (result.response && !result.response.ok)) {
    throw ApiError.from(result.error, result.response);
  }
  if (result.data === undefined) {
    if (result.response && (isEmptyResponse(result.response, '') || headResults.has(result))) return undefined as T;
    throw new ApiError(
      result.response?.status ?? 0,
      'EMPTY_RESPONSE',
      '响应缺少数据',
      result.response?.headers.get('x-request-id') ?? undefined,
    );
  }
  return result.data;
}

/** 只允许 204、205、HEAD 无正文；其他成功响应缺少数据时在传输边界拒绝。 */
function normalizeEmptyResponse(response: Response, method: string): Response {
  if (!response.ok) return response;
  if (!isEmptyResponse(response, method)) {
    if (response.body === null || response.headers.get('content-length') === '0') {
      throw new ApiError(
        response.status,
        'EMPTY_RESPONSE',
        '响应缺少数据',
        response.headers.get('x-request-id') ?? undefined,
      );
    }
    return response;
  }
  let normalized = response;
  if (response.status !== 204 && response.headers.get('content-length') !== '0') {
    const headers = new Headers(response.headers);
    headers.set('content-length', '0');
    normalized = new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
  return normalized;
}

/** 为可选校验器解析响应副本；空响应返回 undefined，JSON 损坏统一转成友好契约错误。 */
async function parseValidationBody(response: Response, method: string, schemaPath: string): Promise<unknown> {
  if (isEmptyResponse(response, method)) return undefined;
  try {
    // 只有契约明确声明的头像下载允许二进制；其他成功响应仍必须能解析为 JSON。
    if (schemaPath === '/api/v1/profile/avatar/{user_id}' && method === 'GET') {
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      // 服务端按头像原格式返回图片，三种契约格式都以原始字节交给调用方。
      if (!contentType || !['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
        throw new Error('INVALID_AVATAR_CONTENT_TYPE');
      }
      return await response.clone().blob();
    }
    return await response.clone().json();
  } catch (error) {
    throw new ApiError(
      response.status,
      'INVALID_API_RESPONSE',
      '服务返回的数据不符合接口约定',
      response.headers.get('x-request-id') ?? undefined,
      undefined,
      { cause: error },
    );
  }
}

/** 判断响应是否按 HTTP 语义不携带正文。 */
function isEmptyResponse(response: Response, method: string): boolean {
  return response.status === 204 || response.status === 205 || method === 'HEAD';
}

/** 优先从响应体读取服务端 request_id，缺失时回退到响应头。 */
function responseRequestId(response: Response, body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'request_id' in body && typeof body.request_id === 'string') {
    return body.request_id;
  }
  return response.headers.get('x-request-id') ?? undefined;
}
