import { useEffect } from 'react';
import type { Paging } from './types';

/** 分页边界由真实总数计算，空列表仍位于第 1 页。 */
export function pageBounds(total: number, value: Paging): { count: number; page: number } {
  const count = Math.max(1, Math.ceil(total / value.page_size));
  return { count, page: Math.max(1, Math.min(count, value.page)) };
}

/** 删除末页后退到有效页，保持筛选和每页数量。 */
export function useClampPage(total: number | undefined, value: Paging, onChange: (next: Paging) => void): void {
  useEffect(() => {
    if (total === undefined) return;
    const next = pageBounds(total, value).page;
    if (value.page !== next) onChange({ ...value, page: next });
  }, [total, value, onChange]);
}
