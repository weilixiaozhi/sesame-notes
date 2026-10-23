// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createLazyPage } from './lazy-page';
import { reportError } from '../api/client';

vi.mock('../api/client', () => ({ reportError: vi.fn(), errorMessage: () => '读取失败' }));

/** 已打开页面的本地草稿用于确认其他页面失败和重试不造成全局重挂。 */
function ExistingPage() {
  const [value, setValue] = useState('已打开的内容');
  return createElement('input', {
    value,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
  });
}

/** 资源重试成功后加载的页面具有与正常模块相同的组件形态。 */
function RecoveredPage() {
  return createElement('p', null, '重试后内容');
}

it('加载失败仅影响自身，重新创建lazy后可以恢复，保留其他页面状态和手动刷新入口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new TypeError('Failed to fetch dynamically imported module');
  const load = vi
    .fn<() => Promise<{ default: typeof RecoveredPage }>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue({ default: RecoveredPage });
  const Page = createLazyPage(load, '测试页面');
  expect(load).not.toHaveBeenCalled();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement('div', null, createElement(ExistingPage), createElement(Page)));
    });
    expect(container.textContent).toContain('测试页面暂时无法打开');
    expect(container.textContent).toContain('刷新页面');
    expect(reportError).toHaveBeenCalledWith('load-or-render-admin-page:测试页面', failure);
    const input = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '其他页未保存的草稿');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === '重试加载')!;
    await act(async () => {
      retry.click();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('重试后内容');
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('其他页未保存的草稿');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
