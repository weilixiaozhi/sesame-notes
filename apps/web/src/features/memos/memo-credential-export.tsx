import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@sesame-notes/api-client';
import { Download, Printer } from 'lucide-react';
import { api, useSession, captureSessionOperation } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { fieldsSchema, logMemoError, memoPreview, type MemoBook, type MemoEntry } from './memo-content';
import {
  memoDocumentNode,
  memoMarkdown,
  printMemoDocument,
  renderMemoPng,
  downloadBlob,
  awaitMemoExport,
} from './memo-document';
import { downloadText, exportFileName } from '../../lib/transfer/download';

/** 合并导出按本内顺序连接卡片，每条仍独立校验字段上限。 */
export function credentialMarkdown(entries: readonly MemoEntry[]): string {
  return entries
    .map((entry) => {
      if (entry.book_type !== 'credentials') throw new Error('只能合并账号密码卡片');
      return memoMarkdown(entry);
    })
    .join('\n---\n\n');
}

/** 合并文档全部使用安全文本节点，按选中的卡片顺序生成。 */
export function credentialDocumentNode(document: Document, name: string, entries: readonly MemoEntry[]): HTMLElement {
  const root = document.createElement('div');
  root.style.cssText =
    'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:#202020;background:#fff;padding:40px;box-sizing:border-box;overflow-wrap:anywhere';
  const title = document.createElement('h1');
  title.textContent = name;
  root.append(title);
  for (const entry of entries) {
    if (entry.book_type !== 'credentials') throw new Error('只能合并账号密码卡片');
    const node = memoDocumentNode(document, entry);
    node.style.padding = '24px 0';
    node.style.borderTop = '1px solid #ddd';
    root.append(node);
  }
  return root;
}

/** Word 按卡片标题分节，中文和密码文本原样写入文档。 */
export async function credentialDocx(name: string, entries: readonly MemoEntry[]): Promise<Blob> {
  const { Document, Paragraph, TextRun, HeadingLevel, Packer } = await import('docx');
  const font = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft YaHei' };
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: name, font, bold: true })] }),
  ];
  for (const entry of entries) {
    if (entry.book_type !== 'credentials') throw new Error('只能合并账号密码卡片');
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: entry.title || '无标题卡片', font, bold: true })],
      }),
    );
    for (const field of fieldsSchema.parse(entry.body).fields) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: field.label, font, bold: true })],
        }),
      );
      children.push(
        new Paragraph({
          children: field.value.split('\n').map((text, index) => new TextRun({ text, font, break: index ? 1 : 0 })),
        }),
      );
    }
  }
  return Packer.toBlob(
    new Document({ styles: { default: { document: { run: { font, size: 22 } } } }, sections: [{ children }] }),
  );
}

