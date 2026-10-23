import { downloadText, exportFileName } from '../../lib/transfer/download';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { unwrap } from '@sesame-notes/api-client';
import { api, useSession } from '../../lib/session';
import { Button, Dialog, ErrorState, LoadingState } from '../../components/ui';
import { deltaSchema, fieldsSchema, logMemoError, type MemoBook, type MemoEntry } from './memo-content';

/** 生成移动端已有交换格式，不包含账号、同步水位、修订号或会话信息。 */
export function memoExportJson(book: MemoBook, entries: MemoEntry[], exportId: string, exportedAt: string): string {
  const text = JSON.stringify(
    {
      format: 'sesame-memos',
      schema_version: 2,
      export_id: exportId,
      exported_at: exportedAt,
      books: [
        {
          source_book_id: book.id,
          name: book.name,
          type: book.type,
          created_at: book.created_at,
          updated_at: book.updated_at,
          entries: entries
            .filter((entry) => entry.deleted_at === null)
            .map((entry) => {
              if (entry.memo_book_id !== book.id || entry.book_type !== book.type)
                throw new Error('导出内容与当前本子不一致，请重新加载');
              const body =
                entry.book_type === 'normal' ? deltaSchema.parse(entry.body) : fieldsSchema.parse(entry.body);
              return {
                source_entry_id: entry.id,
                source_book_id: book.id,
                book_type: entry.book_type,
                title: entry.title,
                body_format: entry.body_format,
                body,
                order_key: entry.order_key,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
              };
            }),
        },
      ],
    },
    null,
    2,
  );
  if (new TextEncoder().encode(text).byteLength > 64 * 1024 * 1024) throw new Error('导出内容超过 64 MB，请先分本整理');
  return text;
}

/** 整本导出从完整快照生成，不会把当前分页误当全部内容。 */
export function MemoExport({ book }: { book: MemoBook }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Download size={16} />
        导出
      </Button>
      {open && <MemoExportDialog book={book} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 整本内容读取完成后，由用户选择下载兼容客户端的交换文件。 */
function MemoExportDialog({ book, onClose }: { book: MemoBook; onClose: () => void }) {
  const { session } = useSession();
  const [error, setError] = useState<unknown>(null);
  const data = useQuery({
    queryKey: ['account', session!.user.user_id, 'memo-export', book.id],
    gcTime: 0,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/memo-books/full', {
          signal,
          params: { query: { memo_book_id: book.id, sync_id: book.sync_id } },
        }),
      ),
  });
  /** 格式化失败时保留弹窗，不把数据内容放入错误信息。 */
  function download() {
    if (!data.data) return;
    try {
      const text = memoExportJson(
        data.data.memo_book,
        data.data.memo_entries,
        crypto.randomUUID(),
        new Date().toISOString(),
      );
      downloadText(text, `${exportFileName(book.name)}.json`, 'application/json;charset=utf-8');
      setError(null);
    } catch (caught) {
      logMemoError('导出备忘录交换文件失败', caught, { bookId: book.id });
      setError(new Error('这份内容无法导出，请重新读取并检查是否存在不支持的正文格式。'));
    }
  }
  return (
    <Dialog open title="导出备忘录本" onClose={onClose} description="导出整本内容，保留富文本和账号字段。">
      {data.isPending ? (
        <LoadingState label="正在准备整本内容…" />
      ) : data.isError ? (
        <ErrorState
          error={data.error}
          retry={() => {
            void data.refetch();
          }}
        />
      ) : (
        <div className="stack">
          <p>
            将导出“{book.name}”的 {data.data.memo_entries.length} 条记录。
          </p>
          {error !== null && <ErrorState error={error} />}
          <Button onClick={download}>
            <Download size={16} />
            下载 JSON
          </Button>
        </div>
      )}
    </Dialog>
  );
}
