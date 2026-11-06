import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@sesame-notes/api-client';
import { queryClient } from '../../lib/session';
import { useDefaultCategoryInitialization } from './default-category-initialization';

const mocks = vi.hoisted(() => ({ post: vi.fn(), capture: vi.fn(), sessionAbort: new AbortController() }));
vi.mock('../../lib/session', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
    captureSessionOperation: mocks.capture,
  };
});
const ledger: components['schemas']['Ledger'] = {
  id: 'ledger',
  sync_id: 'sync',
  name: '既有空账本',
  currency: 'CNY',
  month_start_day: 1,
  aa_enabled: false,
  archived_at: null,
  archive_updated_at: null,
  archive_device_id: null,
  role: 'owner',
  member_count: 1,
  updated_at: '2026-10-01T00:00:00.000Z',
};
const categoryKey = ['account', 'owner', 'accounting', ledger.id, 'categories'];
const otherLedgerKey = ['account', 'owner', 'accounting', 'another-ledger', 'categories'];
const otherAccountKey = ['account', 'other-account', 'accounting', ledger.id, 'categories'];
const completedKey = ['account', 'owner', 'accounting', 'default-categories-initialized'];
const category: components['schemas']['Category'] = {
  id: 'ffec6471-df8b-5bb3-8a05-93ef863ca958',
  name: '餐饮',
  kind: 'expense',
  level: 1,
  parent_id: null,
  icon: 'utensils',
  sort_order: 0,
  deleted_at: null,
  version_token: 'test-category-version',
  updated_at: '1970-01-01T00:00:00.000Z',
};

beforeEach(() => {
  queryClient.clear();
  vi.clearAllMocks();
  mocks.sessionAbort = new AbortController();
  mocks.capture.mockImplementation(() => {
    const signal = mocks.sessionAbort.signal;
    return { client: { POST: mocks.post }, signal, assertCurrent: () => signal.throwIfAborted() };
  });
  mocks.post.mockResolvedValue({ data: [category] });
  for (const key of [categoryKey, otherLedgerKey, otherAccountKey]) queryClient.setQueryData(key, []);
});
afterEach(() => vi.restoreAllMocks());

describe('既有空账本默认分类初始化', () => {
  it('服务端墓碑目录返回空也视为已检查，刷新及重新进入不循环补种', async () => {
    mocks.post.mockResolvedValue({ data: [] });
    const first = renderHook(({ empty }) => useDefaultCategoryInitialization(ledger, 'owner', empty), {
      initialProps: { empty: true },
    });
    await waitFor(() => expect(queryClient.getQueryData(completedKey)).toBe(true));
    first.rerender({ empty: false });
    first.rerender({ empty: true });
    await act(async () => {});
    first.unmount();
    renderHook(() => useDefaultCategoryInitialization({ ...ledger, id: 'another-ledger' }, 'owner', true));
    await act(async () => {});
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('失败保留可重试状态，未知响应重试固定幂等键和请求体，连续点击只发一次', async () => {
    mocks.post.mockRejectedValueOnce(new TypeError('response lost'));
    let resolve!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = renderHook(() => useDefaultCategoryInitialization(ledger, 'owner', true));
    await waitFor(() => expect(result.current.error).toBeInstanceOf(TypeError));
    expect(queryClient.getQueryData(completedKey)).toBeUndefined();
    act(() => {
      result.current.retry();
      result.current.retry();
    });
    expect(result.current.isPending).toBe(true);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[1]?.[1]?.params).toEqual(mocks.post.mock.calls[0]?.[1]?.params);
    expect(mocks.post.mock.calls[1]?.[1]?.body).toEqual(mocks.post.mock.calls[0]?.[1]?.body);
    await act(async () => resolve({ data: [category] }));
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.error).toBeNull();
    expect(queryClient.getQueryData(completedKey)).toBe(true);
  });

  it('换号在组件卸载前已取消，旧响应不会给新账号留下数据或错误', async () => {
    let resolve!: (value: unknown) => void;
    mocks.post.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = renderHook(() => useDefaultCategoryInitialization(ledger, 'owner', true));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    const signal = mocks.post.mock.calls[0]?.[1]?.signal as AbortSignal;
    await act(async () => {
      mocks.sessionAbort.abort();
      resolve({ data: [category] });
    });
    expect(signal.aborted).toBe(true);
    expect(queryClient.getQueryData(completedKey)).toBeUndefined();
    expect(queryClient.getQueryState(categoryKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(otherAccountKey)?.isInvalidated).toBe(false);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.isPending).toBe(false);
  });
});
