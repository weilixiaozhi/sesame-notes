import { pageInfo } from '../api/types';
import type { PageId } from '../api/types';

/** 路由只匹配注册的业务页面，未知路径不会自动获得页面权限。 */
export function routePage(path: string): PageId | null {
  const pathname = path.split('?')[0]!;
  if (pathname === '/application/users' || /^\/application\/users\/[^/]+$/.test(pathname)) return 'users';
  return (Object.keys(pageInfo) as PageId[]).find((page) => pageInfo[page].path === pathname) || null;
}

/** 将统计页的别名路径规范为当前概览和事件分析入口。 */
export function canonicalPath(path: string): string {
  return path === '/analytics/usage'
    ? '/analytics/overview'
    : path === '/analytics/behavior'
      ? '/analytics/events'
      : path;
}
