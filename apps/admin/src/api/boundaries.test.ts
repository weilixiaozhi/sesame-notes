import { describe, expect, it } from 'vitest';
import { pageBounds } from './paging';
import { canAccess, landingPath } from './types';
import type { AdminIdentity } from './types';
import { validateAdminResponse } from './response-validation';
import { canonicalPath, routePage } from '../app/routes';
import { loginSchema, password, passwordSchema } from '../lib/validation';

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
  it('三个统计入口独立导航且复用统计读取授权，未知子路径仍拒绝匹配', () => {
    expect(routePage('/analytics/overview')).toBe('analytics');
    expect(routePage('/analytics/tracking')).toBe('analytics_tracking');
    expect(routePage('/analytics/events?behavior=click')).toBe('analytics_events');
    expect(routePage('/analytics/behavior')).toBeNull();
    expect(canonicalPath('/analytics/behavior')).toBe('/analytics/events');
    expect(canonicalPath('/analytics/usage')).toBe('/analytics/overview');
    expect(routePage('/analytics/tracking/unknown')).toBeNull();
    expect(canAccess(ordinary, 'analytics')).toBe(false);
    expect(canAccess({ ...ordinary, permissions: ['analytics:read'], allowed_pages: ['analytics'] }, 'analytics')).toBe(
      true,
    );
    expect(
      canAccess({ ...ordinary, permissions: ['analytics:read'], allowed_pages: ['analytics'] }, 'analytics_events'),
    ).toBe(true);
    expect(
      canAccess({ ...ordinary, permissions: ['analytics:read'], allowed_pages: ['analytics'] }, 'analytics_tracking'),
    ).toBe(true);
    expect(
      canAccess(
        { ...ordinary, permissions: ['analytics:read'], allowed_pages: ['analytics_events'] },
        'analytics_events',
      ),
    ).toBe(false);
  });
  it('后台首页优先数据概览，但不会给无统计权限账号开放概览', () => {
    expect(landingPath({ ...ordinary, identity_type: 'super_admin' })).toBe('/analytics/overview');
    expect(landingPath({ ...ordinary, permissions: ['analytics:read'], allowed_pages: ['analytics'] })).toBe(
      '/analytics/overview',
    );
    expect(landingPath(ordinary)).toBe('/application/users');
  });
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
  it('默认组空权限的普通用户只有本人中心，超管身份仍独立拥有业务权限', () => {
    const inDefaultGroup = {
      ...ordinary,
      group: { ...ordinary.group, name: '更名后的系统默认组', is_default: true },
      permissions: [],
      allowed_pages: [],
    };
    expect(canAccess(inDefaultGroup, 'users')).toBe(false);
    expect(canAccess(inDefaultGroup, 'audit')).toBe(false);
    expect(canAccess({ ...inDefaultGroup, identity_type: 'super_admin' }, 'groups')).toBe(true);
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
  it('真实总数为空、删除末页或跳过边界时修正页码', () => {
    expect(pageBounds(0, { page: 9, page_size: 10 })).toEqual({ count: 1, page: 1 });
    expect(pageBounds(11, { page: 2, page_size: 10 })).toEqual({ count: 2, page: 2 });
    expect(pageBounds(10, { page: 2, page_size: 10 })).toEqual({ count: 1, page: 1 });
  });
  it('会话响应必须明确返回可空联系方式，缺失字段不能被当作未设置', () => {
    expect(() =>
      validateAdminResponse({
        method: 'GET',
        path: '/api/v1/admin/auth/me',
        status: 200,
        body: {
          admin: { ...ordinary, email: 'operator@example.com', phone: '+8613812345678' },
          expires_at: '2026-10-09T12:00:00Z',
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateAdminResponse({
        method: 'GET',
        path: '/api/v1/admin/auth/me',
        status: 200,
        body: { admin: { ...ordinary, email: undefined }, expires_at: '2026-10-09T12:00:00Z' },
      }),
    ).toThrow();
  });
  it('异常分页结构不能作为真实数据使用', () => {
    expect(() =>
      validateAdminResponse({
        method: 'GET',
        path: '/api/v1/admin/users',
        status: 200,
        body: { items: [], page: 1, page_size: 10 },
      }),
    ).toThrow();
  });
  it('统计响应明确返回已应用来源和统一采集起点，未知或缺失来源不能当成全部', () => {
    const body = {
      range: {
        start_date: '2026-10-10',
        end_date: '2026-10-10',
        timezone: 'Asia/Shanghai',
        bucket: 'hour',
        platform: 'all',
      },
      summary: { new_users: 0, active_users: 0, page_views: 0 },
      series: [],
      coverage: {
        collection_started_at: '2026-10-10T00:00:00Z',
        complete: true,
      },
    };
    for (const platform of ['all', 'app', 'web']) {
      expect(() =>
        validateAdminResponse({
          method: 'GET',
          path: '/api/v1/admin/analytics',
          status: 200,
          body: { ...body, range: { ...body.range, platform } },
        }),
      ).not.toThrow();
    }
    for (const platform of [undefined, 'desktop']) {
      expect(() =>
        validateAdminResponse({
          method: 'GET',
          path: '/api/v1/admin/analytics',
          status: 200,
          body: { ...body, range: { ...body.range, platform } },
        }),
      ).toThrow();
    }
    expect(() =>
      validateAdminResponse({
        method: 'GET',
        path: '/api/v1/admin/analytics',
        status: 200,
        body: { ...body, coverage: { ...body.coverage, collection_started_at: undefined } },
      }),
    ).toThrow();
  });
  it('注册详情路由可刷新，未知路由不获准', () => {
    expect(routePage('/application/users/example')).toBe('users');
    expect(routePage('/system/unregistered')).toBeNull();
  });
  it.each(['短', ' ', '  passphrase  ', '🔒'.repeat(129), 'a'.repeat(1024), 'password', 'operator'])(
    '非空密码不限制长度、字符组合或内容，保留原始输入：第 %# 组',
    (value) => {
      expect(password.parse(value)).toBe(value);
      expect(loginSchema.parse({ username: 'operator', password: value }).password).toBe(value);
      expect(passwordSchema.parse({ old_password: value, new_password: value, confirmation: value }).new_password).toBe(
        value,
      );
    },
  );
  it('密码必填，确认密码须与新密码原样一致', () => {
    expect(password.safeParse('').success).toBe(false);
    expect(loginSchema.safeParse({ username: 'operator', password: '' }).success).toBe(false);
    expect(passwordSchema.safeParse({ old_password: 'a', new_password: '', confirmation: '' }).success).toBe(false);
    expect(passwordSchema.safeParse({ old_password: '', new_password: 'a', confirmation: 'a' }).success).toBe(false);
    const confirmation = passwordSchema.safeParse({ old_password: 'a', new_password: ' b ', confirmation: 'b' });
    expect(confirmation.success).toBe(false);
    if (!confirmation.success) expect(confirmation.error.issues[0]?.path).toEqual(['confirmation']);
  });
});
