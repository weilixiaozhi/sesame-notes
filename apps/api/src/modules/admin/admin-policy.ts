import type { AdminAccount, AdminGroup } from '@prisma/client';

import { ApiError } from '../../shared/errors.js';

export const DEFAULT_ADMIN_GROUP_ID = 'a0000000-0000-4000-8000-000000000000';
export const ADMIN_IDENTITIES = [
  { value: 'super_admin', label: '超级管理员' },
  { value: 'standard_user', label: '普通用户' },
] as const;
export type AdminIdentityType = (typeof ADMIN_IDENTITIES)[number]['value'];
export const ADMIN_BUSINESS_PERMISSIONS = [
  { id: 'users:read', label: '查询用户', dependencies: [] },
  { id: 'users:write', label: '编辑、启用与禁用用户', dependencies: ['users:read'] },
  { id: 'devices:read', label: '查询设备', dependencies: ['users:read'] },
  { id: 'devices:revoke', label: '撤销设备', dependencies: ['devices:read', 'users:read'] },
  { id: 'audit:read', label: '查询操作日志', dependencies: [] },
  { id: 'status:read', label: '读取系统状态', dependencies: [] },
  { id: 'analytics:read', label: '查看数据统计', dependencies: [] },
  { id: 'fitness:read', label: '查看官方健身内容', dependencies: [] },
  { id: 'fitness:write', label: '编辑官方健身内容与素材', dependencies: ['fitness:read'] },
] as const;
export type AdminPermission =
  | (typeof ADMIN_BUSINESS_PERMISSIONS)[number]['id']
  | 'accounts:manage'
  | 'groups:manage'
  | 'auth:password'
  | 'auth:logout';
export const ADMIN_PAGES = [
  {
    id: 'analytics',
    label: '数据统计',
    path: '/analytics/overview',
    required_permissions: ['analytics:read'],
    assignable: true,
  },
  {
    id: 'fitness_exercises',
    label: '动作库',
    path: '/fitness/exercises',
    required_permissions: ['fitness:read'],
    assignable: true,
  },
  {
    id: 'fitness_templates',
    label: '训练模板',
    path: '/fitness/templates',
    required_permissions: ['fitness:read'],
    assignable: true,
  },
  {
    id: 'fitness_plans',
    label: '训练计划',
    path: '/fitness/plans',
    required_permissions: ['fitness:read'],
    assignable: true,
  },
  {
    id: 'users',
    label: '用户管理',
    path: '/application/users',
    required_permissions: ['users:read'],
    assignable: true,
  },
  {
    id: 'accounts',
    label: '后台用户',
    path: '/system/accounts',
    required_permissions: ['accounts:manage'],
    assignable: false,
  },
  {
    id: 'groups',
    label: '用户组管理',
    path: '/system/groups',
    required_permissions: ['groups:manage'],
    assignable: false,
  },
  {
    id: 'audit',
    label: '操作日志',
    path: '/system/operation-logs',
    required_permissions: ['audit:read'],
    assignable: true,
  },
] as const;
const SELF_PERMISSIONS: AdminPermission[] = ['auth:password', 'auth:logout'];
const SUPER_PERMISSIONS: AdminPermission[] = [
  ...ADMIN_BUSINESS_PERMISSIONS.map((entry) => entry.id),
  'accounts:manage',
  'groups:manage',
  ...SELF_PERMISSIONS,
];
export type AdminAccountWithGroup = AdminAccount & { group: AdminGroup };

/** 身份必须来自受控目录；未知值不按普通身份降级。 */
export function parseAdminIdentity(value: string): AdminIdentityType {
  if (!ADMIN_IDENTITIES.some((entry) => entry.value === value)) {
    throw new ApiError(400, 'ADMIN_IDENTITY_INVALID', '所选身份无效，请刷新后重试');
  }
  return value as AdminIdentityType;
}

/** 校验完整授权集合，拒绝受限节点、重复节点及缺失依赖，不静默补充权限。 */
export function validateGroupAuthorization(permissions: string[], pageIds: string[]): void {
  const selected = new Set(permissions);
  if (
    selected.size !== permissions.length ||
    new Set(pageIds).size !== pageIds.length ||
    permissions.some((permission) => !ADMIN_BUSINESS_PERMISSIONS.some((entry) => entry.id === permission)) ||
    pageIds.some((id) => !ADMIN_PAGES.some((entry) => entry.id === id && entry.assignable))
  ) {
    throw new ApiError(400, 'ADMIN_PERMISSION_INVALID', '包含无效或不可分配的权限及页面');
  }
  for (const entry of ADMIN_BUSINESS_PERMISSIONS) {
    if (selected.has(entry.id) && entry.dependencies.some((dependency) => !selected.has(dependency))) {
      throw new ApiError(400, 'ADMIN_PERMISSION_DEPENDENCY', '请同时选择相关读取权限');
    }
  }
  if (
    ADMIN_PAGES.some(
      (entry) =>
        pageIds.includes(entry.id) && entry.required_permissions.some((permission) => !selected.has(permission)),
    )
  ) {
    throw new ApiError(400, 'ADMIN_PERMISSION_DEPENDENCY', '所选页面缺少必要的读取权限');
  }
}

/** 按身份注册表计算权限，普通身份读取唯一启用组，组名不参与授权。 */
export function resolveAdminAuthorization(account: AdminAccountWithGroup): {
  permissions: AdminPermission[];
  allowedPages: string[];
} {
  const group = account.group;
  if (!account.groupId || !group || group.id !== account.groupId || group.deletedAt !== null) {
    throw new ApiError(403, 'ADMIN_PERMISSION_DENIED', '当前账号的用户组不可用，请联系超级管理员');
  }
  const strategies: Record<AdminIdentityType, () => { permissions: AdminPermission[]; allowedPages: string[] }> = {
    super_admin: () => ({ permissions: [...SUPER_PERMISSIONS], allowedPages: ADMIN_PAGES.map((entry) => entry.id) }),
    standard_user: () => {
      if (!group.isEnabled) return { permissions: [...SELF_PERMISSIONS], allowedPages: [] };
      // 无效存量配置按拒绝处理，不能由数据库中未知字符串获得控制面权限。
      try {
        validateGroupAuthorization(group.permissions, group.pageIds);
      } catch {
        throw new ApiError(403, 'ADMIN_PERMISSION_DENIED', '当前用户组授权配置无效，请联系超级管理员');
      }
      const permissions = [...(group.permissions as AdminPermission[]), ...SELF_PERMISSIONS];
      return {
        permissions,
        allowedPages: ADMIN_PAGES.filter(
          (entry) =>
            entry.assignable &&
            group.pageIds.includes(entry.id) &&
            entry.required_permissions.every((permission) => permissions.includes(permission)),
        ).map((entry) => entry.id),
      };
    },
  };
  if (!Object.hasOwn(strategies, account.identityType))
    throw new ApiError(403, 'ADMIN_PERMISSION_DENIED', '当前账号身份不可用，请联系超级管理员');
  return strategies[account.identityType as AdminIdentityType]();
}
