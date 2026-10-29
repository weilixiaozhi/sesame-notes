import type { PermissionCatalog } from '../../../api/types';

export type PermissionSelection = { permissions: string[]; page_ids: string[] };
export const businessPages = {
  banners: 'Banner 管理',
  users: '用户管理',
  audit: '操作日志',
  analytics: '统计页面',
  fitness_exercises: '动作库',
  fitness_templates: '训练模板',
  fitness_plans: '训练计划',
} as const;
export const permissionDirectories = [
  { id: 'statistics', label: '数据统计', pages: ['analytics'] },
  { id: 'application', label: '应用管理', pages: ['users', 'banners'] },
  { id: 'fitness', label: '健身管理', pages: ['fitness_exercises', 'fitness_templates', 'fitness_plans'] },
  { id: 'system', label: '系统管理', pages: ['audit'] },
] as const;
const businessPermissions = [
  'banners:read',
  'banners:write',
  'users:read',
  'users:write',
  'devices:read',
  'devices:revoke',
  'audit:read',
  'status:read',
  'analytics:read',
  'fitness:read',
  'fitness:write',
];

/** 权限树只分配注册业务能力，账号控制权限不进入普通组。 */
export function permittedCatalog(catalog: PermissionCatalog) {
  return {
    permissions: catalog.permissions.filter((permission) => businessPermissions.includes(permission.id)),
    pages: catalog.pages.filter((page) => page.assignable && Object.hasOwn(businessPages, page.id)),
  };
}

/** 页面及目录对应的真实叶子用于全选和半选。 */
export function permissionLeaves(catalog: PermissionCatalog, scope = 'all'): string[] {
  const available = permittedCatalog(catalog);
  const leaves = available.pages
    .filter(
      (page) =>
        scope === 'all' ||
        scope === page.id ||
        (scope === 'application' && (page.id === 'users' || page.id === 'banners')) ||
        (scope === 'statistics' && page.id === 'analytics') ||
        (scope === 'fitness' && page.id.startsWith('fitness_')) ||
        (scope === 'system' && page.id === 'audit'),
    )
    .flatMap((page) => [
      `page:${page.id}`,
      ...available.permissions
        .filter((permission) =>
          page.id === 'users'
            ? permission.id.startsWith('users:') || permission.id.startsWith('devices:')
            : page.id === 'banners'
              ? permission.id.startsWith('banners:')
              : page.id === 'audit'
                ? permission.id === 'audit:read'
                : page.id === 'analytics'
                  ? permission.id === 'analytics:read'
                  : false,
        )
        .map((permission) => `permission:${permission.id}`),
    ]);
  // 系统状态读取没有对应页面，仍作为独立 API 权限明确展示和撤销。
  if (
    (scope === 'all' || scope === 'system') &&
    available.permissions.some((permission) => permission.id === 'status:read')
  )
    leaves.push('permission:status:read');
  if (scope === 'all' || scope === 'fitness')
    leaves.push(
      ...available.permissions
        .filter((permission) => permission.id.startsWith('fitness:'))
        .map((permission) => `permission:${permission.id}`),
    );
  return leaves;
}

/** 页面与操作分开存储，勾选补依赖，撤销查询删除依赖链和失效页面。 */
export function changePermissions(
  current: PermissionSelection,
  keys: string[],
  enabled: boolean,
  catalog: PermissionCatalog,
): PermissionSelection {
  const allowed = new Set(permissionLeaves(catalog));
  if (keys.some((key) => !allowed.has(key))) throw new Error('不可分配的权限节点');
  const permissions = new Set(current.permissions);
  const pages = new Set(current.page_ids);
  const available = permittedCatalog(catalog);
  for (const key of keys) {
    if (key.startsWith('page:')) {
      const pageId = key.slice(5);
      if (enabled) {
        pages.add(pageId);
        available.pages
          .find((page) => page.id === pageId)
          ?.required_permissions.forEach((permission) => permissions.add(permission));
      } else pages.delete(pageId);
    } else if (enabled) permissions.add(key.slice(11));
    else permissions.delete(key.slice(11));
  }
  // 依赖闭包在界面可见，保存阶段不会静默增加授权。
  let changed: boolean;
  do {
    changed = false;
    for (const permission of available.permissions) {
      if (!permissions.has(permission.id)) continue;
      for (const dependency of permission.dependencies) {
        if (permissions.has(dependency)) continue;
        if (enabled) permissions.add(dependency);
        else permissions.delete(permission.id);
        changed = true;
      }
    }
  } while (changed);
  for (const pageId of pages) {
    const page = available.pages.find((item) => item.id === pageId);
    if (!page || !page.required_permissions.every((permission) => permissions.has(permission))) pages.delete(pageId);
  }
  return { permissions: [...permissions], page_ids: [...pages] };
}

/** 仅按可分配叶子计算父项状态，不计入锁定节点。 */
export function selectionState(selection: PermissionSelection, leaves: string[]): 'all' | 'some' | 'none' {
  const selected = new Set([
    ...selection.permissions.map((id) => `permission:${id}`),
    ...selection.page_ids.map((id) => `page:${id}`),
  ]);
  const count = leaves.filter((key) => selected.has(key)).length;
  return count === 0 ? 'none' : count === leaves.length ? 'all' : 'some';
}
