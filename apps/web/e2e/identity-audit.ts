import type { Request, Response } from '@playwright/test';

type IdentityResponse = Pick<Response, 'url' | 'ok' | 'status' | 'headers' | 'json'> & {
  request: () => Pick<Request, 'method' | 'headers' | 'postDataJSON'>;
};
type RecordIdentities = (method: string, path: string, value: unknown) => void;

/** 仅读取业务变更的身份；认证单独登记，临时票据与统计回执不产生业务实体。 */
export async function auditBrowserMutation(response: IdentityResponse, record: RecordIdentities): Promise<void> {
  const request = response.request();
  const method = request.method();
  const path = new URL(response.url()).pathname;
  if (
    !response.ok() ||
    method === 'GET' ||
    !path.startsWith('/api/v1/') ||
    path.startsWith('/api/v1/auth/') ||
    path === '/api/v1/ws/ticket' ||
    path === '/api/v1/analytics/events'
  )
    return;
  try {
    // 请求载荷在开始异步读取响应前取出，正文只交给 UUID 提取器，不写入诊断文件。
    const input: unknown = request.headers()['content-type']?.includes('json') ? request.postDataJSON() : null;
    const body: unknown =
      response.status() !== 204 && response.status() !== 205 && response.headers()['content-type']?.includes('json')
        ? await response.json()
        : null;
    record(method, path, { input, body });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : '未知读取错误';
    throw new Error(`测试数据身份记录失败：${method} ${path}；${detail}`, { cause });
  }
}
