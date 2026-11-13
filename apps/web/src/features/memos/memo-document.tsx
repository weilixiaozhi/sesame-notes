import { useEffect, useRef, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { Button, Dialog, ErrorState } from '../../components/ui';
import { useDraftClose } from '../../components/use-draft-close';
import { captureSessionOperation } from '../../lib/session';
import { deltaSchema, fieldsSchema, logMemoError, memoImageIds, type MemoEntry } from './memo-content';
import { loadMemoImage, readBlobBytes, type MemoImageLoader } from './memo-media';
import { downloadText, exportFileName } from '../../lib/transfer/download';

/** 段落片段只保存文字或图片引用，图片字节在导出时按需加载。 */
type ParagraphRun = { type: 'text'; text: string; bold: boolean } | { type: 'image'; mediaId: string };
type Paragraph = {
  runs: ParagraphRun[];
  header?: number;
  list?: string;
  indent: number;
  ordinal?: number;
};

/** 从严格受限 Delta 提取段落，不使用 HTML 注入。 */
export function memoParagraphs(entry: MemoEntry): Paragraph[] {
  const delta = deltaSchema.parse(entry.body);
  const result: Paragraph[] = [];
  let runs: Paragraph['runs'] = [];
  for (const op of delta.ops) {
    const insert = op.insert;
    if (typeof insert !== 'string') {
      runs.push({ type: 'image', mediaId: insert.memo_image });
      continue;
    }
    const attributes = 'attributes' in op ? op.attributes : undefined;
    const parts = insert.split('\n');
    parts.forEach((text, index) => {
      if (text) runs.push({ type: 'text', text, bold: attributes?.bold === true });
      if (index < parts.length - 1) {
        result.push({
          runs,
          header: attributes?.header,
          list: attributes?.list,
          indent: attributes?.indent ?? 0,
        });
        runs = [];
      }
    });
  }
  const counters: number[] = [];
  return result.map((paragraph) => {
    counters.splice(paragraph.indent + 1);
    counters[paragraph.indent] = paragraph.list === 'ordered' ? (counters[paragraph.indent] ?? 0) + 1 : 0;
    return { ...paragraph, ordinal: paragraph.list === 'ordered' ? counters[paragraph.indent] : undefined };
  });
}

/** Markdown 字面文本先转义，再添加受支持的富文本标记。 */
function markdownText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_[\]{}()#+.!|~-]/g, '\\$&');
}
/** 普通笔记保留粗体与列表，账号卡片按字段顺序导出。 */
export function memoMarkdown(entry: MemoEntry): string {
  let result = `# ${markdownText(entry.title || '无标题备忘录')}\n\n`;
  if (entry.book_type === 'credentials')
    result += fieldsSchema
      .parse(entry.body)
      .fields.map((field) => `## ${markdownText(field.label)}\n\n${markdownText(field.value)}\n`)
      .join('\n');
  else
    result += memoParagraphs(entry)
      .map((paragraph) => {
        const text = paragraph.runs
          .map((run) => {
            if (run.type === 'image') return '[图片]';
            return run.bold ? `**${markdownText(run.text)}**` : markdownText(run.text);
          })
          .join('');
        const marker = paragraph.header
          ? `${'#'.repeat(paragraph.header)} `
          : paragraph.list === 'ordered'
            ? `${paragraph.ordinal}. `
            : paragraph.list === 'checked'
              ? '- [x] '
              : paragraph.list === 'unchecked'
                ? '- [ ] '
                : paragraph.list === 'bullet'
                  ? '- '
                  : '';
        return `${'  '.repeat(paragraph.indent)}${marker}${text}`;
      })
      .join('\n\n');
  return `${result}\n`;
}

/** 导出中的列表记号跟随层级计数，清单保持勾选状态。 */
function listMarker(paragraph: Paragraph): string {
  return paragraph.list === 'checked'
    ? '☑ '
    : paragraph.list === 'unchecked'
      ? '☐ '
      : paragraph.list === 'ordered'
        ? `${paragraph.ordinal}. `
        : paragraph.list === 'bullet'
          ? '• '
          : '';
}

