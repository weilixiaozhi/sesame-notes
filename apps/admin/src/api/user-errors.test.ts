// @vitest-environment jsdom
import { ApiError } from '@sesame-notes/api-client';
import { describe, expect, it } from 'vitest';
import { errorMessage } from './client';
import { validateAdminResponse } from './response-validation';

describe('用户管理写操作边界', () => {
  it.each([
    ['PHONE_ALREADY_REGISTERED', '此手机号已被其他用户使用，请更换手机号。'],
    ['USER_PHONE_CHANGED', '用户手机号已被修改，请关闭弹窗并核对最新手机号后重试。'],
    ['PHONE_UNCHANGED', '新手机号与当前手机号相同，请填写其他手机号。'],
    ['PHONE_INVALID', '请输入有效手机号，并选择正确的国家或地区区号。'],
    ['AVATAR_VERSION_CONFLICT', '用户头像已被修改，请关闭弹窗并核对最新头像后重试。'],
    ['AVATAR_INVALID', '图片内容无效，请选择有效的 PNG、JPEG 或 WebP 图片。'],
    ['AVATAR_TOO_LARGE', '图片不能超过 8 MB，请压缩后重试。'],
  ])('业务错误 %s 告知用户可执行的下一步', (code, message) => {
    expect(errorMessage(new ApiError(400, code, '不向用户展示原始内部错误'))).toBe(message);
  });

  it('头像更新响应必须提供头像地址和正整数版本，不能将不完整返回当作成功', () => {
    const response = { method: 'PUT', path: '/api/v1/admin/users/{user_id}/avatar', status: 200 };
    expect(() =>
      validateAdminResponse({
        ...response,
        body: { avatar_url: '/api/v1/admin/users/user-1/avatar?v=1', avatar_version: 1 },
      }),
    ).not.toThrow();
    for (const body of [
      undefined,
      {},
      { avatar_url: null, avatar_version: 1 },
      { avatar_url: '/avatar', avatar_version: 0 },
    ]) {
      expect(() => validateAdminResponse({ ...response, body })).toThrow();
    }
  });
});
