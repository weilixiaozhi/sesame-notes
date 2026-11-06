import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSupportNotice, getBrowserSupportIssue } from './browser-support';

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crypto', { randomUUID: vi.fn(), subtle: { digest: vi.fn() } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Web 入口能力基线', () => {
  it('完整能力允许加载业务，非安全连接优先显示 HTTPS 提示', () => {
    expect(getBrowserSupportIssue()).toBeNull();
    vi.stubGlobal('isSecureContext', false);
    expect(getBrowserSupportIssue()).toBe('insecure-connection');
  });

  it.each(['any', 'timeout'] as const)('仅缺少 AbortSignal.%s 时在登录前给出升级提示', (missing) => {
    vi.stubGlobal('AbortSignal', {
      any: vi.fn(),
      timeout: vi.fn(),
      prototype: { throwIfAborted: vi.fn() },
      [missing]: undefined,
    });
    const issue = getBrowserSupportIssue();
    expect(issue).toBe('unsupported-browser');
    render(<BrowserSupportNotice issue={issue!} />);
    expect(screen.getByRole('heading', { name: '当前浏览器暂不支持' })).toBeTruthy();
    expect(screen.getByText('请更新浏览器后重新打开芝麻记。')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('缺少已使用的取消状态检查时也拒绝加载业务', () => {
    vi.stubGlobal('AbortSignal', { any: vi.fn(), timeout: vi.fn(), prototype: {} });
    expect(getBrowserSupportIssue()).toBe('unsupported-browser');
  });
});
