/** 客户端统一的 API 错误结构，与后端错误契约一一对应。 */
type ApiErrorBody = {
  code: string;
  message: string;
  request_id: string;
  details?: unknown;
};

/** 结构化 API 错误：保留服务端错误码、面向用户消息、请求编号和状态码。 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
  }

  /** 从 openapi-fetch 的错误载荷与原始响应构造稳定错误；优先保留服务端业务字段， 非结构化响应则按 HTTP 状态生成不泄露底层细节的友好提示。 */
  static from(error: unknown, response?: Response): ApiError {
    if (error instanceof ApiError) return error;
    if (error && typeof error === 'object') {
      const body = error as Partial<ApiErrorBody>;
      if (typeof body.code === 'string') {
        const status = response?.status ?? 0;
        return new ApiError(
          status,
          body.code,
          typeof body.message === 'string' && body.message ? body.message : friendlyHttpMessage(status),
          typeof body.request_id === 'string' ? body.request_id : (response?.headers.get('x-request-id') ?? undefined),
          body.details,
        );
      }
    }
    const status = response?.status ?? 0;
    return new ApiError(
      status,
      status > 0 ? `HTTP_${status}` : 'API_ERROR',
      friendlyHttpMessage(status),
      response?.headers.get('x-request-id') ?? undefined,
    );
  }
}

/** 根据 HTTP 状态提供不泄露服务端细节的稳定中文提示。 */
function friendlyHttpMessage(status: number): string {
  if (status === 401) return '登录状态已失效，请重新登录';
  if (status === 403) return '你没有执行此操作的权限';
  if (status === 404) return '请求的内容不存在';
  if (status === 409) return '请求冲突，请刷新后重试';
  if (status === 429) return '操作过于频繁，请稍后重试';
  if (status >= 500) return '服务暂时不可用，请稍后重试';
  return '请求失败，请稍后重试';
}
