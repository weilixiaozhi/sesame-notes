import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import type { components } from '@sesame-notes/api-client';
import { expect, it, vi } from 'vitest';
import { useAccountingFilters } from './ledger-statistics';

vi.mock('../../lib/session', () => ({ api: { GET: vi.fn() } }));

const ledger: components['schemas']['Ledger'] = {
  id: 'ledger',
  sync_id: 'sync',
  name: '日常账本',
  currency: 'CNY',
  month_start_day: 1,
  aa_enabled: false,
  archived_at: null,
  archive_updated_at: null,
  archive_device_id: null,
  role: 'owner',
  member_count: 1,
  updated_at: '2026-10-19T00:00:00.000Z',
};

/** 在真实路由上下文读取筛选与当前地址，验证记账范围和筛选导航。 */
function renderFilters() {
  /** 提供指定查询地址，所有后续筛选由路由正常推进。 */
  function Router({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter
        initialEntries={[
          `/accounting?ledger=${ledger.id}&scope=custom&from=2026-09-01&to=2026-09-30&category=food&currency=USD`,
        ]}
      >
        {children}
      </MemoryRouter>
    );
  }
  return renderHook(() => ({ view: useAccountingFilters(ledger), location: useLocation() }), { wrapper: Router });
}

it('支出查询保留日期、分类与原币范围', () => {
  const { result } = renderFilters();
  expect(result.current.view.error).toBe('');
  expect(result.current.view.filters).toEqual({
    start_at: new Date(2026, 8, 1).toISOString(),
    end_at: new Date(2026, 9, 1).toISOString(),

    category_id: 'food',
    currency_code: 'USD',
  });
});

it('切换分类保留账本、日期和原币范围', () => {
  const { result } = renderFilters();
  act(() => result.current.view.change('category', 'travel'));
  const params = new URLSearchParams(result.current.location.search);
  expect(params.get('ledger')).toBe(ledger.id);
  expect(params.get('from')).toBe('2026-09-01');
  expect(params.get('to')).toBe('2026-09-30');
  expect(params.get('currency')).toBe('USD');
  expect(result.current.view.filters.category_id).toBe('travel');
});
