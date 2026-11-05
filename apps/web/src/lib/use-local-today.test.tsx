import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDateKey } from './local-date';
import { useLocalToday } from './use-local-today';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 5, 23, 59, 50));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('本地今天刷新', () => {
  it('用当地日期初始化，并在跨午夜后的定时轮次刷新', () => {
    const { result, unmount } = renderHook(useLocalToday);
    expect(result.current).toBe('2026-11-05');
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current).toBe('2026-11-06');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('后台或本地时钟变化后在恢复焦点时重读日期', () => {
    const { result } = renderHook(useLocalToday);
    vi.setSystemTime(new Date(2026, 10, 7, 0, 1));
    act(() => window.dispatchEvent(new Event('focus')));
    expect(result.current).toBe('2026-11-07');
  });

  it('销毁后移除同一个焦点回调，后续页面恢复不会保留旧订阅', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(useLocalToday);
    const update = add.mock.calls.find(([name]) => name === 'focus')?.[1];
    expect(update).toBeTypeOf('function');
    unmount();
    expect(remove).toHaveBeenCalledWith('focus', update);
  });

  it('保留日子与月历共用的本地年月日格式，范围由领域校验', () => {
    expect(localDateKey(new Date(1901, 0, 1))).toBe('1901-01-01');
    expect(localDateKey(new Date(2100, 11, 31))).toBe('2100-12-31');
    expect(localDateKey(new Date(2026, 10, 5, 0, 1))).toBe('2026-11-05');
  });
});
