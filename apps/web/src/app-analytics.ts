import type { ProductAnalyticsPage } from './lib/product-analytics-runtime';

const PAGES: Readonly<Record<string, ProductAnalyticsPage>> = {
  '/': 'home',
  '/accounting': 'accounting',
  '/fitness': 'fitness',
  '/memos': 'memos',
  '/credentials': 'credentials',
  '/days': 'days',
  '/calendar': 'calendar',
  '/settings': 'settings',
};

/** 只保存固定业务页标识；账号、查询条件、标题与实际记录内容均不进入事件正文。 */
export function analyticsPage(pathname: string): ProductAnalyticsPage | undefined {
  return PAGES[pathname];
}
