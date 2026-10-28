import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { memoDocumentNode, memoDocx, memoMarkdown, memoParagraphs } from './memo-document';
import type { MemoEntry } from './memo-content';

const entry: MemoEntry = {
  id: 'entry',
  memo_book_id: 'book',
  book_type: 'normal',
  sync_id: 'sync',
  revision: 1,
  deleted_at: null,
  title: '中文标题 <script>bad()</script>',
  body_format: 'delta_v1',
  body: {
    ops: [
      { insert: '中文加粗', attributes: { bold: true } },
      { insert: '\n', attributes: { header: 2 } },
      { insert: '第一项' },
      { insert: '\n', attributes: { list: 'ordered' } },
      { insert: '第二项' },
      { insert: '\n', attributes: { list: 'ordered' } },
      { insert: '已完成' },
      { insert: '\n', attributes: { list: 'checked', indent: 1 } },
    ],
  },
  order_key: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  book_updated_at: '2026-01-01T00:00:00.000Z',
};

/** 从生成的真实 ZIP 中读取指定文档段，兼容压缩或未压缩的条目。 */
function unzipText(bytes: Uint8Array, name: string): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const fileName = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    if (fileName !== name) continue;
    const start = view.getUint32(offset + 42, true);
    const contentStart = start + 30 + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
    const content = bytes.slice(contentStart, contentStart + size);
    return new TextDecoder().decode(view.getUint16(offset + 10, true) === 8 ? inflateRawSync(content) : content);
  }
  throw new Error(`ZIP缺少 ${name}`);
}

/** jsdom Blob 通过 FileReader 读取，测试检查实际生成的二进制产物。 */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}

describe('备忘录文档导出', () => {
  it('列表编号连续，Markdown保留标题、粗体与清单', () => {
    expect(
      memoParagraphs(entry)
        .filter((paragraph) => paragraph.list === 'ordered')
        .map((paragraph) => paragraph.ordinal),
    ).toEqual([1, 2]);
    const markdown = memoMarkdown(entry);
    expect(markdown).toContain('## **中文加粗**');
    expect(markdown).toContain('1. 第一项');
    expect(markdown).toContain('2. 第二项');
    expect(markdown).toContain('  - [x] 已完成');
  });
  it('HTML文字仅按文本显示，标题不能注入脚本', () => {
    const node = memoDocumentNode(document, entry);
    expect(node.querySelector('script')).toBeNull();
    expect(node.querySelector('h1')?.textContent).toBe(entry.title);
    expect(node.querySelector('strong')?.textContent).toBe('中文加粗');
    expect(node.textContent).toContain('2. 第二项');
  });
  it('Word二进制保留中文和富文本语义', async () => {
    const bytes = await blobBytes(await memoDocx(entry));
    expect(bytes.slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    const xml = unzipText(bytes, 'word/document.xml');
    expect(xml).toContain('中文加粗');

    expect(xml).toContain('<w:b');
    expect(xml).toContain('Heading2');
    expect(xml).toContain('2. ');
    expect(xml).not.toContain('<script>');
  });
});
