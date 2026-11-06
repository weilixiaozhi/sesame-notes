// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@sesame-notes/api-client';
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

/** 打开真实新增表单并完成图片选择，后续提交保留同一个编辑器实例。 */
async function renderNewBanner(): Promise<HTMLFormElement> {
  await act(async () =>
    renderer.render(createElement(BannerEditor, { initialSlot: 'fitness-plan-library', onClose: mocks.close })),
  );
  const file = new File(['png'], 'banner.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
  const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(picker, 'files', { value: [file] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
  return document.querySelector('[role="dialog"] form') as HTMLFormElement;
}

/** 使用原生输入事件修改显示顺序，确保提交读取到实际 React 表单草稿。 */
async function setSort(value: number): Promise<void> {
  const sort = document.querySelector('input[type="number"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(sort, String(value));
    sort.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 提交当前表单并等待请求结果展示到界面。 */
async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

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
  const form = await renderNewBanner();
  await submitForm(form);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('提交结果未知');
  await setSort(5);
  await submitForm(form);
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.create.mock.calls[1]).toEqual(mocks.create.mock.calls[0]);
  expect(created).toBe(1);
  expect(mocks.update).toHaveBeenCalledWith('original-banner', expect.objectContaining({ version: 1, sort_order: 5 }));
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it('创建恢复后更新响应也丢失，改回原排序不能用旧快照关闭表单', async () => {
  let stored: { version: number; sort_order: number } | undefined;
  /** 创建只保存一个实体，重试返回首次成功回执而不是当前实体快照。 */
  mocks.create.mockImplementation(async (body: { sort_order: number }, _key: string) => {
    if (!stored) {
      stored = { version: 1, sort_order: body.sort_order };
      throw new TypeError('创建已提交但响应丢失');
    }
    return { id: 'original-banner', version: 1, ...body };
  });
  /** 模拟真实版本比较，已提交的更新不能再次使用创建回执中的旧版本。 */
  mocks.update.mockImplementation(async (_id: string, body: { version: number; sort_order: number }) => {
    if (!stored || stored.version !== body.version)
      throw new ApiError(409, 'BANNER_VERSION_CONFLICT', '内容已变化，请刷新核对');
    stored = { version: stored.version + 1, sort_order: body.sort_order };
    throw new TypeError('更新已提交但响应丢失');
  });
  const form = await renderNewBanner();
  await submitForm(form);
  await setSort(5);
  await submitForm(form);
  expect(stored).toEqual({ version: 2, sort_order: 5 });
  expect(mocks.close).not.toHaveBeenCalled();
  await setSort(0);
  await submitForm(form);
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.create.mock.calls[1]).toEqual(mocks.create.mock.calls[0]);
  expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(mocks.update.mock.calls[1]).toEqual([
    'original-banner',
    expect.objectContaining({ version: 1, sort_order: 0 }),
  ]);
  expect(stored).toEqual({ version: 2, sort_order: 5 });
  expect(mocks.close).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('提交结果未知');
});
