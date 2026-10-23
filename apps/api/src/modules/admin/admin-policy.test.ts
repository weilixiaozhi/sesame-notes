import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADMIN_GROUP_ID,
  parseAdminIdentity,
  resolveAdminAuthorization,
  validateGroupAuthorization,
  type AdminAccountWithGroup,
} from './admin-policy.js';
import { adminPagination, assertAdminVersion } from './admin-management.js';
import { adminAuthorizationVersion } from './admin-security.js';

/** 只构造授权决策需要的领域状态，测试不连接数据库。 */
function account(identityType: string, permissions: string[], pageIds: string[], enabled = true) {
  return {
    id: 'account',
    groupId: 'group',
    identityType,
    group: { id: 'group', name: '自定义组', deletedAt: null, isEnabled: enabled, permissions, pageIds },
  } as AdminAccountWithGroup & { group: NonNullable<AdminAccountWithGroup['group']> };
}

describe('后台身份与单组权限策略', () => {
  it('统计只读权限可按组分配，已移除的分类管理权限无法授予', () => {
    expect(() => validateGroupAuthorization(['analytics:manage'], ['analytics'])).toThrow();
    expect(() => validateGroupAuthorization(['analytics:read', 'analytics:manage'], ['analytics'])).toThrow();
    expect(() => validateGroupAuthorization(['analytics:read'], ['analytics'])).not.toThrow();
    expect(
      resolveAdminAuthorization(account('standard_user', ['analytics:read'], ['analytics'])).permissions,
    ).not.toContain('analytics:manage');
    expect(resolveAdminAuthorization(account('super_admin', [], [])).permissions).not.toContain('analytics:manage');
  });
  it.each(['standard_user', 'super_admin', 'unknown'])('缺失组归属的%s身份默认拒绝授权', (identityType) => {
    const invalid = {
      ...account(identityType, [], []),
      groupId: null,
      group: null,
    } as unknown as AdminAccountWithGroup;
    expect(() => resolveAdminAuthorization(invalid)).toThrow();
  });

  it.each(['missing', 'deleted', 'mismatched'] as const)('有归属但关联组 %s 时默认拒绝，包括超管', (state) => {
    const source = account('super_admin', [], []);
    const entry = {
      ...source,
      group:
        state === 'missing'
          ? null
          : { ...source.group, ...(state === 'deleted' ? { deletedAt: new Date() } : { id: 'other' }) },
    } as unknown as AdminAccountWithGroup;
    expect(() => resolveAdminAuthorization(entry)).toThrow();
  });
  it('未知身份不降级为普通身份，也不能通过对象原型属性调用策略', () => {
    for (const identity of ['operator', 'auditor', 'toString', '__proto__', 'future']) {
      expect(() => parseAdminIdentity(identity)).toThrow();
      expect(() => resolveAdminAuthorization(account(identity, [], []))).toThrow();
    }
  });
  it('超管拥有控制面并忽略组启停和组页面限制', () => {
    const auth = resolveAdminAuthorization(account('super_admin', [], [], false));
    expect(auth.permissions).toEqual(expect.arrayContaining(['accounts:manage', 'groups:manage', 'devices:read']));
    expect(auth.allowedPages).toEqual([
      'analytics',
      'fitness_exercises',
      'fitness_templates',
      'fitness_plans',
      'users',
      'accounts',
      'groups',
      'audit',
    ]);
    expect(auth.permissions).toEqual(expect.arrayContaining(['analytics:read', 'fitness:read', 'fitness:write']));
    expect(auth.permissions).not.toContain('fitness:publish');
  });
  it('普通身份可按组获得统计与健身页面，不获得后台账号控制能力', () => {
    const auth = resolveAdminAuthorization(
      account(
        'standard_user',
        ['analytics:read', 'fitness:read', 'fitness:write'],
        ['analytics', 'fitness_exercises', 'fitness_templates'],
      ),
    );
    expect(auth.allowedPages).toEqual(['analytics', 'fitness_exercises', 'fitness_templates']);
    expect(auth.permissions).toContain('fitness:write');
    expect(auth.permissions).not.toContain('accounts:manage');
  });
  it('普通账号只拥有唯一组权限，页面授予与API动作权限分别计算', () => {
    const auth = resolveAdminAuthorization(account('standard_user', ['users:read'], []));
    expect(auth.permissions).toContain('users:read');
    expect(auth.permissions).not.toContain('accounts:manage');
    expect(auth.allowedPages).toEqual([]);
  });
  it('停用组仅保留本人操作', () => {
    const auth = resolveAdminAuthorization(account('standard_user', ['users:read'], ['users'], false));
    expect(auth).toEqual({ permissions: ['auth:password', 'auth:logout'], allowedPages: [] });
  });
  it.each(
    [['accounts:manage'], ['groups:manage'], ['fitness:publish'], ['unknown'], ['users:read', 'users:read']].map(
      (permissions) => ({
        permissions,
      }),
    ),
  )('拒绝受限、未知或重复权限 $permissions', ({ permissions }) => {
    expect(() => validateGroupAuthorization(permissions, [])).toThrow();
  });
  it.each([['accounts'], ['groups'], ['unknown'], ['users', 'users']].map((pages) => ({ pages })))(
    '拒绝不可分配或重复页面 $pages',
    ({ pages }) => {
      expect(() => validateGroupAuthorization(['users:read'], pages)).toThrow();
    },
  );
  it.each(
    [['users:write'], ['devices:read'], ['devices:revoke'], ['users:read', 'devices:revoke']].map((permissions) => ({
      permissions,
    })),
  )('拒绝缺少完整读取链 $permissions', ({ permissions }) => {
    expect(() => validateGroupAuthorization(permissions, [])).toThrow();
  });
  it('组名不参与权限推导，页面依赖不能静默补齐', () => {
    expect(() => validateGroupAuthorization([], ['users'])).toThrow();
    const entry = account('standard_user', [], []);
    entry.group.name = '超级管理员';
    expect(resolveAdminAuthorization(entry).permissions).toEqual(['auth:password', 'auth:logout']);
    expect(() => validateGroupAuthorization(['users:read', 'devices:read', 'devices:revoke'], ['users'])).not.toThrow();
  });
  it('版本冲突拒绝覆盖，空列表和越界列表收敛页码', () => {
    expect(() => assertAdminVersion(2, 1)).toThrow('记录已变化');
    expect(adminPagination(0, 8, 10)).toMatchObject({ page: 1, skip: 0, total: 0 });
    expect(adminPagination(21, 8, 10)).toMatchObject({ page: 3, skip: 20, total: 21 });
  });
});

