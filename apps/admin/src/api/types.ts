import type { api } from './client';

export type SessionResponse = Awaited<ReturnType<typeof api.adminAuth.me>>;
export type AdminIdentity = SessionResponse['admin'];
type AccountPage = Awaited<ReturnType<typeof api.adminAccounts.list>>;
export type Account = AccountPage['items'][number];
type GroupPage = Awaited<ReturnType<typeof api.adminGroups.list>>;
export type Group = GroupPage['items'][number];
type UserPage = Awaited<ReturnType<typeof api.adminUsers.list>>;
export type User = UserPage['items'][number];
export type UserDetail = Awaited<ReturnType<typeof api.adminUsers.detail>>;
type DevicePage = Awaited<ReturnType<typeof api.adminUsers.devices>>;
export type Device = DevicePage['items'][number];
type AuditPage = Awaited<ReturnType<typeof api.adminAudit.list>>;
export type Audit = AuditPage['items'][number];
export type PermissionCatalog = Awaited<ReturnType<typeof api.adminCatalog.permissions>>;
export type PageId =
  | 'users'
  | 'accounts'
  | 'groups'
  | 'audit'
  | 'analytics'
  | 'analytics_events'
  | 'analytics_tracking'
  | 'fitness_exercises'
  | 'fitness_templates'
  | 'fitness_plans';
export type Paging = { page: number; page_size: 10 | 20 | 50 | 100 };
export const initialPaging: Paging = { page: 1, page_size: 10 };
export const pageInfo: Record<PageId, { title: string; path: string; permission?: string; accessPage?: string }> = {
  analytics: { title: '数据概览', path: '/analytics/overview', permission: 'analytics:read' },
  analytics_events: {
    title: '事件分析',
    path: '/analytics/events',
    permission: 'analytics:read',
    accessPage: 'analytics',
  },
  analytics_tracking: {
    title: '埋点管理',
    path: '/analytics/tracking',
    permission: 'analytics:read',
    accessPage: 'analytics',
  },
  users: { title: '用户管理', path: '/application/users', permission: 'users:read' },
  accounts: { title: '后台用户', path: '/system/accounts' },
  groups: { title: '用户组管理', path: '/system/groups' },
  audit: { title: '操作日志', path: '/system/operation-logs', permission: 'audit:read' },
  fitness_exercises: { title: '动作库', path: '/fitness/exercises', permission: 'fitness:read' },
  fitness_templates: { title: '训练模板', path: '/fitness/templates', permission: 'fitness:read' },
  fitness_plans: { title: '训练计划', path: '/fitness/plans', permission: 'fitness:read' },
};

/** 页面准入同时校验服务端页面授权与所需读取权限，未知身份默认拒绝。 */
export function canAccess(admin: AdminIdentity, page: PageId): boolean {
  if (!admin.is_enabled || !['super_admin', 'standard_user'].includes(admin.identity_type)) return false;
  if (admin.identity_type === 'super_admin') return true;
  if (!admin.group.is_enabled) return false;
  if (page === 'accounts' || page === 'groups') return false;
  return (
    admin.allowed_pages.includes(pageInfo[page].accessPage ?? page) &&
    admin.permissions.includes(pageInfo[page].permission!)
  );
}

/** 有数据读取权限时以概览为后台首页，其他账号进入其首个获授权页面。 */
export function landingPath(admin: AdminIdentity): string {
  const first = (Object.keys(pageInfo) as PageId[]).find((page) => canAccess(admin, page));
  return first ? pageInfo[first].path : '/account';
}

/** 后台身份显示采用已知身份值，未识别值不会伪装成普通用户。 */
export function identityLabel(value: string): string {
  return value === 'super_admin' ? '超级管理员' : value === 'standard_user' ? '普通用户' : '未知身份';
}

/** 日期统一使用上海时区；无效或缺失日期不编造显示值。 */
export function dateTime(value: string | null | undefined): string {
  if (!value) return '未提供';
  try {
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? '未提供'
      : new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          dateStyle: 'short',
          timeStyle: 'medium',
          hour12: false,
        }).format(date);
  } catch {
    return '未提供';
  }
}
