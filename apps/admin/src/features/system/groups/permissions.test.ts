import { describe, expect, it } from 'vitest';
import { changePermissions, permissionLeaves } from './permissions';
import type { PermissionCatalog } from '../../../api/types';

const catalog: PermissionCatalog = {
  permissions: [
    { id: 'users:read', label: '查询用户', dependencies: [] },
    { id: 'users:write', label: '启停用户', dependencies: ['users:read'] },
    { id: 'devices:read', label: '查询设备', dependencies: ['users:read'] },
    { id: 'devices:revoke', label: '撤销设备', dependencies: ['devices:read'] },
    { id: 'audit:read', label: '查询日志', dependencies: [] },
    { id: 'status:read', label: '读取系统状态', dependencies: [] },
    { id: 'accounts:manage', label: '账号维护', dependencies: [] },
  ],
  pages: [
    {
      id: 'users',
      label: '用户管理',
      path: '/application/users',
      required_permissions: ['users:read'],
      assignable: true,
    },
    {
      id: 'audit',
      label: '操作日志',
      path: '/system/operation-logs',
      required_permissions: ['audit:read'],
      assignable: true,
    },
    {
      id: 'accounts',
      label: '后台用户',
      path: '/system/accounts',
      required_permissions: ['accounts:manage'],
      assignable: false,
    },
  ],
  identities: [
    { value: 'super_admin', label: '超级管理员' },
    { value: 'standard_user', label: '普通用户' },
  ],
};

describe('用户组权限与页面授权', () => {
  it('设备撤销补齐完整查询依赖，但不会自动授予页面访问', () => {
    const result = changePermissions({ permissions: [], page_ids: [] }, ['permission:devices:revoke'], true, catalog);
    expect(result.permissions.sort()).toEqual(['devices:read', 'devices:revoke', 'users:read']);
    expect(result.page_ids).toEqual([]);
  });
  it('取消用户读取撤销依赖链和页面，保留独立日志权限', () => {
    const all = changePermissions({ permissions: [], page_ids: [] }, permissionLeaves(catalog), true, catalog);
    const result = changePermissions(all, ['permission:users:read'], false, catalog);
    expect(result.permissions.sort()).toEqual(['audit:read', 'status:read']);
    expect(result.page_ids).toEqual(['audit']);
  });
  it('拒绝伪造的控制面权限叶子', () => {
    expect(() =>
      changePermissions({ permissions: [], page_ids: [] }, ['permission:accounts:manage'], true, catalog),
    ).toThrow();
  });
});
