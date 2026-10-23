import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDialogViewport } from './use-dialog-viewport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 创建可独立触发缩放、滚动和断点变化的浏览器可见区域。 */
function browserViewport(mobile = true) {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  const query = Object.assign(new EventTarget(), { matches: mobile });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return { viewport, query };
}

it('跟随手机键盘缩小和页面平移后的实际可见区域', () => {
  const { viewport } = browserViewport();
  const { result } = renderHook(() => useDialogViewport(true));
  expect(result.current).toEqual({ '--dialog-viewport-top': '0px', '--dialog-viewport-height': '844px' });

  act(() => {
    viewport.height = 420;
    viewport.offsetTop = 100;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(result.current).toEqual({ '--dialog-viewport-top': '100px', '--dialog-viewport-height': '420px' });

  act(() => {
    viewport.offsetTop = 160;
    viewport.dispatchEvent(new Event('scroll'));
  });
  expect(result.current?.['--dialog-viewport-top']).toBe('160px');
});

it('桌面弹窗不使用手机尺寸，旋转跨过断点时移除内联尺寸', () => {
  const { query } = browserViewport(false);
  const { result } = renderHook(() => useDialogViewport(true));
  expect(result.current).toBeUndefined();

  act(() => {
    query.matches = true;
    query.dispatchEvent(new Event('change'));
  });
  expect(result.current?.['--dialog-viewport-height']).toBe('844px');

  act(() => {
    query.matches = false;
    query.dispatchEvent(new Event('change'));
  });
  expect(result.current).toBeUndefined();
});

it('嵌套弹窗关闭时只清理自己的监听，父弹窗继续跟随键盘', () => {
  const { viewport } = browserViewport();
  const parent = renderHook(() => useDialogViewport(true));
  const child = renderHook(({ enabled }) => useDialogViewport(enabled), { initialProps: { enabled: true } });
  const removeListener = vi.spyOn(viewport, 'removeEventListener');

  child.rerender({ enabled: false });
  expect(child.result.current).toBeUndefined();
  expect(removeListener).toHaveBeenCalledTimes(2);
  act(() => {
    viewport.height = 440;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(parent.result.current?.['--dialog-viewport-height']).toBe('440px');
});

it('缺少可见区域接口时使用窗口尺寸，无效尺寸保留 CSS 退化布局', () => {
  const { viewport } = browserViewport();
  vi.stubGlobal('visualViewport', null);
  vi.stubGlobal('innerHeight', 640);
  const { result, unmount } = renderHook(() => useDialogViewport(true));
  expect(result.current?.['--dialog-viewport-height']).toBe('640px');
  unmount();

  vi.stubGlobal('visualViewport', viewport);
  viewport.height = 0;
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const invalid = renderHook(() => useDialogViewport(true));
  expect(invalid.result.current).toBeUndefined();
  expect(errorLog).toHaveBeenCalledWith(
    '更新手机弹窗可见区域失败，使用默认布局',
    expect.objectContaining({ height: 0, error: expect.any(Error) }),
  );
});
