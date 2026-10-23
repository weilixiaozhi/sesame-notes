import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog } from './ui';

afterEach(() => vi.unstubAllGlobals());

/** 指定弹窗实际使用的移动布局断点，不依赖测试运行器的默认窗口宽度。 */
function setMobileViewport(mobile: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => Object.assign(new EventTarget(), { matches: mobile })),
  );
}

it('手机全屏打开时聚焦弹层，输入框等待用户点击', async () => {
  setMobileViewport(true);
  render(
    <Dialog open mobileFullscreen title="手机记账" onClose={() => undefined}>
      <input aria-label="支出金额" />
    </Dialog>,
  );
  const dialog = screen.getByRole('dialog', { name: '手机记账' });
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  expect(dialog.classList.contains('dialog-mobile-fullscreen')).toBe(true);
});

it('桌面全屏选项保留默认焦点行为，调用方可显式关闭自动聚焦', async () => {
  setMobileViewport(false);
  const { rerender } = render(
    <Dialog open mobileFullscreen title="桌面记账" onClose={() => undefined}>
      <input aria-label="支出金额" />
    </Dialog>,
  );
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭弹窗' })));
  rerender(
    <Dialog open={false} title="选择分类" onClose={() => undefined}>
      <input aria-label="搜索分类" />
    </Dialog>,
  );
  rerender(
    <Dialog open autoFocus={false} title="选择分类" onClose={() => undefined}>
      <input aria-label="搜索分类" />
    </Dialog>,
  );
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '选择分类' })));
});
