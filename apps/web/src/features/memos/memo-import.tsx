import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { unwrap } from '@sesame-notes/api-client';
import { api, createChangeBatch, captureSessionOperation } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import { logMemoError, memoPreview, type MemoBook } from './memo-content';
import { readTransferFile, selectTable, type TransferTable, type SelectedTable } from '../../lib/transfer/table';
import {
  memoTableFields,
  detectMemoTableMapping,
  credentialFieldLabel,
  mapMemoTable,
  type MemoTableMapping,
} from './memo-table-import';
import { importedMemoPayload, parseMemoImport, type MemoImportDocument } from './memo-import-format';
import { createImportId } from '../../lib/transfer/import-identity';

/** 导入入口固定目标本子，文件仅在浏览器内解析，不上传原始文件。 */
export function MemoImport({ book }: { book: MemoBook }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Upload size={16} />
        导入
      </Button>
      {open && <MemoImportDialog book={book} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 导入生成新身份，失败时保留固定幂等键，后续继续不会覆盖已有记录。 */
function MemoImportDialog({ book, onClose }: { book: MemoBook; onClose: () => void }) {
  const [document, setDocument] = useState<MemoImportDocument | null>(null);
  const [tables, setTables] = useState<TransferTable[]>([]);
  const [tableIndex, setTableIndex] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [table, setTable] = useState<SelectedTable | null>(null);
  const [mapping, setMapping] = useState<MemoTableMapping>(() => detectMemoTableMapping([]));
  const [fieldNames, setFieldNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState({ imported: 0, skipped: 0, total: 0, complete: false });
  const generation = useRef(0);
  const active = useRef(true);
  const stopRequested = useRef(false);
  const [stopped, setStopped] = useState(false);
  const plan = useRef<
    Array<{
      id: string;
      mutationId: string;
      updatedAt: string;
      status: 'pending' | 'imported' | 'skipped';
      index: number;
    }>
  >([]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { close, confirmation } = useDraftClose(
    (document !== null || table !== null) && !progress.complete,
    reading || pending,
    onClose,
  );
  /** 文件解释与字段选择变化会废弃旧预览，不会提交前一份映射。 */
  function selectSource(sources: TransferTable[], index: number, header: boolean) {
    setTableIndex(index);
    setHasHeader(header);
    setDocument(null);
    setError(null);
    plan.current = [];
    try {
      const parsed = selectTable(sources[index]!, header);
      setTable(parsed);
      setMapping(detectMemoTableMapping(parsed.headers));
      setFieldNames(Object.fromEntries(parsed.headers.map((name) => [name, credentialFieldLabel(name)])));
      setProgress({ imported: 0, skipped: 0, total: parsed.rows.length, complete: false });
    } catch (caught) {
      logMemoError('选择备忘录导入数据表失败', caught, { bookId: book.id, tableIndex: index });
      setTable(null);
      setError(caught);
    }
  }
  /** 映射后的正文和账号字段共用原 JSON 的严格校验，再展示记录摘要。 */
  async function previewTable() {
    if (!table || reading || pending) return;
    setReading(true);
    setError(null);
    setDocument(null);
    try {
      const operation = captureSessionOperation();
      const parsed = await mapMemoTable(table, mapping, fieldNames, book, new Date().toISOString());
      operation.assertCurrent();
      if (active.current) {
        setDocument(parsed);
        plan.current = [];
        setProgress({ imported: 0, skipped: 0, total: parsed.books[0]!.entries.length, complete: false });
      }
    } catch (caught) {
      logMemoError('校验备忘录导入数据表失败', caught, { bookId: book.id });
      if (active.current) setError(caught);
    } finally {
      if (active.current) setReading(false);
    }
  }
  /** 文件选择切换会废弃先前读取结果，确保预览来自当前文件。 */
  async function readFile(file: File | undefined) {
    if (!file) return;
    const current = ++generation.current;
    setDocument(null);
    setError(null);
    setReading(true);
    setTable(null);
    setTables([]);
    plan.current = [];
    try {
      const operation = captureSessionOperation();
      if (file.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB');
      const text = file.name.toLowerCase().endsWith('.json') ? await file.text() : null;
      operation.assertCurrent();
      let exchange = false;
      if (text) {
        try {
          exchange = (JSON.parse(text.replace(/^\uFEFF/, '')) as { format?: unknown })?.format === 'sesame-memos';
        } catch {
          throw new Error('文件不是有效 JSON');
        }
      }
      if (exchange && text) {
        const parsed = parseMemoImport(text, book.type);
        if (current !== generation.current || !active.current) return;
        setDocument(parsed);
        setProgress({ imported: 0, skipped: 0, total: parsed.books[0]!.entries.length, complete: false });
      } else {
        const sources = await readTransferFile(file);
        operation.assertCurrent();
        if (current !== generation.current || !active.current) return;
        if (!sources.length) throw new Error('文件中没有可读取的数据表');
        setTables(sources);
        selectSource(sources, 0, true);
      }
    } catch (caught) {
      logMemoError('读取备忘录导入文件失败', caught, { bookId: book.id, fileSize: file.size });
      if (current === generation.current && active.current) setError(caught);
    } finally {
      if (current === generation.current && active.current) setReading(false);
    }
  }
  /** 逐项提交并报告进度，只有此前未写入的条目会重试。 */
  async function runImport() {
    if (!document || pending) return;
    stopRequested.current = false;
    setStopped(false);
    setPending(true);
    setError(null);
    let batch: ReturnType<typeof createChangeBatch> | undefined;
    try {
      batch = createChangeBatch();
      const entries = document.books[0]!.entries;
      if (!plan.current.length) {
        const snapshot = unwrap(
          await api.GET('/api/v1/sync/memo-books/full', {
            params: { query: { memo_book_id: book.id, sync_id: book.sync_id } },
          }),
        );
        const existing = new Set(snapshot.memo_entries.map((entry) => entry.id));
        const now = new Date().toISOString();
        plan.current = await Promise.all(
          entries.map(async (entry, index) => {
            const id = await createImportId(book.id, document.export_id, entry.source_entry_id);
            return {
              id,
              index,
              mutationId: crypto.randomUUID(),
              updatedAt: now,
              status: existing.has(id) ? ('skipped' as const) : ('pending' as const),
            };
          }),
        );
      }
      for (const item of plan.current) {
        if (!active.current) return;
        if (stopRequested.current) {
          setStopped(true);
          break;
        }
        if (item.status === 'pending') {
          const entry = entries[item.index]!;
          await batch.push({
            mutation_id: item.mutationId,
            entity_type: 'memo_entry',
            entity_id: item.id,
            ledger_id: null,
            day_book_id: null,
            memo_book_id: book.id,
            sync_id: book.sync_id,
            base_revision: 0,
            updated_at: item.updatedAt,
            action: 'upsert',
            payload: importedMemoPayload(entry),
          });
          item.status = 'imported';
        }
        if (active.current)
          setProgress({
            imported: plan.current.filter((item) => item.status === 'imported').length,
            skipped: plan.current.filter((item) => item.status === 'skipped').length,
            total: entries.length,
            complete: false,
          });
      }
      if (active.current)
        setProgress((previous) => ({ ...previous, complete: plan.current.every((item) => item.status !== 'pending') }));
    } catch (caught) {
      logMemoError('提交备忘录导入记录失败', caught, { bookId: book.id });
      if (active.current) setError(caught);
    } finally {
      try {
        await batch?.invalidate();
      } catch (caught) {
        logMemoError('刷新备忘录导入列表失败', caught, { bookId: book.id });
        if (active.current) setError(new Error('记录已提交，但列表刷新失败，请重新加载页面核对。'));
      }
      if (active.current) setPending(false);
    }
  }
  return (
    <Dialog
      open
      title="导入备忘录数据"
      description={`目标本子：${book.name}。导入会创建新副本，已有记录不会被覆盖。`}
      onClose={close}
    >
      <div className="stack">
        <Field
          label="选择文件"
          hint="支持 sesame-memos v2 JSON，以及 CSV、TSV、TXT、XLSX、通用 JSON 表格，最大 64 MB。"
        >
          <input
            type="file"
            accept=".json,.csv,.tsv,.txt,.xlsx"
            disabled={pending || reading || plan.current.length > 0}
            onChange={(event) => {
              void readFile(event.target.files?.[0]);
            }}
          />
        </Field>
        {reading && <p role="status">正在读取和校验文件…</p>}
        {tables.length > 0 && (
          <>
            <Field label="数据表 / JSON 路径">
              <select
                value={tableIndex}
                disabled={pending || reading || plan.current.length > 0}
                onChange={(event) => selectSource(tables, Number(event.target.value), hasHeader)}
              >
                {tables.map((item, index) => (
                  <option key={index} value={index}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={hasHeader}
                disabled={pending || reading || plan.current.length > 0}
                onChange={(event) => selectSource(tables, tableIndex, event.target.checked)}
              />
              首行是表头
            </label>
          </>
        )}
        {table && (
          <>
            <p>共 {table.rows.length} 行。表格正文按纯文本导入；富文本请使用 sesame-memos JSON。</p>
            <div className="form-grid">
              {memoTableFields
                .filter(([key]) => book.type === 'normal' || key !== 'body')
                .map(([key, label]) => (
                  <Field key={key} label={label}>
                    <select
                      value={mapping[key]}
                      disabled={pending || reading || plan.current.length > 0}
                      onChange={(event) => {
                        setMapping({ ...mapping, [key]: event.target.value });
                        setDocument(null);
                      }}
                    >
                      <option value="">未映射</option>
                      {table.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
            </div>
            {book.type === 'credentials' && (
              <>
                <p className="muted">其余列转为卡片字段，最多 20 个。清空字段名表示忽略该列。</p>
                <div className="form-grid">
                  {table.headers
                    .filter((header) => ![mapping.title, mapping.created_at, mapping.updated_at].includes(header))
                    .map((header) => (
                      <Field key={header} label={`${header} → 字段名`}>
                        <input
                          value={fieldNames[header] ?? ''}
                          disabled={pending || reading || plan.current.length > 0}
                          onChange={(event) => {
                            setFieldNames({ ...fieldNames, [header]: event.target.value });
                            setDocument(null);
                          }}
                        />
                      </Field>
                    ))}
                </div>
              </>
            )}
            <Button
              variant="secondary"
              disabled={pending || reading || plan.current.length > 0}
              onClick={() => {
                void previewTable();
              }}
            >
              校验并预览
            </Button>
          </>
        )}
        {document && (
          <>
            <p>
              来源：“{document.books[0]!.name}” · {progress.total} 条记录
            </p>
            <ul className="import-preview">
              {document.books[0]!.entries.slice(0, 5).map((entry) => (
                <li key={entry.source_entry_id}>
                  {entry.title || '无标题备忘录'}
                  {entry.book_type === 'credentials' && <p className="muted">{memoPreview(entry)}</p>}
                </li>
              ))}
            </ul>
            {progress.total > 5 && <small className="muted">另外 {progress.total - 5} 条记录。</small>}
            <p role="status">
              已导入 {progress.imported} 条，已存在跳过 {progress.skipped} 条
              {progress.complete && !pending ? ' · 导入完成' : ''}
            </p>
            <p className="muted">逐条提交；中途中断时，成功的记录会保留。再次导入同一份文件会跳过已存在的副本。</p>
          </>
        )}
        {pending && (
          <Button
            variant="secondary"
            onClick={() => {
              stopRequested.current = true;
            }}
          >
            停止后续导入
          </Button>
        )}
        {stopped && <p role="status">已停止后续导入，已经提交的记录会保留，可以继续剩余部分。</p>}
        {error !== null && <ErrorState error={error} />}
        {document && (
          <div className="dialog-actions">
            {progress.complete && !pending && (
              <Button variant="secondary" disabled={reading} onClick={close}>
                完成
              </Button>
            )}
            {!progress.complete && (
              <Button
                disabled={pending || reading}
                onClick={() => {
                  void runImport();
                }}
              >
                {pending ? '正在导入…' : progress.imported ? '继续导入' : '确认导入'}
              </Button>
            )}
          </div>
        )}
      </div>
      {confirmation}
    </Dialog>
  );
}