/** 生成仅含安全文本节点的独立白底文档，同时供打印与图片渲染使用。 */
export function memoDocumentNode(
  document: Document,
  entry: MemoEntry,
  imageUrls: ReadonlyMap<string, string> = new Map(),
): HTMLDivElement {
  const container = document.createElement('div');
  container.style.cssText =
    'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#202020;background:#fff;line-height:1.65;padding:40px;overflow-wrap:anywhere;box-sizing:border-box;';
  const title = document.createElement('h1');
  title.style.cssText = 'font-size:28px;line-height:1.3;margin:0 0 28px';
  title.textContent = entry.title || '无标题备忘录';
  container.append(title);
  if (entry.book_type === 'credentials') {
    for (const field of fieldsSchema.parse(entry.body).fields) {
      const section = document.createElement('section');
      section.style.breakInside = 'avoid';
      const label = document.createElement('h2');
      label.style.cssText = 'font-size:20px;margin:24px 0 8px';
      label.textContent = field.label;
      const value = document.createElement('p');
      value.style.cssText = 'font-size:16px;white-space:pre-wrap;margin:0 0 16px';
      value.textContent = field.value;
      section.append(label, value);
      container.append(section);
    }
  } else {
    for (const paragraph of memoParagraphs(entry)) {
      const element = document.createElement(paragraph.header ? `h${paragraph.header}` : 'p');
      element.style.cssText = `white-space:pre-wrap;line-height:1.65;margin:10px 0 10px ${paragraph.indent * 24}px;font-size:${paragraph.header === 1 ? 26 : paragraph.header === 2 ? 22 : paragraph.header === 3 ? 18 : 16}px;`;
      element.append(document.createTextNode(listMarker(paragraph)));
      for (const run of paragraph.runs) {
        if (run.type === 'image') {
          const url = imageUrls.get(run.mediaId);
          if (!url) {
            // 图片尚未加载或已失效时保留与 Markdown、Word 一致的占位文字。
            element.append(document.createTextNode('[图片]'));
            continue;
          }
          const image = document.createElement('img');
          image.src = url;
          image.alt = '备忘录图片';
          image.style.cssText = 'display:block;max-width:100%;height:auto;margin:4px 0;';
          element.append(image);
          continue;
        }
        const span = document.createElement(run.bold ? 'strong' : 'span');
        span.textContent = run.text;
        element.append(span);
      }
      if (!paragraph.runs.length) element.append(document.createElement('br'));
      container.append(element);
    }
  }
  return container;
}

/** 打印窗口只提供预览与用户主动调用的系统对话框，不直接提交打印任务。 */
function printMemo(entry: MemoEntry): void {
  printMemoDocument(entry.title || '备忘录', (document) => memoDocumentNode(document, entry));
}

/** 用户主动打开本地打印预览，单篇与合并文档共用同一安全入口。 */
export function printMemoDocument(title: string, render: (document: Document) => HTMLElement): void {
  const target = window.open('', '_blank', 'popup');
  if (!target) throw new Error('浏览器阻止了打印窗口，请允许本站弹出窗口后重试');
  try {
    target.opener = null;
    target.document.title = title;
    const style = target.document.createElement('style');
    style.textContent =
      'body{max-width:800px;margin:20px auto}button{padding:10px 16px;margin:0 40px}@media print{button{display:none}body{margin:0;max-width:none}body>div{padding:0!important}}@page{margin:20mm}';
    target.document.head.append(style);
    const button = target.document.createElement('button');
    button.textContent = '打印 / 保存为 PDF';
    button.addEventListener('click', () => target.print());
    target.document.body.append(button, render(target.document));
    target.focus();
  } catch (error) {
    target.close();
    throw error;
  }
}

/** Word 可承载的图片字节、格式与像素尺寸。 */
type DocxImage = { data: Uint8Array; type: 'png' | 'jpg'; width: number; height: number };

/** 从 PNG 文件头读取像素尺寸。 */
function pngPixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width && height ? { width, height } : null;
}

/** 从 JPEG 的 SOF 段读取像素尺寸，遇到扫描数据即停止。 */
function jpegPixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // 填充字节和没有长度字段的标记直接跳过。
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return null;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    if (sofMarkers.has(marker)) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width && height ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** 只接受 Word 可内嵌的 PNG/JPEG，其余格式由调用方降级为占位文字。 */
async function docxImage(blob: Blob): Promise<DocxImage | null> {
  const contentType = blob.type.split(';', 1)[0]?.trim().toLowerCase();
  const type = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : null;
  if (!type) return null;
  const data = await readBlobBytes(blob);
  const size = type === 'png' ? pngPixelSize(data) : jpegPixelSize(data);
  return size ? { data, type, ...size } : null;
}

