import type { FastifyRequest } from 'fastify';

/** 后台查询与实时握手可能携带隐私或票据，访问日志仅保留对应安全入口。 */
export function safeRequestUrl(url: string): string {
  const rawPath = url.split('?')[0] ?? '';
  let path: string;
  try {
    // 路由器会解码路径中的字符，日志使用相同的路径身份判断隐私边界。
    path = decodeURIComponent(rawPath);
  } catch {
    // 无效编码由路由层拒绝；日志仍去除查询，且不能因格式错误影响请求处理。
    return rawPath;
  }
  if (path === '/api/v1/admin' || path.startsWith('/api/v1/admin/')) return '/api/v1/admin';
  if (path === '/api/v1/ws') return '/api/v1/ws';
  return url;
}

/** 访问日志只保留请求定位字段，不包含请求头、Cookie、正文或后台查询内容。 */
export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: safeRequestUrl(request.url),
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/** 保留后台异常类型、稳定错误码及调用栈位置，排除数据库参数与用户输入。 */
export function serializeAdminError(error: unknown) {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const name = typeof value.name === 'string' && /^[A-Z]\w{0,63}$/i.test(value.name) ? value.name : 'Error';
  const code = typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code) ? value.code : undefined;
  // 异常消息与 cause 可能含请求值，只保留引擎产生的源码位置供服务端定位。
  const frames =
    typeof value.stack === 'string'
      ? value.stack
          .split('\n')
          .filter((line) => /^\s+at [^\r\n]+:\d+:\d+\)?$/.test(line))
          .slice(0, 12)
      : [];
  return { type: name, code, message: '后台请求异常', stack: frames.join('\n') };
}
