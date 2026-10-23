import { beforeEach, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderMemoPng, downloadBlob } from './memo-document';
import { downloadText } from '../../lib/transfer/download';
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
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:fake-local'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
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

it('下载触发异常也清理链接与临时URL', () => {
  vi.useFakeTimers();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
    throw new Error('blocked');
  });
  try {
    expect(() => downloadBlob(new Blob(['private']), 'safe.txt')).toThrow('blocked');
    expect(() => downloadText('private', 'safe.txt', 'text/plain')).toThrow('blocked');
    expect(document.querySelector('a[download]')).toBeNull();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  } finally {
    click.mockRestore();
    vi.useRealTimers();
  }
});
