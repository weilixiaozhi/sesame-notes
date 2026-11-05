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

it('缺少 AbortSignal.any 时入口只渲染支持提示，不导入会话和业务模块', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crypto', { randomUUID: vi.fn(), subtle: { digest: vi.fn() } });
  vi.stubGlobal('AbortSignal', { prototype: { throwIfAborted: vi.fn() } });
  await import('./main');
  expect(startup.render).toHaveBeenCalledTimes(1);
  expect(startup.render.mock.calls[0]?.[0].props.issue).toBe('unsupported-browser');
  expect(startup.businessLoaded).not.toHaveBeenCalled();
});
