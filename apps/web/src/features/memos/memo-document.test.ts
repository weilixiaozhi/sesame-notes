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

const imageId = '9f8e7d6c-5b4a-4392-8171-60514f3e2d1c';
/** 1×1 PNG，用于验证图片字节确实写入 Word 文档。 */
const onePixelPng = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (character) => character.charCodeAt(0),
);
const imageEntry: MemoEntry = {
  ...entry,
  title: '图片记录',
  body: {
    ops: [{ insert: '看图\n' }, { insert: { memo_image: imageId } }, { insert: '\n末尾\n' }],
  },
};

/** 从生成的真实 ZIP 中读取指定条目的原始字节，兼容压缩或未压缩的条目。 */
function unzipEntry(bytes: Uint8Array, name: string): Uint8Array {
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
    return view.getUint16(offset + 10, true) === 8 ? inflateRawSync(content) : content;
  }
  throw new Error(`ZIP缺少 ${name}`);
}

/** 列出 ZIP 中央目录中的文件名，用于确认图片媒体部件已经生成。 */
function zipNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names: string[] = [];
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    names.push(new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength)));
  }
  return names;
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

/** 按图片实际字节生成 Blob，导出流程不访问网络。 */
function imageLoader(bytes: Uint8Array, type = 'image/png') {
  return async () => new Blob([bytes.slice().buffer], { type });
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
    const xml = new TextDecoder().decode(unzipEntry(bytes, 'word/document.xml'));
    expect(xml).toContain('中文加粗');

    expect(xml).toContain('<w:b');
    expect(xml).toContain('Heading2');
    expect(xml).toContain('2. ');
    expect(xml).not.toContain('<script>');
  });
  it('Markdown 用占位文字表示图片且不写入内部标识', () => {
    const markdown = memoMarkdown(imageEntry);
    expect(markdown).toContain('[图片]');
    expect(markdown).not.toContain(imageId);
    expect(markdown).toContain('末尾');
  });
  it('段落模型把图片表示为独立 run，导出 DOM 按地址绘制图片', () => {
    const paragraph = memoParagraphs(imageEntry).find((item) => item.runs.some((run) => run.type === 'image'));
    expect(paragraph?.runs).toEqual([{ type: 'image', mediaId: imageId }]);
    expect(memoDocumentNode(document, imageEntry).textContent).toContain('[图片]');
    const node = memoDocumentNode(document, imageEntry, new Map([[imageId, 'blob:test-image']]));
    expect(node.querySelector('img')?.getAttribute('src')).toBe('blob:test-image');
    expect(node.textContent).not.toContain('[图片]');
  });
  it('Word 内嵌图片字节并按内容宽度等比缩放', async () => {
    const bytes = await blobBytes(await memoDocx(imageEntry, { loadImage: imageLoader(onePixelPng) }));
    const xml = new TextDecoder().decode(unzipEntry(bytes, 'word/document.xml'));
    expect(xml).toContain('<w:drawing');
    expect(xml).not.toContain('[图片]');
    // 1×1 图片不会放大，EMU 尺寸保持原始像素换算值。
    expect(xml).toContain('cx="9525"');
    expect(xml).toContain('cy="9525"');
    const mediaName = zipNames(bytes).find((name) => name.startsWith('word/media/') && name.endsWith('.png'));
    expect(mediaName).toBeDefined();
    expect(Array.from(unzipEntry(bytes, mediaName!))).toEqual(Array.from(onePixelPng));
  });
  it('图片缺失或格式不受 Word 支持时保留占位文字', async () => {
    const missing = await blobBytes(await memoDocx(imageEntry, { loadImage: async () => null }));
    const missingXml = new TextDecoder().decode(unzipEntry(missing, 'word/document.xml'));
    expect(missingXml).toContain('[图片]');
    expect(missingXml).not.toContain('<w:drawing');
    const webp = await blobBytes(await memoDocx(imageEntry, { loadImage: imageLoader(onePixelPng, 'image/webp') }));
    const webpXml = new TextDecoder().decode(unzipEntry(webp, 'word/document.xml'));
    expect(webpXml).toContain('[图片]');
    expect(webpXml).not.toContain('<w:drawing');
  });
});
