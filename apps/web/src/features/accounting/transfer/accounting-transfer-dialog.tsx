import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@sesame-notes/api-client';
import { Download, Upload } from 'lucide-react';
import { useCsvDownload } from './csv-download';
import { Button, Dialog, EmptyState, ErrorState, Field, LoadingState } from '../../../components/ui';
import { api, captureSessionOperation, useSession } from '../../../lib/session';
import { useDraftClose } from '../../../components/use-draft-close';
import { downloadText, exportFileName } from '../../../lib/transfer/download';
import { readTransferFile, selectTable, type TransferTable, type SelectedTable } from '../../../lib/transfer/table';
import { CategoryIcon } from '../category-icons';
import type { CategoryImportChoices } from './category-transfer';
import { transferFields, type Ledger, type Snapshot, type TransferMapping } from './transfer-schema';
import {
  accountingCsv,
  buildImportPlan,
  detectTransferMapping,
  previewDate,
  validateImportTargets,
  type ImportPlan,
} from './transfer-model';

/** 账本交换在固定账号下运行，文件解析不上传原始文件，写入前显示可核对的计划。 */
export function AccountingTransferDialog({ ledger: currentLedger, onClose }: { ledger: Ledger; onClose: () => void }) {
  const [ledger] = useState(currentLedger);
  const csvDownload = useCsvDownload();
  const { session } = useSession();
  const [mode, setMode] = useState<'export' | 'import'>('export');
  const [tables, setTables] = useState<TransferTable[]>([]);
  const [sheet, setSheet] = useState(0);
  const [hasHeader, setHasHeader] = useState(true);
  const [table, setTable] = useState<SelectedTable | null>(null);
  const [mapping, setMapping] = useState<TransferMapping>(() => detectTransferMapping([]));
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [categoryChoices, setCategoryChoices] = useState<CategoryImportChoices>({});
  const [categoryOptions, setCategoryOptions] = useState<Snapshot['categories']>([]);
  const [categoryPage, setCategoryPage] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'reading' | 'preview' | 'import' | null>(null);
  const [progress, setProgress] = useState({
    transactions: 0,
    categories: 0,
    batches: 0,
    complete: false,
    cancelled: false,
  });
  const [range, setRange] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [exported, setExported] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const active = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const stopAfterBatch = useRef(false);
  const validationSummary = useRef<HTMLDivElement>(null);
  const errorSummary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const summary = error ? errorSummary.current : plan?.errors.length ? validationSummary.current : null;
    if (summary) {
      summary.focus({ preventScroll: true });
      summary.scrollIntoView?.({ block: 'nearest' });
    }
  }, [error, plan]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      abort.current?.abort();
      stopAfterBatch.current = true;
    };
  }, []);
  const { close, confirmation } = useDraftClose(table !== null && !progress.complete, busy !== null, onClose);
  const snapshot = useQuery({
    queryKey: ['account', session!.user.user_id, 'accounting', ledger.id, 'transfer', ledger.sync_id],
    gcTime: 0,
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/sync/full', {
          signal,
          params: { query: { ledger_id: ledger.id, sync_id: ledger.sync_id } },
        }),
      ),
  });
  /** 调整文件解释方式会清除先前预览，但保留文件内容以便用户重新映射。 */
  function selectSource(sources: TransferTable[], index: number, header: boolean) {
    setSheet(index);
    setHasHeader(header);
    setPlan(null);
    setCategoryChoices({});
    setError(null);
    setProgress({ transactions: 0, categories: 0, batches: 0, complete: false, cancelled: false });
    try {
      const selected = selectTable(sources[index]!, header);
      setTable(selected);
      setMapping(detectTransferMapping(selected.headers));
    } catch (caught) {
      setTable(null);
      setError(caught);
    }
  }
  /** 读取结果与当前弹窗生命周期绑定，取消后迟到的结果不能重新显示。 */
  async function read(file: File | undefined) {
    if (!file || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy('reading');
    setError(null);
    setPlan(null);
    setTable(null);
    setTables([]);
    setLocked(false);
    try {
      const operation = captureSessionOperation();
      const sources = await readTransferFile(file);
      operation.assertCurrent();
      controller.signal.throwIfAborted();
      if (!active.current) return;
      if (!sources.length) throw new Error('文件中没有可读取的工作表');
      setTables(sources);
      selectSource(sources, 0, true);
    } catch (caught) {
      if (active.current && !controller.signal.aborted) setError(caught);
    } finally {
      if (active.current) setBusy(null);
    }
  }
  /** 预览总是读取最新快照，并在开始导入前展示所有错误行。 */
  async function preview() {
    if (!table || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy('preview');
    setError(null);
    setPlan(null);
    try {
      const operation = captureSessionOperation();
      const current = unwrap(
        await operation.client.GET('/api/v1/sync/full', {
          signal: controller.signal,
          params: { query: { ledger_id: ledger.id, sync_id: ledger.sync_id } },
        }),
      );
      operation.assertCurrent();
      if (current.ledger.archived_at) throw new Error('归档账本不能导入');
      if (current.ledger.currency !== ledger.currency) throw new Error('账本币种已变化，请重新打开导入');
      const next = await buildImportPlan(table, mapping, ledger, current, controller.signal, categoryChoices);
      operation.assertCurrent();
      if (active.current) {
        setPlan(next);
        setCategoryPage(0);
        setCategoryOptions(
          current.categories.filter((item) => !item.owner_id || item.owner_id === current.ledger.owner_id),
        );
        setProgress({
          transactions: 0,
          categories: 0,
          batches: 0,
          complete: next.count === 0 && next.errors.length === 0 && next.categoryRequests.length === 0,
          cancelled: false,
        });
      }
    } catch (caught) {
      if (active.current && !controller.signal.aborted) setError(caught);
    } finally {
      if (active.current) setBusy(null);
    }
  }
  /** 批次有固定实体身份和幂等键；取消只停止后续批次，已提交数据明确显示。 */
  async function commit() {
    if (!plan || plan.errors.length || plan.categoryRequests.length || busy || ledger.archived_at) return;
    setBusy('import');
    setLocked(true);
    setError(null);
    stopAfterBatch.current = false;
    setProgress((value) => ({ ...value, cancelled: false }));
    let operation: ReturnType<typeof captureSessionOperation> | undefined;
    try {
      operation = captureSessionOperation();
      const current = unwrap(
        await operation.client.GET('/api/v1/sync/full', {
          params: { query: { ledger_id: ledger.id, sync_id: ledger.sync_id } },
        }),
      );
      operation.assertCurrent();
      if (current.ledger.archived_at || current.ledger.currency !== ledger.currency)
        throw new Error('账本状态或币种已变化，请重新打开导入');
      try {
        validateImportTargets(plan, current);
      } catch (caught) {
        // 确认目标失效时允许重新映射；没有发出写入请求，不属于结果未知的重试。
        setLocked(false);
        setPlan(null);
        throw caught;
      }
      for (const batch of plan.batches) {
        if (!active.current || stopAfterBatch.current) break;
        if (batch.done) continue;
        operation.assertCurrent();
        unwrap(
          await operation.client.POST('/api/v1/ledgers/{ledger_id}/imports', {
            params: { path: { ledger_id: ledger.id }, query: plan.query, header: { 'idempotency-key': batch.key } },
            body: batch.body,
          }),
        );
        operation.assertCurrent();
        batch.done = true;
        if (active.current)
          setProgress({
            transactions: plan.batches
              .filter((item) => item.done)
              .reduce((n, item) => n + (item.body.transactions?.length ?? 0), 0),
            categories: plan.batches
              .filter((item) => item.done)
              .reduce((n, item) => n + (item.body.categories?.length ?? 0), 0),
            batches: plan.batches.filter((item) => item.done).length,
            complete: false,
            cancelled: false,
          });
      }
      if (active.current)
        setProgress((value) => ({
          ...value,
          complete: plan.batches.every((batch) => batch.done),
          cancelled: stopAfterBatch.current,
        }));
    } catch (caught) {
      if (active.current) setError(caught);
    } finally {
      try {
        await operation?.invalidate();
      } catch {
        if (active.current) setError(new Error('已提交批次保持有效，刷新列表失败，请重新加载页面核对。'));
      } finally {
        if (active.current) setBusy(null);
      }
    }
  }
  /** 整本导出来自单次完整快照，日期范围为用户本地自然日闭区间。 */
  function exportCsv() {
    if (!snapshot.data) return;
    setError(null);
    try {
      if (range && (!start || !end)) throw new Error('请填写起止日期');
      const result = accountingCsv(snapshot.data, range ? start : '', range ? end : '');
      const text = csvDownload.prepare(result.text);
      if (text === null) return;
      downloadText(text, `${exportFileName(ledger.name)}-明细.csv`, 'text/csv;charset=utf-8');
      setExported(result.count);
    } catch (caught) {
      setError(caught);
    }
  }
  return (
    <Dialog open title="账本数据导入 / 导出" description={`${ledger.name} · 本位币 ${ledger.currency}`} onClose={close}>
      <div className="stack">
        <div className="toolbar">
          <Button
            variant={mode === 'export' ? 'primary' : 'secondary'}
            disabled={!!busy}
            onClick={() => {
              setMode('export');
              setError(null);
            }}
          >
            导出 CSV
          </Button>
          <Button
            variant={mode === 'import' ? 'primary' : 'secondary'}
            disabled={!!busy || !!ledger.archived_at}
            onClick={() => {
              setMode('import');
              setError(null);
            }}
          >
            导入文件
          </Button>
        </div>
        {error !== null && (
          <div ref={errorSummary} tabIndex={-1}>
            <ErrorState error={error} />
          </div>
        )}
        {mode === 'export' ? (
          <>
            <p className="muted">
              导出完整云端账本中的明细，金额保留原始精度。CSV 包含原币金额与折算金额，不包含 AA 结算配置。
            </p>
            {snapshot.isPending ? (
              <LoadingState label="正在读取完整账本…" />
            ) : snapshot.isError ? (
              <ErrorState
                error={snapshot.error}
                retry={() => {
                  void snapshot.refetch();
                }}
              />
            ) : (
              <>
                <label className="checkbox-field">
                  <input type="checkbox" checked={range} onChange={(event) => setRange(event.target.checked)} />
                  只导出指定日期
                </label>
                {range && (
                  <div className="form-grid">
                    <Field label="开始日期">
                      <input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
                    </Field>
                    <Field label="结束日期">
                      <input type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
                    </Field>
                  </div>
                )}
                {csvDownload.controls}
                <Button onClick={exportCsv}>
                  <Download size={16} />
                  下载明细 CSV
                </Button>
                {exported !== null && <p role="status">已生成 {exported} 条明细的 CSV 文件。</p>}
              </>
            )}
          </>
        ) : (
          <>
            <p className="muted">
              支持 CSV、TSV、TXT、XLSX、JSON，最大 64 MB。先在浏览器内校验和预览，再将确认的支出明细写入当前云端账本。
            </p>
            <Field label="选择明细文件">
              <input
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.json"
                disabled={!!busy || locked}
                onChange={(event) => {
                  void read(event.target.files?.[0]);
                }}
              />
            </Field>
            {tables.length > 0 && (
              <>
                <Field label="数据表 / JSON 路径">
                  <select
                    value={sheet}
                    disabled={!!busy || locked}
                    onChange={(event) => selectSource(tables, Number(event.target.value), hasHeader)}
                  >
                    {tables.map((item, index) => (
                      <option value={index} key={index}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={hasHeader}
                    disabled={!!busy || locked}
                    onChange={(event) => selectSource(tables, sheet, event.target.checked)}
                  />
                  首行是表头
                </label>
              </>
            )}
            {table && (
              <>
                <div className="form-grid">
                  {transferFields.map(([key, label]) => (
                    <Field key={key} label={label}>
                      <select
                        value={mapping[key]}
                        disabled={!!busy || locked}
                        onChange={(event) => {
                          setMapping({ ...mapping, [key]: event.target.value });
                          setCategoryChoices({});
                          setPlan(null);
                        }}
                      >
                        <option value="">
                          {key === 'type' ? '默认支出' : key === 'currency' ? `默认 ${ledger.currency}` : '未映射'}
                        </option>
                        {table.headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
                <p className="muted">
                  共有 {table.rows.length}{' '}
                  行。空分类导入为未分类；新分类只有账本所有者可创建。外币必须提供折算金额或明确汇率，时间无时区时按当前浏览器本地时间解释。
                </p>
                {!locked && (
                  <Button
                    disabled={!!busy}
                    onClick={() => {
                      void preview();
                    }}
                  >
                    校验并预览
                  </Button>
                )}
              </>
            )}
            {busy && (
              <div className="toolbar">
                <p role="status">
                  {busy === 'reading'
                    ? '正在读取文件…'
                    : busy === 'preview'
                      ? '正在校验所有记录…'
                      : '正在提交导入批次…'}
                </p>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (busy === 'import') stopAfterBatch.current = true;
                    else abort.current?.abort();
                  }}
                >
                  取消{busy === 'import' ? '后续批次' : ''}
                </Button>
              </div>
            )}
            {plan && (
              <>
                <p>
                  待导入 {plan.count} 条明细，新增 {plan.categories} 个分类，跳过已导入 {plan.skipped} 条。
                </p>
                {plan.categoryRequests.length > 0 && (
                  <div className="stack">
                    <strong>请确认分类对应关系</strong>
                    <p className="muted">
                      名称相同的分类也可能不同。请逐项选择已有分类，或明确新建；只有身份与所属目录一致时才会自动对应。
                    </p>
                    {plan.categoryRequests.slice(categoryPage * 25, (categoryPage + 1) * 25).map((source) => {
                      const choice = categoryChoices[source.key];
                      const selected =
                        choice?.kind === 'existing' ? categoryOptions.find((item) => item.id === choice.id) : null;
                      return (
                        <Field
                          key={source.key}
                          label={`第 ${source.rows.slice(0, 4).join('、')}${source.rows.length > 4 ? ` 等 ${source.rows.length}` : ''} 行：${source.label}`}
                        >
                          <div className="toolbar">
                            <CategoryIcon name={source.icon} />
                            <span>{source.label}</span>
                          </div>
                          <select
                            value={choice?.kind === 'new' ? 'new' : (choice?.id ?? '')}
                            disabled={!!busy || locked}
                            onChange={(event) => {
                              const value = event.target.value;
                              setCategoryChoices((current) => {
                                const next = { ...current };
                                if (!value) delete next[source.key];
                                else
                                  next[source.key] =
                                    value === 'new' ? { kind: 'new' } : { kind: 'existing', id: value };
                                return next;
                              });
                            }}
                          >
                            <option value="">请选择目标分类</option>
                            {ledger.role === 'owner' && <option value="new">新建独立分类：{source.label}</option>}
                            {categoryOptions.map((item, index) => {
                              const parent = categoryOptions.find((row) => row.id === item.parent_id);
                              return (
                                <option value={item.id} key={item.id}>
                                  {parent ? `${parent.name} / ` : ''}
                                  {item.name} · 分类 {index + 1}
                                </option>
                              );
                            })}
                          </select>
                          {selected && (
                            <div className="toolbar">
                              <CategoryIcon name={selected.icon ?? null} />
                              <span>所选分类：{selected.name}</span>
                            </div>
                          )}
                        </Field>
                      );
                    })}
                    {plan.categoryRequests.length > 25 && (
                      <div className="toolbar">
                        <Button
                          variant="secondary"
                          disabled={!!busy || categoryPage === 0}
                          onClick={() => setCategoryPage((page) => page - 1)}
                        >
                          上一组
                        </Button>
                        <span>
                          {categoryPage + 1} / {Math.ceil(plan.categoryRequests.length / 25)}，共{' '}
                          {plan.categoryRequests.length} 项待确认
                        </span>
                        <Button
                          variant="secondary"
                          disabled={!!busy || (categoryPage + 1) * 25 >= plan.categoryRequests.length}
                          onClick={() => setCategoryPage((page) => page + 1)}
                        >
                          下一组
                        </Button>
                      </div>
                    )}
                    <p className="muted">
                      确认选择后，点击上方“校验并预览”重新检查。新建子分类时，也需要明确它的所属分类。
                    </p>
                  </div>
                )}
                {plan.errors.length ? (
                  <div role="alert" className="stack" ref={validationSummary} tabIndex={-1}>
                    <strong>{plan.errors.length} 行校验失败，未开始写入。</strong>
                    <ul>
                      {plan.errors.slice(0, 50).map((item) => (
                        <li key={item.row}>
                          第 {item.row} 行：{item.message}
                        </li>
                      ))}
                    </ul>
                    {plan.errors.length > 50 && <p>其余错误请修正源文件后重新校验。</p>}
                  </div>
                ) : plan.categoryRequests.length === 0 ? (
                  <>
                    <div className="table-scroll">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>行</th>
                            <th>时间</th>
                            <th>金额</th>
                            <th>分类</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.preview.map((item) => (
                            <tr key={item.row}>
                              <td>{item.row}</td>
                              <td>{previewDate(item.date)}</td>
                              <td>
                                {item.amount} {item.currency}
                              </td>
                              <td>{item.category}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="muted">
                      预览前 5 条，共 {plan.batches.length} 批。每批最多 100 个分类或 500
                      条明细，同批失败全部回滚；取消仅停止后续批次，已提交批次会保留。相同文件与映射重复导入会跳过已写入记录。
                    </p>
                    {!progress.complete && plan.count > 0 && (
                      <Button
                        disabled={!!busy}
                        onClick={() => {
                          void commit();
                        }}
                      >
                        <Upload size={16} />
                        {locked ? '继续未完成导入' : '确认导入'}
                      </Button>
                    )}
                    {plan.count === 0 && <EmptyState title="没有需要导入的新记录" />}
                  </>
                ) : null}
                {(progress.batches > 0 || progress.complete || progress.cancelled) && (
                  <p role="status">
                    {progress.complete && !busy ? '导入完成' : progress.cancelled ? '已停止后续批次' : '已提交'}：
                    {progress.transactions} 条明细，{progress.categories} 个分类，{progress.batches} 批。
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
      {confirmation}
    </Dialog>
  );
}