/** 账号本额外提供多选合并导出，普通备忘录仍使用单篇导出。 */
export function CredentialExport({ book }: { book: MemoBook }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Download size={16} />
        合并导出卡片
      </Button>
      {open && <CredentialExportDialog book={book} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 用户选中的卡片集合进入本地文档，异步结束前复核当前账号。 */
function CredentialExportDialog({ book, onClose }: { book: MemoBook; onClose: () => void }) {
  const { session } = useSession();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
  const full = useQuery({
    queryKey: ['account', session!.user.user_id, 'memo-credential-export', book.id],
    gcTime: 0,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/memo-books/full', {
          signal,
          params: { query: { memo_book_id: book.id, sync_id: book.sync_id } },
        }),
      ),
  });
  useEffect(() => {
    if (full.data)
      setSelected(
        (current) =>
          current ?? new Set(full.data.memo_entries.filter((entry) => !entry.deleted_at).map((entry) => entry.id)),
      );
  }, [full.data]);
  const entries = full.data?.memo_entries.filter((entry) => !entry.deleted_at) ?? [];
  const chosen = entries.filter((entry) => selected === null || selected.has(entry.id));
  /** 格式生成不会写入服务器；离开或换号后禁止下载迟到的敏感文件。 */
  async function exportDocument(format: 'md' | 'docx' | 'png' | 'print') {
    if (!chosen.length || pending) return;
    const controller = new AbortController();
    task.current = controller;
    setPending(true);
    setError(null);
    try {
      const operation = captureSessionOperation();
      const signal = AbortSignal.any([controller.signal, operation.signal]);
      if (format === 'print')
        printMemoDocument(book.name, (document) => credentialDocumentNode(document, book.name, chosen));
      else if (format === 'md')
        downloadText(credentialMarkdown(chosen), `${exportFileName(book.name)}.md`, 'text/markdown;charset=utf-8');
      else {
        const blob = await (format === 'docx'
          ? awaitMemoExport(credentialDocx(book.name, chosen), signal)
          : renderMemoPng(credentialDocumentNode(document, book.name, chosen), signal));
        signal.throwIfAborted();
        operation.assertCurrent();
        if (active.current) downloadBlob(blob, `${exportFileName(book.name)}.${format}`);
      }
    } catch (caught) {
      logMemoError('生成账号卡片合并文档失败', caught, { bookId: book.id, format, count: chosen.length });
      if (active.current && task.current === controller && !controller.signal.aborted)
        setError(
          caught instanceof Error &&
            (caught.message.startsWith('这条备忘录太长') || caught.message.startsWith('浏览器阻止'))
            ? caught
            : new Error('文档生成失败，请重新选择卡片后重试。'),
        );
    } finally {
      if (active.current && task.current === controller) setPending(false);
    }
  }
  return (
    <Dialog open title="合并导出账号密码卡片" description={book.name} onClose={close}>
      {full.isPending ? (
        <LoadingState label="正在读取完整账号本…" />
      ) : full.isError ? (
        <ErrorState
          error={full.error}
          retry={() => {
            void full.refetch();
          }}
        />
      ) : !entries.length ? (
        <EmptyState title="当前本子没有账号卡片" />
      ) : (
        <div className="stack">
          <div className="toolbar">
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setSelected(new Set(entries.map((entry) => entry.id)));
              }}
            >
              全选
            </Button>
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setSelected(new Set());
              }}
            >
              取消全选
            </Button>
            <span>
              已选 {chosen.length} / {entries.length}
            </span>
          </div>
          <div className="stack">
            {entries.map((entry) => (
              <label className="checkbox-field" key={entry.id}>
                <input
                  type="checkbox"
                  aria-label={entry.title || '无标题卡片'}
                  checked={selected === null || selected.has(entry.id)}
                  disabled={pending}
                  onChange={(event) => {
                    const next = new Set(selected ?? entries.map((item) => item.id));
                    if (event.target.checked) next.add(entry.id);
                    else next.delete(entry.id);
                    setSelected(next);
                  }}
                />
                <span>
                  {entry.title || '无标题卡片'}
                  <br />
                  <small className="muted">{memoPreview(entry)}</small>
                </span>
              </label>
            ))}
          </div>
          {error !== null && <ErrorState error={error} />}
          {pending && (
            <div className="toolbar">
              <p role="status">正在本地生成合并文档…</p>
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
            disabled={!chosen.length || pending}
            onClick={() => {
              void exportDocument('md');
            }}
          >
            下载合并 Markdown
          </Button>
          <Button
            disabled={!chosen.length || pending}
            onClick={() => {
              void exportDocument('docx');
            }}
          >
            下载合并 Word (.docx)
          </Button>
          <Button
            disabled={!chosen.length || pending}
            onClick={() => {
              void exportDocument('png');
            }}
          >
            下载合并图片 (.png)
          </Button>
          <Button
            disabled={!chosen.length || pending}
            onClick={() => {
              void exportDocument('print');
            }}
          >
            <Printer size={16} />
            打印合并文档 / 保存为 PDF
          </Button>
          <p className="muted">文档在当前浏览器生成。长图超出完整输出尺寸时，请选择 Word 或 PDF。</p>
        </div>
      )}
      {confirmation}
    </Dialog>
  );
}
