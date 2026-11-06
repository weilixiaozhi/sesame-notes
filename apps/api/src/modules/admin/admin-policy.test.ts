import { describe, expect, it } from 'vitest';
import {
  parseAdminIdentity,
  resolveAdminAuthorization,
  validateGroupAuthorization,
  type AdminAccountWithGroup,
} from './admin-policy.js';
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
  it.each(['super_admin'])('缺失组归属的%s身份默认拒绝授权', (identityType) => {
    const invalid = {
      ...account(identityType, [], []),
      groupId: null,
      group: null,
    } as unknown as AdminAccountWithGroup;
    expect(() => resolveAdminAuthorization(invalid)).toThrow();
  });

  it.each(['deleted', 'mismatched'] as const)('有归属但关联组 %s 时默认拒绝，包括超管', (state) => {
    const source = account('super_admin', [], []);
    const entry = {
      ...source,
      group: { ...source.group, ...(state === 'deleted' ? { deletedAt: new Date() } : { id: 'other' }) },
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
      'banners',
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
  it('普通组的 Banner 页面和写入权限均要求 Banner 读取权限', () => {
    try {
      expect(() => validateGroupAuthorization([], ['banners'])).toThrow('必要的读取权限');
      expect(() => validateGroupAuthorization(['banners:write'], [])).toThrow('相关读取权限');
      expect(() => validateGroupAuthorization(['fitness:read', 'fitness:write'], ['banners'])).toThrow();
      const reader = resolveAdminAuthorization(account('standard_user', ['banners:read'], ['banners']));
      expect(reader.allowedPages).toEqual(['banners']);
      expect(reader.permissions).toContain('banners:read');
      expect(reader.permissions).not.toContain('banners:write');
      const writer = resolveAdminAuthorization(
        account('standard_user', ['banners:read', 'banners:write'], ['banners']),
      );
      expect(writer.allowedPages).toEqual(['banners']);
      expect(writer.permissions).toContain('banners:write');
      expect(writer.permissions).not.toContain('fitness:write');
      expect(writer.permissions).not.toContain('accounts:manage');
    } catch (cause) {
      throw new Error('Banner 普通组权限依赖验证失败', { cause });
    }
  });
  it.each(
    [['accounts:manage'], ['unknown'], ['users:read', 'users:read']].map((permissions) => ({
      permissions,
    })),
  )('拒绝受限、未知或重复权限 $permissions', ({ permissions }) => {
    expect(() => validateGroupAuthorization(permissions, [])).toThrow();
  });
  it.each([['accounts'], ['users', 'users']].map((pages) => ({ pages })))(
    '拒绝不可分配或重复页面 $pages',
    ({ pages }) => {
      expect(() => validateGroupAuthorization(['users:read'], pages)).toThrow();
    },
  );
  it.each(
    [['devices:revoke']].map((permissions) => ({
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
});
