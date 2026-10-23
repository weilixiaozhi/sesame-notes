import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileUp } from 'lucide-react';
import { unwrap } from '@sesame-notes/api-client';
import { Button, Dialog, ErrorState, Field } from '../../../components/ui';
import { captureSessionOperation, queryClient, useSession } from '../../../lib/session';
import type { FitnessSpace } from '../fitness-model';
import { loadOfficialCatalog } from '../official-catalog';
import {
  buildTransferPreview,
  detectTransferExercise,
  detectTransferMapping,
  encodeTransferCsv,
  encodeTransferJson,
  maxTransferBytes,
  parseTransferTable,
  transferExerciseNames,
  transferFields,
  type FieldMapping,
  type TransferPreview,
  type TransferTable,
} from './transfer-format';
import './transfer.css';

/** 请求和后续副作用必须同时属于原始账号与仍挂载的页面。 */
function captureTransferOperation(lifetime: AbortSignal) {
  const operation = captureSessionOperation();
  const signal = AbortSignal.any([lifetime, operation.signal]);
  const assertCurrent = () => {
    operation.assertCurrent();
    signal.throwIfAborted();
  };
  assertCurrent();
  return {
    client: operation.client,
    signal,
    assertCurrent,
    isCurrent() {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 文件只在当前浏览器读取；预览后调用原子导入，失败保留同一份记录以便安全重试。 */
export function FitnessTransferDialog({ space, onClose }: { space: FitnessSpace; onClose: () => void }) {
  const { session } = useSession();
  const [mode, setMode] = useState<'import' | 'export'>('import');
  const [format, setFormat] = useState<'json' | 'csv'>('json');
  const [table, setTable] = useState<TransferTable | null>(null);
  const [mapping, setMapping] = useState<FieldMapping>({});
  const [exerciseMapping, setExerciseMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replacePreferences, setReplacePreferences] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileTime, setFileTime] = useState(new Date().toISOString());
  const [result, setResult] = useState('');
  const [page, setPage] = useState(0);
  const readGeneration = useRef(0);
  const lifecycle = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, [session?.user.user_id, space.id, space.sync_id]);
  const catalog = useQuery({
    queryKey: ['fitness-catalog'],
    queryFn: ({ signal }) => loadOfficialCatalog(signal),
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
    enabled: mode === 'import',
  });
  const download = useMutation({
    mutationFn: async () => {
      const operation = captureTransferOperation(lifecycle.current.signal);
      try {
        const response = unwrap(
          await operation.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/export', {
            params: { path: { fitness_space_id: space.id }, query: { sync_id: space.sync_id } },
            signal: operation.signal,
          }),
        );
        operation.assertCurrent();
        const contents = format === 'csv' ? encodeTransferCsv(response.records) : encodeTransferJson(response.records);
        if (new TextEncoder().encode(contents).byteLength > maxTransferBytes)
          throw new Error('完整导出超过 64 MiB，请使用客户端备份功能。');
        const blob = new Blob([contents], {
          type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
        });
        operation.assertCurrent();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        try {
          anchor.href = url;
          const safeName = Array.from(space.name, (character) =>
            character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character,
          ).join('');
          anchor.download = `健身-${safeName}-${new Date().toISOString().slice(0, 10)}.${format}`;
          document.body.append(anchor);
          anchor.click();
        } finally {
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        operation.assertCurrent();
        setResult(`已导出 ${response.records.length} 条完整记录。`);
      } catch (failure) {
        if (operation.isCurrent()) setError(failure);
        throw failure;
      }
    },
  });
  const submit = useMutation({
    mutationFn: async () => {
      const operation = captureTransferOperation(lifecycle.current.signal);
      try {
        if (!preview || selected.size === 0) throw new Error('请至少选择一条记录。');
        const records = preview.records.filter((record) => selected.has(record.id));
        if (records.some((record) => record.entity_type === 'fitness_preferences') && !replacePreferences)
          throw new Error('导入偏好前，请确认替换设置并保留目标已有自定义动作。');
        const response = unwrap(
          await operation.client.POST('/api/v1/fitness-spaces/{fitness_space_id}/import', {
            params: { path: { fitness_space_id: space.id } },
            body: {
              sync_id: space.sync_id,
              export_id: preview.exportId,
              records,
              replace_preferences: replacePreferences,
            },
            signal: operation.signal,
          }),
        );
        operation.assertCurrent();
        await queryClient.invalidateQueries({ queryKey: ['account', session?.user.user_id, 'fitness', space.id] });
        operation.assertCurrent();
        setResult(`导入完成：新增 ${response.imported} 条，已导入过 ${response.skipped} 条。`);
      } catch (failure) {
        if (operation.isCurrent()) setError(failure);
        throw failure;
      }
    },
  });
  const pending = busy || download.isPending || submit.isPending;
  /** 结构单元格是文件输入，解析失败保留字段映射界面，不能让渲染错误边界卸载整个页面。 */
  const exerciseSelection = useMemo(() => {
    try {
      return { names: table ? transferExerciseNames(table, mapping) : [], error: null };
    } catch (failure) {
      // JSON 异常消息可能包含文件原文，只记录异常类型及运行时调用帧。
      console.error('读取健身导入动作结构失败', {
        errorType: failure instanceof Error ? failure.name : typeof failure,
        stack:
          failure instanceof Error
            ? failure.stack
                ?.split('\n')
                .filter((line) => /^\s+at\s/.test(line))
                .join('\n')
            : undefined,
      });
      return {
        names: [],
        error: new Error('动作结构字段不是有效的 JSON，请检查文件或调整字段对应关系。'),
      };
    }
  }, [table, mapping]);
  const unresolved = exerciseSelection.names.filter(
    (name) => !name.startsWith('custom:') && catalog.data && !detectTransferExercise(name, catalog.data),
  );
  const pageSize = 20;

  /** 每次选择新文件都取消旧读取结果，避免较慢文件覆盖后选文件。 */
  async function readFile(file: File | undefined) {
    if (!file) return;
    const generation = ++readGeneration.current;
    let operation: ReturnType<typeof captureTransferOperation> | undefined;
    setError(null);
    setResult('');
    setPreview(null);
    setTable(null);
    setBusy(true);
    try {
      operation = captureTransferOperation(lifecycle.current.signal);
      if (file.size > maxTransferBytes) throw new Error('文件不能超过 64 MiB。');
      const contents = await file.text();
      operation.assertCurrent();
      if (generation !== readGeneration.current) return;
      const parsed = parseTransferTable(contents);
      if (!parsed.rows.length) throw new Error('文件没有可导入的记录。');
      setTable(parsed);
      setMapping(detectTransferMapping(parsed.headers));
      setExerciseMapping({});
      setFileName(file.name);
      setFileTime(new Date(file.lastModified).toISOString());
      setReplacePreferences(false);
    } catch (failure) {
      if (generation === readGeneration.current && operation?.isCurrent()) setError(failure);
    } finally {
      if (generation === readGeneration.current && operation?.isCurrent()) setBusy(false);
    }
  }

  /** 整体转换成功后再展示选择列表，不发送校验失败的半份内容。 */
  async function prepare() {
    if (!table || !catalog.data) return;
    const generation = ++readGeneration.current;
    let operation: ReturnType<typeof captureTransferOperation> | undefined;
    setBusy(true);
    setError(null);
    setResult('');
    try {
      operation = captureTransferOperation(lifecycle.current.signal);
      const next = await buildTransferPreview(table, mapping, catalog.data, exerciseMapping, fileTime);
      operation.assertCurrent();
      if (generation !== readGeneration.current) return;
      setPreview(next);
      setSelected(new Set(next.records.map((record) => record.id)));
      setPage(0);
    } catch (failure) {
      if (generation === readGeneration.current && operation?.isCurrent()) setError(failure);
    } finally {
      if (generation === readGeneration.current && operation?.isCurrent()) setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="健身数据导入与导出"
      description={`当前空间：${space.name}`}
      onClose={() => {
        if (!pending) {
          readGeneration.current++;
          onClose();
        }
      }}
    >
      <div className="fitness-form">
        <div className="fitness-transfer-tabs">
          <Button
            variant={mode === 'import' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'import'}
            disabled={pending}
            onClick={() => {
              setMode('import');
              setError(null);
              setResult('');
            }}
          >
            <FileUp size={16} />
            导入文件
          </Button>
          <Button
            variant={mode === 'export' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'export'}
            disabled={pending}
            onClick={() => {
              setMode('export');
              setError(null);
              setResult('');
            }}
          >
            <Download size={16} />
            导出数据
          </Button>
        </div>
        {mode === 'export' ? (
          <>
            <p className="fitness-muted">导出当前空间全部已同步数据。文件含私人信息，请妥善保管。</p>
            <Field
              label="导出格式"
              hint={format === 'csv' ? '复杂内容保留为 JSON 单元格，可再次完整导入。' : undefined}
            >
              <select
                value={format}
                disabled={pending}
                onChange={(event) => setFormat(event.target.value === 'csv' ? 'csv' : 'json')}
              >
                <option value="json">JSON · 完整数据</option>
                <option value="csv">CSV · 表格文件</option>
              </select>
            </Field>
            <Button
              disabled={pending}
              onClick={() => {
                setError(null);
                download.mutate();
              }}
            >
              {download.isPending ? '正在读取完整数据…' : '下载完整数据'}
            </Button>
          </>
        ) : (
          <>
            <Field label="选择健身文件" hint="支持客户端导出的 JSON 和自定义字段 CSV，最大 64 MiB。">
              <input
                type="file"
                accept=".json,.csv,application/json,text/csv"
                disabled={pending}
                onChange={(event) => void readFile(event.target.files?.[0])}
              />
            </Field>
            {table && !preview && (
              <>
                <p className="fitness-muted">
                  {fileName} · {table.rows.length} 行。请检查字段对应关系；平面表格的同名计划或训练会按日期分组。
                </p>
                <details className="fitness-help" open={table.format === 'csv'}>
                  <summary>字段对应关系</summary>
                  <div className="fitness-transfer-mapping">
                    {transferFields.map(([key, label]) => (
                      <Field key={key} label={label}>
                        <select
                          disabled={pending}
                          value={mapping[key] ?? ''}
                          onChange={(event) => setMapping({ ...mapping, [key]: event.target.value })}
                        >
                          <option value="">未指定 · 使用空值或默认值</option>
                          {table.headers.map((header) => (
                            <option key={header} value={header}>
                              {header}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ))}
                  </div>
                </details>
                {unresolved.length > 0 && (
                  <div className="fitness-form">
                    <h3>确认动作对应关系</h3>
                    <p className="fitness-muted">只有唯一的名称或动作编号会自动匹配。这里的选择应用于本次文件。</p>
                    {unresolved.map((name) => (
                      <Field key={name} label={`动作「${name}」`}>
                        <select
                          disabled={pending}
                          value={exerciseMapping[name] ?? ''}
                          onChange={(event) => setExerciseMapping({ ...exerciseMapping, [name]: event.target.value })}
                        >
                          <option value="">请选择动作</option>
                          {catalog.data?.exercises.map((exercise) => (
                            <option key={exercise.id} value={exercise.id}>
                              {exercise.name_zh} · {exercise.id}
                            </option>
                          ))}
                        </select>
                      </Field>
                    ))}
                  </div>
                )}
                {catalog.isError && <ErrorState error={catalog.error} retry={() => void catalog.refetch()} />}
                {exerciseSelection.error && <ErrorState error={exerciseSelection.error} />}
                <Button disabled={pending || !catalog.data || !!exerciseSelection.error} onClick={() => void prepare()}>
                  {busy ? '正在校验文件…' : catalog.isPending ? '正在读取动作库…' : '校验并预览'}
                </Button>
              </>
            )}
            {preview && (
              <>
                <p className="fitness-muted">导入为独立副本，不覆盖已有记录。重复导入同一文件会跳过已导入条目。</p>
                {preview.warnings.map((warning) => (
                  <p className="fitness-info" key={warning}>
                    {warning}
                  </p>
                ))}
                <div className="fitness-row">
                  <strong>
                    已选择 {selected.size} / {preview.records.length} 条
                  </strong>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      setSelected(
                        selected.size === preview.records.length
                          ? new Set()
                          : new Set(preview.records.map((record) => record.id)),
                      )
                    }
                  >
                    {selected.size === preview.records.length ? '取消全选' : '全选'}
                  </Button>
                </div>
                <div className="fitness-transfer-records">
                  {preview.records.slice(page * pageSize, (page + 1) * pageSize).map((record) => (
                    <label key={record.id}>
                      <input
                        type="checkbox"
                        disabled={pending}
                        checked={selected.has(record.id)}
                        onChange={(event) =>
                          setSelected((previous) => {
                            const next = new Set(previous);
                            if (event.target.checked) next.add(record.id);
                            else next.delete(record.id);
                            return next;
                          })
                        }
                      />
                      <span>
                        <strong>
                          {record.entity_type === 'fitness_preferences' ? '健身偏好与自定义动作' : record.payload.name}
                        </strong>
                        <small>
                          {
                            {
                              fitness_template: '训练模板',
                              fitness_plan: '训练计划',
                              fitness_workout: '训练记录',
                              fitness_preferences: '训练偏好',
                            }[record.entity_type]
                          }
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                {preview.records.length > pageSize && (
                  <nav className="plan-pagination" aria-label="导入记录分页">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending || page === 0}
                      onClick={() => setPage(page - 1)}
                    >
                      上一页
                    </Button>
                    <span>
                      {page + 1} / {Math.ceil(preview.records.length / pageSize)}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending || (page + 1) * pageSize >= preview.records.length}
                      onClick={() => setPage(page + 1)}
                    >
                      下一页
                    </Button>
                  </nav>
                )}
                {preview.records.some(
                  (record) => record.entity_type === 'fitness_preferences' && selected.has(record.id),
                ) && (
                  <label className="fitness-transfer-confirm">
                    <input
                      type="checkbox"
                      checked={replacePreferences}
                      disabled={pending}
                      onChange={(event) => setReplacePreferences(event.target.checked)}
                    />
                    <span>确认使用文件中的训练偏好（休息、声音、固定动作等），并保留此空间已有的自定义动作。</span>
                  </label>
                )}
                <div className="fitness-dialog-actions">
                  <Button
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      setPreview(null);
                      setError(null);
                      setResult('');
                    }}
                  >
                    返回映射
                  </Button>
                  <Button
                    disabled={pending || selected.size === 0}
                    onClick={() => {
                      setError(null);
                      submit.mutate();
                    }}
                  >
                    {submit.isPending ? '正在完整导入…' : '确认导入所选记录'}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {error !== null && <ErrorState error={error} />}
        {result && (
          <p role="status" className="fitness-notice">
            {result}
          </p>
        )}
      </div>
    </Dialog>
  );
}