/** 预加载正文引用的图片；单张失败只影响对应段落，不阻断整篇导出。 */
async function loadDocxImages(
  entry: MemoEntry,
  loadImage: MemoImageLoader,
  signal?: AbortSignal,
): Promise<Map<string, DocxImage>> {
  const images = new Map<string, DocxImage>();
  for (const mediaId of memoImageIds(entry.body)) {
    try {
      const blob = await loadImage(mediaId, signal);
      if (!blob) continue;
      const image = await docxImage(blob);
      if (image) images.set(mediaId, image);
    } catch (error) {
      logMemoError('加载 Word 导出图片失败', error, { entryId: entry.id, mediaId });
    }
  }
  return images;
}

/** A4 正文区域约 600 像素；图片只缩小不放大，保持原始宽高比。 */
function docxImageSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 600 / width);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Word 文档显式设置东亚字体，保留中文、段落层级、粗体、清单和内嵌图片。 */
export async function memoDocx(
  entry: MemoEntry,
  options: { loadImage?: MemoImageLoader; signal?: AbortSignal } = {},
): Promise<Blob> {
  const {
    Document: WordDocument,
    Paragraph: WordParagraph,
    TextRun,
    ImageRun,
    HeadingLevel,
    Packer,
  } = await import('docx');
  const font = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft YaHei' };
  const images =
    entry.book_type === 'normal'
      ? await loadDocxImages(entry, options.loadImage ?? loadMemoImage, options.signal)
      : new Map<string, DocxImage>();
  const children = [
    new WordParagraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: entry.title || '无标题备忘录', font, bold: true })],
    }),
  ];
  if (entry.book_type === 'credentials') {
    for (const field of fieldsSchema.parse(entry.body).fields) {
      children.push(
        new WordParagraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: field.label, font, bold: true })],
        }),
      );
      children.push(
        new WordParagraph({
          children: field.value.split('\n').map((text, index) => new TextRun({ text, font, break: index ? 1 : 0 })),
        }),
      );
    }
  } else {
    for (const paragraph of memoParagraphs(entry))
      children.push(
        new WordParagraph({
          heading: paragraph.header
            ? [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][paragraph.header - 1]
            : undefined,
          indent: { left: paragraph.indent * 360 },
          spacing: { after: 160 },
          children: [
            new TextRun({ text: listMarker(paragraph), font }),
            ...paragraph.runs.map((run) => {
              if (run.type === 'text') return new TextRun({ text: run.text, bold: run.bold, font });
              const image = images.get(run.mediaId);
              if (!image) return new TextRun({ text: '[图片]', font });
              return new ImageRun({
                type: image.type,
                data: image.data,
                transformation: docxImageSize(image.width, image.height),
              });
            }),
          ],
        }),
      );
  }
  const document = new WordDocument({
    styles: { default: { document: { run: { font, size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(document);
}

/** 为正文图片生成本地对象地址，渲染结束后由调用方统一释放。 */
async function loadMemoImageUrls(entry: MemoEntry, signal?: AbortSignal): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  await Promise.all(
    memoImageIds(entry.body).map(async (mediaId) => {
      try {
        const blob = await loadMemoImage(mediaId, signal);
        if (blob) urls.set(mediaId, URL.createObjectURL(blob));
      } catch (error) {
        logMemoError('预加载备忘录图片失败', error, { entryId: entry.id, mediaId });
      }
    }),
  );
  return urls;
}

/** 等待离屏文档中的图片解码完成，避免导出图仍是占位。 */
async function waitForImages(node: HTMLElement): Promise<void> {
  await Promise.all(
    Array.from(node.querySelectorAll('img')).map((image) => {
      try {
        return image.decode().catch(() => undefined);
      } catch {
        // 测试环境或旧浏览器没有图片解码接口时直接继续渲染。
        return Promise.resolve();
      }
    }),
  );
}

/** 图片在本地 DOM 中渲染，超出画布预算时明确拒绝，避免下载被截断的长图。 */
async function memoPng(entry: MemoEntry, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const urls = await loadMemoImageUrls(entry, signal);
  try {
    signal?.throwIfAborted();
    const node = memoDocumentNode(document, entry, urls);
    await waitForImages(node);
    return await renderMemoPng(node, signal);
  } finally {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }
}

/** 取消立即结束当前等待；底层生成器的迟到结果被消费但不交付。 */
export async function awaitMemoExport<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException('已取消生成', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** 单篇和多卡片文档共用完整高度检查与离屏图片生成。 */
export async function renderMemoPng(node: HTMLElement, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const { toBlob } = await import('html-to-image');
  signal?.throwIfAborted();
  const removeNode = () => node.remove();
  signal?.addEventListener('abort', removeNode, { once: true });
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('inert', '');
  node.style.width = '860px';
  node.style.position = 'absolute';
  node.style.left = '-10000px';
  node.style.top = '0';
  document.body.append(node);
  try {
    await awaitMemoExport(document.fonts.ready, signal);
    signal?.throwIfAborted();
    const height = node.scrollHeight;
    if (height > 12000 || height < 1) throw new Error('这条备忘录太长，无法生成完整图片，请使用 Word 或 PDF 导出');
    const blob = await awaitMemoExport(
      toBlob(node, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
        fontEmbedCSS: '',
        style: { position: 'static', left: '0', top: '0' },
        width: 860,
        height,
      }),
      signal,
    );
    signal?.throwIfAborted();
    if (!blob) throw new Error('图片生成失败，请使用 Word 或 PDF 导出');
    return blob;
  } finally {
    signal?.removeEventListener('abort', removeNode);
    node.remove();
  }
}

/** 下载二进制文档后释放临时地址，文件不会上传到服务端。 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** 每条记录独立控制导出，打开时才挂载有导航保护的对话框。 */
export function MemoDocumentExport({ entry }: { entry: MemoEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`导出 ${entry.title || '无标题备忘录'}`}
        onClick={() => setOpen(true)}
      >
        <Download size={16} />
        导出
      </Button>
      {open && <DocumentExportDialog entry={entry} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 用户选择格式后生成文档，任务取消后不交付迟到的文件。 */
function DocumentExportDialog({ entry, onClose }: { entry: MemoEntry; onClose: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  const task = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      task.current?.abort();
    };
  }, []);
  const { close, confirmation } = useDraftClose(false, pending, onClose);
  const disabled = pending;
  /** 延迟加载文档依赖，仅在生成成功且组件仍有效时开始下载。 */
  async function exportDocument(format: 'markdown' | 'print' | 'docx' | 'png') {
    if (disabled) return;
    const controller = new AbortController();
    task.current = controller;
    setPending(true);
    setError(null);
    try {
      const operation = captureSessionOperation();
      const signal = AbortSignal.any([controller.signal, operation.signal]);
      if (format === 'markdown')
        downloadText(memoMarkdown(entry), `${exportFileName(entry.title)}.md`, 'text/markdown;charset=utf-8');
      else if (format === 'print') printMemo(entry);
      else {
        const blob = await (format === 'docx'
          ? awaitMemoExport(memoDocx(entry, { signal }), signal)
          : memoPng(entry, signal));
        signal.throwIfAborted();
        operation.assertCurrent();
        if (active.current) downloadBlob(blob, `${exportFileName(entry.title)}.${format}`);
      }
    } catch (caught) {
      logMemoError('生成备忘录文档失败', caught, { entryId: entry.id, format });
      if (active.current && task.current === controller && !controller.signal.aborted)
        setError(
          new Error(
            caught instanceof Error &&
              (caught.message.startsWith('这条备忘录太长') || caught.message.startsWith('浏览器阻止'))
              ? caught.message
              : '文档生成失败，请检查正文格式后重试。',
          ),
        );
    } finally {
      if (active.current && task.current === controller) setPending(false);
    }
  }
  return (
    <Dialog open title="导出已保存的备忘录" description={entry.title || '无标题备忘录'} onClose={close}>
      <div className="stack">
        {error !== null && <ErrorState error={error} />}
        {pending && (
          <div className="toolbar">
            <p role="status">正在本地生成文档…</p>
            <Button
              variant="secondary"
              onClick={() => {
                task.current?.abort();
                setPending(false);
              }}
            >
              取消生成
            </Button>
          </div>
        )}
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            void exportDocument('markdown');
          }}
        >
          <Download size={16} />
          下载 Markdown
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            void exportDocument('docx');
          }}
        >
          <Download size={16} />
          下载 Word (.docx)
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            void exportDocument('png');
          }}
        >
          <Download size={16} />
          下载图片 (.png)
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => {
            void exportDocument('print');
          }}
        >
          <Printer size={16} />
          打印 / 保存为 PDF
        </Button>
        <p className="muted">文档在当前浏览器生成，不会上传。PDF 请在打印窗口选择“另存为 PDF”。</p>
      </div>
      {confirmation}
    </Dialog>
  );
}
