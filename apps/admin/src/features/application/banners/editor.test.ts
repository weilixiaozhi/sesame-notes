// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BannerEditor } from './editor';

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), upload: vi.fn(), close: vi.fn() }));
vi.mock('../../../api/client', () => ({
  api: { adminBanners: { create: mocks.create, update: mocks.update, upload: mocks.upload, targets: vi.fn() } },
  request: (operation: () => Promise<unknown>) => operation(),
  errorMessage: () => '提交结果未知，请重试核对。',
  reportError: vi.fn(),
  InputError: class extends Error {},
}));
vi.mock('../../../auth/session', () => ({
  queryClient: { invalidateQueries: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ isPending: false, isError: false, data: { items: [] } }),
}));

let renderer: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  renderer = createRoot(container);
  mocks.upload.mockResolvedValue({ image_path: `/api/v1/banners/media/${'a'.repeat(64)}` });
});

afterEach(async () => {
  await act(async () => renderer.unmount());
  container.remove();
  vi.resetAllMocks();
});

it('新增响应丢失后编辑草稿，重试原意图并更新同一 Banner', async () => {
  let created = 0;
  mocks.create.mockImplementation(async (body: unknown, _key: string) => {
    if (created === 0) {
      created++;
      throw new TypeError('服务器已创建，响应丢失');
    }
    return { id: 'original-banner', version: 1, ...(body as object) };
  });
  mocks.update.mockImplementation(async (_id: string, body: unknown) => ({ version: 2, ...(body as object) }));
  await act(async () =>
    renderer.render(createElement(BannerEditor, { initialSlot: 'fitness-plan-library', onClose: mocks.close })),
  );
  const file = new File(['png'], 'banner.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
  const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(picker, 'files', { value: [file] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
  const form = document.querySelector('[role="dialog"] form')!;
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('提交结果未知');
  const sort = document.querySelector('input[type="number"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(sort, '5');
    sort.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.create.mock.calls[1]).toEqual(mocks.create.mock.calls[0]);
  expect(created).toBe(1);
  expect(mocks.update).toHaveBeenCalledWith('original-banner', expect.objectContaining({ version: 1, sort_order: 5 }));
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
