import { describe, expect, it } from 'vitest';
import { changePermissions, permissionLeaves, selectionState } from './permissions';
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
  it('健身页面分别授权，共用操作权限只在目录中出现一次', () => {
    const extended: PermissionCatalog = {
      ...catalog,
      permissions: [
        ...catalog.permissions,
        { id: 'analytics:read', label: '统计', dependencies: [] },
        { id: 'fitness:read', label: '读取健身内容', dependencies: [] },
        { id: 'fitness:write', label: '编辑健身内容', dependencies: ['fitness:read'] },
      ],
      pages: [
        ...catalog.pages,
        {
          id: 'analytics',
          label: '数据概览',
          path: '/analytics/overview',
          required_permissions: ['analytics:read'],
          assignable: true,
        },
        ...['exercises', 'templates', 'plans'].map((id) => ({
          id: `fitness_${id}`,
          label: id,
          path: `/fitness/${id}`,
          required_permissions: ['fitness:read'],
          assignable: true,
        })),
      ],
    };
    const leaves = permissionLeaves(extended, 'fitness');
    expect(leaves.filter((key) => key === 'permission:fitness:read')).toHaveLength(1);
    const granted = changePermissions({ permissions: [], page_ids: [] }, permissionLeaves(extended), true, extended);
    const onePageRemoved = changePermissions(granted, ['page:fitness_exercises'], false, extended);
    expect(onePageRemoved.page_ids).toContain('fitness_templates');
    expect(onePageRemoved.permissions).toContain('fitness:write');
    const revoked = changePermissions(onePageRemoved, ['permission:fitness:read'], false, extended);
    expect(revoked.page_ids).not.toContain('fitness_templates');
    expect(revoked.page_ids).not.toContain('fitness_plans');
    expect(revoked.permissions).not.toContain('fitness:write');
    expect(revoked.permissions).toContain('analytics:read');
    expect(revoked.page_ids).toContain('analytics');
  });
  it('设备撤销补齐完整查询依赖，但不会自动授予页面访问', () => {
    const result = changePermissions({ permissions: [], page_ids: [] }, ['permission:devices:revoke'], true, catalog);
    expect(result.permissions.sort()).toEqual(['devices:read', 'devices:revoke', 'users:read']);
    expect(result.page_ids).toEqual([]);
  });
  it('页面访问补齐读取权限，全选排除后台控制节点', () => {
    const result = changePermissions({ permissions: [], page_ids: [] }, permissionLeaves(catalog), true, catalog);
    expect(result.page_ids.sort()).toEqual(['audit', 'users']);
    expect(result.permissions).not.toContain('accounts:manage');
    expect(selectionState(result, permissionLeaves(catalog))).toBe('all');
  });
  it('取消用户读取撤销依赖链和页面，保留独立日志权限', () => {
    const all = changePermissions({ permissions: [], page_ids: [] }, permissionLeaves(catalog), true, catalog);
    const result = changePermissions(all, ['permission:users:read'], false, catalog);
    expect(result.permissions.sort()).toEqual(['audit:read', 'status:read']);
    expect(result.page_ids).toEqual(['audit']);
    expect(selectionState(result, permissionLeaves(catalog))).toBe('some');
  });
  it('拒绝伪造的控制面权限叶子', () => {
    expect(() =>
      changePermissions({ permissions: [], page_ids: [] }, ['permission:accounts:manage'], true, catalog),
    ).toThrow();
  });
  it('迁移保留的系统状态权限可见且可撤销，不引入页面', () => {
    expect(permissionLeaves(catalog, 'system')).toContain('permission:status:read');
    const current = { permissions: ['status:read'], page_ids: [] };
    expect(selectionState(current, ['permission:status:read'])).toBe('all');
    expect(changePermissions(current, ['permission:status:read'], false, catalog)).toEqual({
      permissions: [],
      page_ids: [],
    });
  });
});
