import { ApiError } from '@sesame-notes/api-client';

/** 将传输和业务错误转换为可操作的用户提示，不暴露请求载荷。 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // 同一 HTTP 状态可能对应凭据错误、未登录或会话失效，先按业务错误码确定用户可采取的操作。
    if (error.code === 'INVALID_CREDENTIALS') return '手机号或密码错误，请检查后重试。';
    if (error.code === 'SESSION_REQUIRED') return '请先登录。';
    if (error.code === 'PHONE_ALREADY_REGISTERED') return '该手机号已注册，请直接登录。';
    if (error.code === 'ORIGIN_DENIED') return '当前页面暂时无法完成身份验证，请刷新后重试；如仍失败，请联系管理员。';
    if (error.code === 'SESSION_CHANGED') return '账号已切换，请在当前账号下重新打开此页面。';
    if (error.status === 401) return '登录已过期，请重新登录。';
    if (error.status === 403) return '当前账号没有此操作的权限，或该内容已不可访问。';
    if (error.status === 409) return '这条数据已在其他设备修改。请刷新后核对，再保存你的修改。';
    if (error.status === 429) return '操作有些频繁，请稍后再试。';
    if (error.status >= 500) return '服务暂时不可用，你的输入仍保留在当前页面，请稍后重试。';
    return error.message;
  }
  if ((error instanceof Error || error instanceof DOMException) && error.name === 'TimeoutError')
    return '请求超时，请检查网络后重试。';
  if (error instanceof TypeError) return '无法连接服务器，请检查网络后重试。';
  if (error instanceof Error) return error.message;
  return '操作未完成，请稍后重试。';
}
