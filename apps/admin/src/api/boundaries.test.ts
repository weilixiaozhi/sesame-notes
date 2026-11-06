import { describe, expect, it } from 'vitest';
import { canAccess } from './types';
import type { AdminIdentity } from './types';
import { validateAdminResponse } from './response-validation';

const ordinary: AdminIdentity = {
  id: 'admin',
  username: 'operator',
  email: null,
  phone: null,
  display_name: '运营',
  identity_type: 'standard_user',
  group_id: 'group',
  group: { id: 'group', name: '自定义组', is_enabled: true, is_default: false, version: 1 },
  is_enabled: true,
  permissions: ['users:read'],
  allowed_pages: ['users'],
  authorization_version: '1',
};

describe('授权和响应边界', () => {
  it('页面访问同时要求页面和动作权限，不根据组名推断', () => {
    expect(canAccess(ordinary, 'users')).toBe(true);
    expect(canAccess({ ...ordinary, allowed_pages: [] }, 'users')).toBe(false);
    expect(canAccess({ ...ordinary, permissions: [] }, 'users')).toBe(false);
    expect(canAccess(ordinary, 'accounts')).toBe(false);
    expect(canAccess({ ...ordinary, group: { ...ordinary.group, is_enabled: false } }, 'users')).toBe(false);
  });
  it('超级管理员独立于组启停，未知身份默认拒绝', () => {
    expect(
      canAccess(
        { ...ordinary, identity_type: 'super_admin', group: { ...ordinary.group, is_enabled: false } },
        'groups',
      ),
    ).toBe(true);
    expect(canAccess({ ...ordinary, identity_type: 'unexpected' as AdminIdentity['identity_type'] }, 'users')).toBe(
      false,
    );
  });
  it('账号与会话响应拒绝无组，默认标志必须由服务端明确返回', () => {
    const admin = { ...ordinary, group: { ...ordinary.group, is_default: true } };
    expect(() =>
      validateAdminResponse({
        method: 'GET',
        path: '/api/v1/admin/auth/me',
        status: 200,
        body: { admin, expires_at: '2026-10-09T12:00:00Z' },
      }),
    ).not.toThrow();
    expect(() =>
      validateAdminResponse({
        method: 'GET',
        path: '/api/v1/admin/auth/me',
        status: 200,
        body: { admin: { ...admin, group: null, group_id: null }, expires_at: '2026-10-09T12:00:00Z' },
      }),
    ).toThrow();
    expect(() =>
      validateAdminResponse({
        method: 'GET',
        path: '/api/v1/admin/auth/me',
        status: 200,
        body: {
          admin: { ...admin, group: { id: 'group', name: '默认分组', is_enabled: true, version: 1 } },
          expires_at: '2026-10-09T12:00:00Z',
        },
      }),
    ).toThrow();
  });
});
