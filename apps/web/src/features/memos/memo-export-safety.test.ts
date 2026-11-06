import { beforeEach, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderMemoPng } from './memo-document';
const mocked = vi.hoisted(() => ({ blob: vi.fn(), signal: undefined as AbortSignal | undefined }));

vi.mock('html-to-image', () => ({ toBlob: mocked.blob }));

vi.mock('../../lib/session', () => ({
  captureSessionOperation: () => ({ signal: mocked.signal!, assertCurrent: () => mocked.signal!.throwIfAborted() }),
}));

let controller: AbortController;

beforeEach(() => {
  vi.clearAllMocks();
  controller = new AbortController();
  mocked.signal = controller.signal;
  Object.defineProperty(document, 'fonts', { value: { ready: new Promise(() => {}) }, configurable: true });
});

it('字体等待时取消会同步清除离屏私密DOM并拒绝生成', async () => {
  const node = document.createElement('div');
  node.textContent = 'fake-secret';
  const output = renderMemoPng(node, controller.signal);
  await waitFor(() => expect(node.isConnected).toBe(true));
  const rejection = expect(output).rejects.toThrow();
  controller.abort();
  expect(node.isConnected).toBe(false);
  await rejection;
  expect(mocked.blob).not.toHaveBeenCalled();
});
