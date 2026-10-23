import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { unwrap } from '@sesame-notes/api-client';
import { api, createChangeBatch, captureSessionOperation } from '../../lib/session';
import { useDraftClose } from '../../components/use-draft-close';
import { Button, Dialog, ErrorState, Field } from '../../components/ui';
import { dayLabels, type DayBook, type DayDefinition } from './day-dates';
import { createImportId } from '../../lib/transfer/import-identity';
import { readTransferFile, selectTable, type TransferTable } from '../../lib/transfer/table';
import {
  dayImportFields,
  detectDayMapping,
  mapDayRows,
  type DayFieldMapping,
  type ImportedDay,
} from './day-import-format';

/** 选择文件、映射、预览与确认依次完成，始终固定当前云端本子。 */
export function DayImport({ book }: { book: DayBook }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Upload size={16} />
        导入
      </Button>
      {open && <DayImportDialog book={book} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 日子 CSV 导入只创建新副本，行级幂等标识支持中断后的继续。 */
function DayImportDialog({ book, onClose }: { book: DayBook; onClose: () => void }) {
  const [source, setSource] = useState('');
  const [tables, setTables] = useState<TransferTable[]>([]);
  const [tableIndex, setTableIndex] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [table, setTable] = useState<ReturnType<typeof selectTable> | null>(null);
  const [mapping, setMapping] = useState<DayFieldMapping>(() => detectDayMapping([]));
  const [category, setCategory] = useState<DayDefinition['category']>('anniversary');
  const [statistic, setStatistic] = useState<DayDefinition['statistic_type']>('day');
  const [preview, setPreview] = useState<ImportedDay[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState({ imported: 0, skipped: 0, complete: false });
  const active = useRef(true);
  const stopRequested = useRef(false);
  const [stopped, setStopped] = useState(false);
  const generation = useRef(0);
  const plan = useRef<
    Array<{ id: string; mutationId: string; status: 'pending' | 'imported' | 'skipped'; index: number }>
  >([]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const { close, confirmation } = useDraftClose(table !== null && !progress.complete, reading || pending, onClose);
  /** 改变工作表或表头设置时废弃旧预览和幂等计划。 */
  function selectSource(sources: TransferTable[], index: number, header: boolean) {
    setTableIndex(index);
    setHasHeader(header);
    setPreview(null);
    setError(null);
    plan.current = [];
    try {
      const parsed = selectTable(sources[index]!, header);
      setSource(JSON.stringify(parsed));
      setTable(parsed);
      setMapping(detectDayMapping(parsed.headers));
      setProgress({ imported: 0, skipped: 0, complete: false });
    } catch (caught) {
      setTable(null);
      setError(caught);
    }
  }
  /** 读取失败只报告格式问题，不把文件原文放入错误或日志。 */
  async function readFile(file: File | undefined) {
    if (!file) return;
    const current = ++generation.current;
    setReading(true);
    setError(null);
    setTable(null);
    setPreview(null);
    plan.current = [];
    try {
      const operation = captureSessionOperation();
      if (file.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB');
      const sources = await readTransferFile(file);
      operation.assertCurrent();
      if (!active.current || current !== generation.current) return;
      if (!sources.length) throw new Error('文件中没有可读取的数据表');
      setTables(sources);
      selectSource(sources, 0, true);
    } catch (caught) {
      if (active.current && current === generation.current) setError(caught);
    } finally {
      if (active.current && current === generation.current) setReading(false);
    }
  }
  /** 全部行都通过领域规则后才开启确认按钮，避免先写一半才发现文件错误。 */
  function validatePreview() {
    if (!table) return;
    try {
      const rows = mapDayRows(table, mapping, category, statistic, new Date().toISOString());
      setPreview(rows);
      setError(null);
      plan.current = [];
    } catch (caught) {
      setPreview(null);
      setError(caught);
    }
  }
  /** 网络失败后保留已完成状态与原幂等键，不重发成功的行。 */
  async function runImport() {
    if (!preview || pending) return;
    stopRequested.current = false;
    setStopped(false);
    setPending(true);
    setError(null);
    let batch: ReturnType<typeof createChangeBatch> | undefined;
    try {
      batch = createChangeBatch();
      if (!plan.current.length) {
        const snapshot = unwrap(
          await api.GET('/api/v1/sync/day-books/full', {
            params: { query: { day_book_id: book.id, sync_id: book.sync_id } },
          }),
        );
        const existing = new Set(snapshot.day_events.map((event) => event.id));
        const sourceId = await createImportId(
          book.id,
          'day-csv',
          JSON.stringify({ source, mapping, category, statistic }),
        );
        plan.current = await Promise.all(
          preview.map(async (_, index) => {
            const id = await createImportId(book.id, sourceId, String(index));
            return {
              id,
              index,
              mutationId: crypto.randomUUID(),
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
          const row = preview[item.index]!;
          await batch.push({
            mutation_id: item.mutationId,
            entity_type: 'day_event',
            entity_id: item.id,
            ledger_id: null,
            day_book_id: book.id,
            sync_id: book.sync_id,
            base_revision: 0,
            updated_at: row.updatedAt,
            action: 'upsert',
            payload: row.payload,
          });
          item.status = 'imported';
        }
        if (active.current)
          setProgress({
            imported: plan.current.filter((item) => item.status === 'imported').length,
            skipped: plan.current.filter((item) => item.status === 'skipped').length,
            complete: false,
          });
      }
      if (active.current)
        setProgress((previous) => ({ ...previous, complete: plan.current.every((item) => item.status !== 'pending') }));
    } catch (caught) {
      if (active.current) setError(caught);
    } finally {
      try {
        await batch?.invalidate();
      } catch {
        if (active.current) setError(new Error('记录已提交，但列表刷新失败，请重新加载页面核对。'));
      }
      if (active.current) setPending(false);
    }
  }
  const locked = pending || reading || plan.current.length > 0;
  return (
    <Dialog
      open
      title="导入日子数据"
      description={`目标本子：${book.name}。导入创建新副本，不覆盖现有日子。`}
      onClose={close}
    >
      <div className="stack">
        <Field label="选择日子文件" hint="支持 CSV、TSV、TXT、XLSX、JSON，仅在当前浏览器解析，最大 64 MB。">
          <input
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.json"
            disabled={locked}
            onChange={(event) => {
              void readFile(event.target.files?.[0]);
            }}
          />
        </Field>
        {reading && <p role="status">正在读取文件…</p>}
        {tables.length > 0 && (
          <>
            <Field label="数据表 / JSON 路径">
              <select
                value={tableIndex}
                disabled={locked}
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
                disabled={locked}
                onChange={(event) => selectSource(tables, tableIndex, event.target.checked)}
              />
              首行是表头
            </label>
          </>
        )}
        {table && (
          <>
            <p>共 {table.rows.length} 行记录。请检查字段映射，再生成预览。</p>
            <details open={!preview}>
              <summary>字段映射</summary>
              <div className="form-grid">
                {dayImportFields.map(([key, label]) => (
                  <Field label={label} key={key}>
                    <select
                      value={mapping[key]}
                      disabled={locked}
                      onChange={(event) => {
                        setMapping({ ...mapping, [key]: event.target.value });
                        setPreview(null);
                      }}
                    >
                      <option value="">未映射</option>
                      {table.headers.map((header) => (
                        <option value={header} key={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
            </details>
            <div className="form-grid">
              <Field label="缺少类型时使用">
                <select
                  value={category}
                  disabled={locked}
                  onChange={(event) => {
                    setCategory(event.target.value as DayDefinition['category']);
                    setPreview(null);
                  }}
                >
                  {Object.entries(dayLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="缺少统计方式时使用">
                <select
                  value={statistic}
                  disabled={locked}
                  onChange={(event) => {
                    setStatistic(event.target.value as DayDefinition['statistic_type']);
                    setPreview(null);
                  }}
                >
                  <option value="day">按天</option>
                  <option value="year">按年月日</option>
                </select>
              </Field>
            </div>
            <Button variant="secondary" disabled={locked} onClick={validatePreview}>
              校验并预览
            </Button>
          </>
        )}
        {preview && (
          <>
            <p>已校验 {preview.length} 行：</p>
            <ul className="import-preview">
              {preview.slice(0, 5).map((row, index) => (
                <li key={index}>
                  {row.payload.name} · {dayLabels[row.payload.category]}
                </li>
              ))}
            </ul>
            <p role="status">
              已导入 {progress.imported} 条，已存在跳过 {progress.skipped} 条
              {progress.complete && !pending ? ' · 导入完成' : ''}
            </p>
            <p className="muted">逐条提交；中途中断时成功记录会保留。同一文件与相同字段映射再次导入会跳过已有副本。</p>
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
        {preview && (
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
