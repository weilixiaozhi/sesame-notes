import { describe, expect, it } from 'vitest';
import { validateAdminResponse } from './response-validation';

describe('用户管理写操作边界', () => {
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
