import { AdminApiClient, ApiError } from '@sesame-notes/api-client';
import { validateAdminResponse } from './response-validation';

export const sessionEvents = new EventTarget();
export const api = new AdminApiClient({
  baseUrl: window.location.origin,
  validateResponse: validateAdminResponse,
  onUnauthorized: () => sessionEvents.dispatchEvent(new Event('unauthorized')),
});

/** 前端可纠正的输入错误仅携带已知友好文案，不冒充网络故障。 */
export class InputError extends Error {}

/** 错误日志仅记录技术关联信息，不记录请求参数、手机号、密码或响应数据。 */
export function reportError(context: string, error: unknown): void {
  console.error('[Sesame Admin]', {
    context,
    code: error instanceof ApiError ? error.code : 'CLIENT_ERROR',
    status: error instanceof ApiError ? error.status : undefined,
    requestId: error instanceof ApiError ? error.requestId : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  });
}

/** 请求边界集中处理会话失效；写请求不会刷新凭据或自动重放。 */
export async function request<T>(operation: () => Promise<T>, context: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) sessionEvents.dispatchEvent(new Event('verify'));
    if (!(error instanceof DOMException && error.name === 'AbortError')) reportError(context, error);
    throw error;
  }
}

/** 业务错误使用稳定中文提示，不将服务端内部标识或原始错误直接暴露到页面。 */
export function errorMessage(error: unknown, context: 'operation' | 'login' = 'operation'): string {
  if (error instanceof InputError) return error.message;
  if (!(error instanceof ApiError)) return '连接暂时不可用，请检查网络后重试。';
  const messages: Record<string, string> = {
    INVALID_CREDENTIALS: '账号或密码不正确，请检查后重试。',
    ADMIN_AUTH_UNAVAILABLE: '后台登录验证暂时不可用，请稍后重试。',
    ORIGIN_DENIED: '请求未通过安全验证，请刷新页面后重试。',
    ADMIN_REQUEST_REQUIRED: '请求未通过安全验证，请刷新页面后重试。',
    ADMIN_USERNAME_EXISTS: '此登录账号已存在，请更换。',
    ADMIN_EMAIL_EXISTS: '此邮箱已被其他后台用户使用，请更换。',
    ADMIN_PHONE_EXISTS: '此手机号已被其他后台用户使用，请更换。',
    ADMIN_EMAIL_INVALID: '请输入有效的邮箱地址。',
    ADMIN_PHONE_INVALID: '请输入国内 11 位手机号，或包含国际区号的手机号。',
    PHONE_ALREADY_REGISTERED: '此手机号已被其他用户使用，请更换手机号。',
    USER_PHONE_CHANGED: '用户手机号已被修改，请关闭弹窗并核对最新手机号后重试。',
    PHONE_UNCHANGED: '新手机号与当前手机号相同，请填写其他手机号。',
    PHONE_INVALID: '请输入有效手机号，并选择正确的国家或地区区号。',
    AVATAR_VERSION_CONFLICT: '用户头像已被修改，请关闭弹窗并核对最新头像后重试。',
    AVATAR_INVALID: '图片内容无效，请选择有效的 PNG、JPEG 或 WebP 图片。',
    AVATAR_TOO_LARGE: '图片不能超过 8 MB，请压缩后重试。',
    FITNESS_CONTENT_CHANGED: '内容已被其他人修改，请刷新后重新核对。',
    FITNESS_TAXON_CHANGED: '分类已被其他人修改，请关闭弹窗并核对最新资料后重试。',
    FITNESS_TAXON_REFERENCED: '此分类仍被动作或模板引用，请关闭弹窗并核对引用后，选择替代项再删除。',
    FITNESS_TAXON_REPLACEMENT_INVALID: '替代项已不可用，请选择同类型的有效分类。',
    FITNESS_TAXON_UNAVAILABLE: '所选部位或器械已不可用，请重新选择。',
    FITNESS_CONTENT_INVALID: '请检查必填资料、教学步骤和数值格式。',
    FITNESS_CONTENT_NOT_FOUND: '此健身内容已不可用，请刷新列表。',
    FITNESS_CONTENT_REFERENCED: '内容仍被启用的模板或计划引用，请先调整引用。',
    FITNESS_REFERENCE_UNAVAILABLE: '引用的动作或模板不存在或已停用，请重新选择。',
    FITNESS_PLAN_SCHEDULE_INVALID: '请为周期中的每一天选择训练模板或休息，并至少安排一次训练。',
    FITNESS_TEMPLATE_WEIGHT_INVALID: '自重动作不填写重量，其他重量模式需要填写重量。',
    FITNESS_MEDIA_NOT_FOUND: '动作 GIF 不可用，请重新选择或上传。',
    FITNESS_MEDIA_FILENAME: '请选择 GIF 格式文件。',
    FITNESS_MEDIA_SIZE: 'GIF 文件无效或超过 10 MB。',
    FITNESS_MEDIA_FORMAT: '文件内容不是有效 GIF，请重新选择。',
    FITNESS_MEDIA_DIMENSIONS: 'GIF 的尺寸或帧数过大，请压缩后重试。',
    FITNESS_MEDIA_DECODE: 'GIF 无法正常读取，请更换文件。',
    ANALYTICS_RANGE_INVALID: '请选择有效的统计起止日期，单次查询最长十年。',
    ANALYTICS_RANGE_FUTURE: '结束日期不能晚于今天。',
    ANALYTICS_FILTER_INVALID: '事件、发生页面与来源不匹配，请重新选择查询条件。',
    ANALYTICS_BUCKET_INVALID: '此时间范围不适合按小时查看，请按日或月查询。',
    ANALYTICS_NOT_READY: '数据采集尚未初始化，请稍后再试。',
    ANALYTICS_FUNNEL_INVALID: '请选择 2 至 8 个漏斗步骤，转化窗口需为 1 分钟至 7 天。',
    ANALYTICS_FUNNEL_STEP_INVALID: '漏斗中的事件已不可用，请重新选择步骤。',
    ANALYTICS_FUNNEL_STEP_PLATFORM_INVALID: '部分漏斗步骤未在所选来源采集，请调整步骤或来源。',
    ADMIN_VERSION_CONFLICT: '内容已被修改，请刷新并核对后重试。',
    LAST_SUPER_ADMIN: '必须保留至少一名已启用的超级管理员。',
    ADMIN_GROUP_NOT_EMPTY: '用户组仍有成员，请先转移成员。',
    ADMIN_DEFAULT_GROUP_PROTECTED: '默认用户组不能停用或删除。',
    ADMIN_GROUP_NOT_FOUND: '用户组已不可用，请刷新后重新选择。',
    ADMIN_PERMISSION_INVALID: '所选权限不可分配，请刷新权限目录后重试。',
    ADMIN_PERMISSION_DEPENDENCY: '权限缺少必要的查询权限，请检查选择。',
    INVALID_API_RESPONSE: '服务返回的数据不符合约定，请稍后重试。',
  };
  if (messages[error.code]) return messages[error.code]!;
  if (error.status === 401)
    return context === 'login' ? '登录验证未通过，请检查账号和密码后重试。' : '登录状态已失效，请重新登录。';
  if (context === 'login' && error.status >= 500) return '登录服务暂时不可用，请稍后重试。';
  if (error.status === 403) return '当前账号没有执行此操作的权限。';
  if (error.status === 404) return '内容不存在或已被删除，请刷新。';
  if (error.status === 409) return '内容或账号状态已变化，请刷新并核对。';
  if (error.status === 429) return '操作过于频繁，请稍后重试。';
  if (error.status === 400) return '提交内容不符合要求，请检查填写内容。';
  return '操作未能确认完成，请刷新核对当前状态后再重试。';
}