describe('授权版本只表达有效授权变化', () => {
  it('账号显示名及组名称、说明、排序与资料行版本不改变授权指纹', () => {
    const entry = account('standard_user', ['users:read', 'audit:read'], ['users', 'audit']);
    const before = adminAuthorizationVersion(entry, resolveAdminAuthorization(entry));
    entry.displayName = '更新显示名称';
    entry.version = 9;
    entry.group.name = '更新组名';
    entry.group.description = '更新说明';
    entry.group.sort = 100;
    entry.group.version = 20;
    expect(adminAuthorizationVersion(entry, resolveAdminAuthorization(entry))).toBe(before);
  });

  it('权限与页面集合的存储顺序不改变授权指纹', () => {
    const entry = account('standard_user', ['users:read', 'audit:read'], ['users', 'audit']);
    const before = adminAuthorizationVersion(entry, resolveAdminAuthorization(entry));
    entry.group.permissions.reverse();
    entry.group.pageIds.reverse();
    expect(adminAuthorizationVersion(entry, resolveAdminAuthorization(entry))).toBe(before);
  });

  it.each(['account', 'identity', 'group', 'permissions', 'pages', 'enabled'] as const)(
    '%s 授权语义变化产生新的指纹',
    (field) => {
      const entry = account('standard_user', ['users:read'], ['users']);
      const before = adminAuthorizationVersion(entry, resolveAdminAuthorization(entry));
      if (field === 'account') entry.id = 'another-account';
      if (field === 'identity') entry.identityType = 'super_admin';
      if (field === 'group') {
        entry.groupId = 'another-group';
        entry.group.id = 'another-group';
      }
      if (field === 'permissions') entry.group.permissions.push('users:write');
      if (field === 'pages') entry.group.pageIds = [];
      if (field === 'enabled') entry.group.isEnabled = false;
      expect(adminAuthorizationVersion(entry, resolveAdminAuthorization(entry))).not.toBe(before);
    },
  );

  it('超管指纹不受所属组启停和业务配置影响', () => {
    const entry = account('super_admin', ['users:read'], ['users']);
    const before = adminAuthorizationVersion(entry, resolveAdminAuthorization(entry));
    entry.group.isEnabled = false;
    entry.group.permissions = [];
    entry.group.pageIds = [];
    expect(adminAuthorizationVersion(entry, resolveAdminAuthorization(entry))).toBe(before);
  });

  it('转入默认分组改变授权指纹，默认组名称不决定授权', () => {
    const grouped = account('standard_user', ['users:read'], ['users']);
    const before = adminAuthorizationVersion(grouped, resolveAdminAuthorization(grouped));
    grouped.groupId = DEFAULT_ADMIN_GROUP_ID;
    grouped.group.id = DEFAULT_ADMIN_GROUP_ID;
    grouped.group.name = '自定义默认组名称';
    grouped.group.permissions = [];
    grouped.group.pageIds = [];
    expect(adminAuthorizationVersion(grouped, resolveAdminAuthorization(grouped))).not.toBe(before);
    expect(resolveAdminAuthorization(grouped)).toEqual({
      permissions: ['auth:password', 'auth:logout'],
      allowedPages: [],
    });
  });
});
