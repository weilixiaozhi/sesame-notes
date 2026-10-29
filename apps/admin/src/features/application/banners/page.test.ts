// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BannersPage } from './index';
import { builtinBanner } from './model';

const mocks = vi.hoisted(() => ({
  entries: [] as unknown[],
  metrics: [] as unknown[],
  create: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('../../../auth/session', () => ({
  useSession: () => ({ session: { admin: { permissions: ['banners:read', 'banners:write'] } } }),
  queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../api/client', () => ({
  api: {
    adminBanners: { list: vi.fn(), statistics: vi.fn(), targets: vi.fn(), create: mocks.create, reset: mocks.reset },
  },
  request: (operation: () => Promise<unknown>) => operation(),
  reportError: vi.fn(),
  errorMessage: () => '操作失败',
  InputError: class extends Error {},
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    data: queryKey.includes('banner-targets')
      ? {
          items: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              name: { zh: '三分化·胸三头', zh_hant: '三分化·胸三頭', en: 'Push day' },
            },
          ],
        }
      : queryKey.includes('banner-statistics')
        ? {
            items: mocks.metrics,
            scope: 'current',
            range: { start_date: '2026-10-29', end_date: '2026-10-29', timezone: 'Asia/Shanghai' },
            coverage: {
              complete: true,
              collection_started_at: '2026-10-28T00:00:00.000Z',
              audience: 'authenticated_users',
            },
          }
        : { items: mocks.entries },
  }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  mocks.entries = [builtinBanner('fitness-plan-library'), builtinBanner('fitness-template-library')];
  mocks.metrics = mocks.entries.map((entry) => {
    const value = entry as { id: string; slot: string };
    return {
      banner_id: value.id,
      slot: value.slot,
      source: 'builtin',
      version: 0,
      impressions: 5,
      clicks: 1,
      ctr: 0.2,
    };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('Banner 管理列表交互', () => {
  it('以表格和缩略图呈现入口及真实指标，不出现投放或上下线字段', async () => {
    await act(async () => root.render(createElement(BannersPage, { active: true })));
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(host.querySelectorAll('.banner-thumbnail')).toHaveLength(2);
    expect(host.querySelector('.banner-preview')).toBeNull();
    expect(host.textContent).toContain('20%');
    expect(host.textContent).toContain('曝光次数');
    expect(host.textContent).not.toMatch(/投放时间|上线|下线|启用|停用/);
  });
  it('添加图片时可按名称选择具体官方模板，没有投放状态开关', async () => {
    await act(async () => root.render(createElement(BannersPage, { active: true })));
    const add = [...host.querySelectorAll('button')].find((button) => button.textContent === '添加图片')!;
    await act(async () => add.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    const target = [...dialog.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'official-template'),
    )!;
    await act(async () => {
      target.value = 'official-template';
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(dialog.textContent).toContain('三分化·胸三头');
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
    expect(dialog.querySelector('input[type="datetime-local"]')).toBeNull();
  });
});
