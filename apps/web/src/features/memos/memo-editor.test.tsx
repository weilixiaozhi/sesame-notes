import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Quill from 'quill';
import { MemoEditor } from './memo-editor';

const imageId = '9f8e7d6c-5b4a-4392-8171-60514f3e2d1c';

vi.mock('./memo-media', () => ({
  uploadMemoImage: vi.fn(),
  loadMemoImage: vi.fn(async () => null),
}));

describe('备忘录编辑器图片', () => {
  it('注册图片 blot 并能创建与读取媒体标识', () => {
    const Blot = Quill.import('formats/memo_image') as {
      blotName: string;
      create: (value: string) => Node;
      value: (node: Node) => string;
    };
    expect(Blot.blotName).toBe('memo_image');
    const node = Blot.create(imageId);
    expect(Blot.value(node)).toBe(imageId);
    // 带显示比例的引用必须原样回写，比例只影响展示宽度。
    const resized = Blot.create(`${imageId}|50`);
    expect(Blot.value(resized)).toBe(`${imageId}|50`);
  });

  it('载入图片 op 后渲染占位，加载失败显示不可用', async () => {
    render(
      <MemoEditor
        initial={{ ops: [{ insert: '看图\n' }, { insert: { memo_image: imageId } }, { insert: '\n' }] }}
        onChange={() => {}}
        onInvalid={() => {}}
        disabled={false}
      />,
    );
    await waitFor(() => expect(document.querySelector('.memo-image')).not.toBeNull());
    expect(document.querySelector('.memo-image')?.getAttribute('data-media-id')).toBe(imageId);
    await waitFor(() => expect(document.querySelector('.memo-image')?.textContent).toContain('图片不可用'));
  });

  it('禁用状态不显示插入图片入口', () => {
    const { rerender } = render(
      <MemoEditor initial={{ ops: [{ insert: '\n' }] }} onChange={() => {}} onInvalid={() => {}} disabled={false} />,
    );
    expect(screen.getByRole('button', { name: '插入图片' })).toBeTruthy();
    rerender(<MemoEditor initial={{ ops: [{ insert: '\n' }] }} onChange={() => {}} onInvalid={() => {}} disabled />);
    expect(screen.queryByRole('button', { name: '插入图片' })).toBeNull();
  });
});
