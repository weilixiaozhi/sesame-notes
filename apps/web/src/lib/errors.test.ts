import { ApiError } from '@sesame-notes/api-client';
import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors';

describe('认证错误提示', () => {
  it.each([
    [401, 'INVALID_CREDENTIALS', '手机号或密码错误，请检查后重试。'],
    [401, 'SESSION_REQUIRED', '请先登录。'],
    [409, 'PHONE_ALREADY_REGISTERED', '该手机号已注册，请直接登录。'],
    [403, 'ORIGIN_DENIED', '当前页面暂时无法完成身份验证，请刷新后重试；如仍失败，请联系管理员。'],
    [401, 'INVALID_REFRESH_TOKEN', '登录已过期，请重新登录。'],
    [401, 'UNAUTHORIZED', '登录已过期，请重新登录。'],
    [401, 'SESSION_CHANGED', '账号已切换，请在当前账号下重新打开此页面。'],
    [409, 'SESSION_CHANGED', '账号已切换，请在当前账号下重新打开此页面。'],
    [409, 'SYNC_WRITE_FAILED', '这条数据已在其他设备修改。请刷新后核对，再保存你的修改。'],
    [429, 'RATE_LIMITED', '操作有些频繁，请稍后再试。'],
    [503, 'SERVICE_UNAVAILABLE', '服务暂时不可用，你的输入仍保留在当前页面，请稍后重试。'],
  ])('按错误含义展示 %s / %s', (status, code, message) => {
    expect(errorMessage(new ApiError(status, code, '服务端错误'))).toBe(message);
  });

  it('网络故障与请求超时分别提供重试提示', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe('无法连接服务器，请检查网络后重试。');
    expect(errorMessage(new DOMException('timeout', 'TimeoutError'))).toBe('请求超时，请检查网络后重试。');
  });
});
