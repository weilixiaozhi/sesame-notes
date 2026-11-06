import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
