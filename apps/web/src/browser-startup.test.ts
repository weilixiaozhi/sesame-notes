import { afterEach, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({ render: vi.fn(), businessLoaded: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: startup.render }) }));
vi.mock('./bootstrap', () => {
  startup.businessLoaded();
  return { Application: () => null };
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['any', 'timeout'] as const)(
  '仅缺少 AbortSignal.%s 时入口只渲染支持提示，不导入会话和业务模块',
  async (missing) => {
    vi.resetModules();
    document.body.innerHTML = '<div id="root"></div>';
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(), subtle: { digest: vi.fn() } });
    vi.stubGlobal('AbortSignal', {
      any: vi.fn(),
      timeout: vi.fn(),
      prototype: { throwIfAborted: vi.fn() },
      [missing]: undefined,
    });
    await import('./main');
    await vi.dynamicImportSettled();
    expect(startup.render).toHaveBeenCalledTimes(1);
    expect(startup.render.mock.calls[0]?.[0].props.issue).toBe('unsupported-browser');
    expect(startup.businessLoaded).not.toHaveBeenCalled();
  },
);
