// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BannersPage } from './index';

const mocks = vi.hoisted(() => ({
  entries: [] as unknown[],
  metrics: [] as unknown[],
  create: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../../auth/session', () => ({
  useSession: () => ({ session: { admin: { permissions: ['banners:read', 'banners:write'] } } }),
  queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../api/client', () => ({
  api: {
    adminBanners: { list: vi.fn(), statistics: vi.fn(), targets: vi.fn(), create: mocks.create, remove: mocks.remove },
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
            scope: 'total',
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
  mocks.entries = ['fitness-plan-library', 'fitness-template-library'].map((slot, index) => ({
    id: index ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111',
    slot,
    source: 'remote',
    version: 1,
    target: slot,
    target_id: null,
    target_name: null,
    image_path: `/api/v1/banners/media/${'a'.repeat(64)}`,
    sort_order: 0,
    updated_at: '2026-10-29T00:00:00.000Z',
    updated_by: null,
  }));
  mocks.metrics = mocks.entries.map((entry) => {
    const value = entry as { id: string; slot: string };
    return {
      banner_id: value.id,
      slot: value.slot,
      source: 'remote',
      version: 1,
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
    expect(host.textContent).not.toMatch(
      /投放时间|上线|下线|启用|停用|恢复默认|查找|查询|重置|开始采集|已登录 App 用户|内置默认|自定义|统计范围/,
    );
    expect(host.querySelector('.page-heading select')).toBeNull();
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === '预览')).toBe(false);
  });
  it('添加图片时可按名称选择具体官方模板，没有投放状态开关', async () => {
    await act(async () => root.render(createElement(BannersPage, { active: true })));
    const add = [...host.querySelectorAll('button')].find((button) => button.textContent === '添加 Banner')!;
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
    expect(dialog.textContent).toContain('添加 Banner');
    expect(dialog.textContent).not.toContain('查找');
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
    expect(dialog.querySelector('input[type="datetime-local"]')).toBeNull();
  });
  it('点击缩略图只打开图片，不重复显示位置和跳转信息', async () => {
    await act(async () => root.render(createElement(BannersPage, { active: true })));
    await act(async () => (host.querySelector('.banner-thumbnail') as HTMLButtonElement).click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll('img')).toHaveLength(1);
    expect(dialog.querySelector('p')).toBeNull();
    expect(dialog.textContent).not.toMatch(/点击进入|计划页|计划库/);
  });
  it('删除最后一条后列表为空，不生成不可删除的默认记录', async () => {
    mocks.entries = mocks.entries.slice(0, 1);
    mocks.remove.mockImplementation(async () => {
      mocks.entries = [];
      return { ok: true };
    });
    await act(async () => root.render(createElement(BannersPage, { active: true })));
    const remove = [...host.querySelectorAll('button')].find((button) => button.textContent === '删除')!;
    await act(async () => remove.click());
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
      (button) => button.textContent === '确认删除',
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(mocks.remove).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', { version: 1 });
    expect(host.querySelectorAll('thead th')).toHaveLength(9);
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(host.querySelector('tbody td')?.getAttribute('colspan')).toBe('9');
    expect(host.querySelectorAll('.banner-thumbnail')).toHaveLength(0);
    expect(host.textContent).toContain('暂无数据');
    expect(host.textContent).toMatch(/共\s*0\s*条/);
    expect(host.textContent).not.toContain('内置默认');
  });
});
