import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, errorMessage, request } from '../../api/client';
import { dateTime, initialPaging, type Paging } from '../../api/types';
import { useClampPage } from '../../api/paging';
import { useListQuerySubmit } from '../../lib/use-list-query-submit';
import { queryClient, useSession } from '../../auth/session';
import { Button, Empty, Loading, Modal, Pagination, RequestError, StatusBadge } from '../../components/ui';
import { FitnessEditor } from './editor';
import { FitnessPreview } from './preview';
import { listFitness } from './data';
import {
  contentName,
  exerciseMedia,
  kindLabels,
  pageLabels,
  type ExerciseContent,
  type FitnessKind,
  type FitnessRow,
  type PlanContent,
  type TemplateContent,
} from './model';
import { taxonomyName, useTaxonomies, type TaxonomyKind } from './taxonomy-data';
import { TaxonomyManager } from './taxonomy-dialogs';
import './fitness.css';

/** 保存结果同步刷新三个列表与引用选项。 */
async function refreshFitness() {
  await queryClient.invalidateQueries({ queryKey: ['admin', 'fitness'] });
}

/** 三类官方内容各自保留查询与页码，操作权限由当前后台会话提供。 */
export function FitnessManagementPage({ kind, active }: { kind: FitnessKind; active: boolean }) {
  const { session } = useSession();
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<{ mode: 'edit' | 'preview' | 'toggle'; row?: FitnessRow } | null>(null);
  const [taxonomy, setTaxonomy] = useState<TaxonomyKind | null>(null);
  const bodyParts = useTaxonomies('body_part', active && kind === 'exercise');
  const equipment = useTaxonomies('equipment', active && kind === 'exercise');
  const queryKey = ['admin', 'fitness', kind, 'list', search, paging];
  const submitQuery = useListQuerySubmit(queryKey, active);
  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: ({ signal }) => listFitness(kind, { ...paging, q: search || undefined }, signal),
  });
  useClampPage(query.data?.total, paging, setPaging);
  const write = session?.admin.permissions.includes('fitness:write');
  return (
    <>
      <div className="page-heading">
        <h1>{pageLabels[kind]}</h1>
        <div className="row-actions">
          {kind === 'exercise' && (
            <>
              <Button onClick={() => setTaxonomy('body_part')}>部位管理</Button>
              <Button onClick={() => setTaxonomy('equipment')}>器械管理</Button>
            </>
          )}
          {write && (
            <Button variant="primary" onClick={() => setDialog({ mode: 'edit' })}>
              新增{kindLabels[kind]}
            </Button>
          )}
        </div>
      </div>
      <section className="panel">
        {kind === 'exercise' && bodyParts.isError && (
          <RequestError error={bodyParts.error} retry={() => void bodyParts.refetch()} />
        )}
        {kind === 'exercise' && equipment.isError && (
          <RequestError error={equipment.error} retry={() => void equipment.refetch()} />
        )}
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const nextSearch = input.trim();
            const nextPaging = { ...paging, page: 1 };
            submitQuery(['admin', 'fitness', kind, 'list', nextSearch, nextPaging], () => {
              setSearch(nextSearch);
              setPaging(nextPaging);
            });
          }}
        >
          <label className="field search-field">
            名称
            <input value={input} onChange={(event) => setInput(event.target.value)} />
          </label>
          <Button type="submit" variant="primary" disabled={query.isFetching}>
            查询
          </Button>
          <Button
            onClick={() => {
              setInput('');
              setSearch('');
              setPaging(initialPaging);
            }}
          >
            重置
          </Button>
        </form>
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <RequestError error={query.error} retry={() => void query.refetch()} />
        ) : !query.data.items.length ? (
          <Empty>没有匹配的{kindLabels[kind]}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {kind === 'exercise' && <th>动作 GIF</th>}
                  <th>名称</th>
                  <th>{kind === 'exercise' ? '部位 / 器械' : kind === 'template' ? '动作 / 时长' : '周期'}</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th>修改人</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((row) => (
                  <tr key={row.id}>
                    {kind === 'exercise' && (
                      <td data-label="动作 GIF">
                        <ExerciseThumbnail
                          value={row.content as ExerciseContent}
                          onPreview={() => setDialog({ mode: 'preview', row })}
                        />
                      </td>
                    )}
                    <td data-label="名称">
                      <Button variant="ghost" onClick={() => setDialog({ mode: 'preview', row })}>
                        {contentName(row.content)}
                      </Button>
                      {kind === 'exercise' && (
                        <small className="fitness-table-subtitle">{(row.content as ExerciseContent).name_en}</small>
                      )}
                    </td>
                    <td data-label="内容">
                      {kind === 'exercise'
                        ? `${taxonomyName(bodyParts.data?.items, (row.content as ExerciseContent).body_part)} / ${taxonomyName(equipment.data?.items, (row.content as ExerciseContent).equipment)}`
                        : kind === 'template'
                          ? `${(row.content as TemplateContent).exercises.length} 个动作 / ${(row.content as TemplateContent).duration_minutes} 分钟`
                          : `${(row.content as PlanContent).cycle_days} 天`}
                    </td>
                    <td data-label="状态">
                      <StatusBadge enabled={row.is_enabled} enabledLabel="启用" disabledLabel="停用" />
                    </td>
                    <td data-label="更新时间">{dateTime(row.updated_at)}</td>
                    <td data-label="修改人">{row.updated_by || '系统'}</td>
                    <td data-label="操作">
                      <div className="row-actions">
                        <Button variant="ghost" onClick={() => setDialog({ mode: 'preview', row })}>
                          预览
                        </Button>
                        {write && (
                          <>
                            <Button variant="ghost" onClick={() => setDialog({ mode: 'edit', row })}>
                              修改
                            </Button>
                            <Button variant="ghost" onClick={() => setDialog({ mode: 'toggle', row })}>
                              {row.is_enabled ? '停用' : '启用'}
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {query.data && (
          <Pagination value={paging} total={query.data.total} onChange={setPaging} disabled={query.isFetching} />
        )}
      </section>
      {write && dialog?.mode === 'edit' && (
        <FitnessEditor kind={kind} current={dialog.row} onClose={() => setDialog(null)} onSaved={refreshFitness} />
      )}
      {dialog?.mode === 'preview' && dialog.row && <FitnessPreview row={dialog.row} onClose={() => setDialog(null)} />}
      {write && dialog?.mode === 'toggle' && dialog.row && (
        <FitnessAction row={dialog.row} onClose={() => setDialog(null)} />
      )}
      {taxonomy && <TaxonomyManager kind={taxonomy} onClose={() => setTaxonomy(null)} />}
    </>
  );
}

/** 列表按需加载静态首帧，点击打开完整动图预览，失败时保留明确占位。 */
function ExerciseThumbnail({ value, onPreview }: { value: ExerciseContent; onPreview: () => void }) {
  const media = exerciseMedia(value);
  const source = media ? `${media}?preview=1` : undefined;
  const [failedSource, setFailedSource] = useState<string>();
  return (
    <button type="button" className="fitness-table-media" aria-label={`预览 ${value.name_zh}`} onClick={onPreview}>
      {source && failedSource !== source ? (
        <img
          src={source}
          alt={`${value.name_zh}动作演示`}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <span>{source ? '暂时无法加载' : '未配置 GIF'}</span>
      )}
    </button>
  );
}

/** 状态变更确认后立即生效，失败时保留弹窗并显示服务端诊断。 */
function FitnessAction({ row, onClose }: { row: FitnessRow; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const title = row.is_enabled ? '停用内容' : '启用内容';
  /** 请求只提交一次，服务器按绑定版本判断是否仍可执行。 */
  async function submit() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const client =
        row.kind === 'exercise'
          ? api.adminFitnessExercises
          : row.kind === 'template'
            ? api.adminFitnessTemplates
            : api.adminFitnessPlans;
      await request<FitnessRow>(
        () => client.update(row.id, { version: row.version, is_enabled: !row.is_enabled }),
        'fitness-status-save',
      );
      await refreshFitness();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title={title} busy={busy} onClose={onClose}>
      <div className="form-stack">
        <strong>{contentName(row.content)}</strong>
        <p>确认{row.is_enabled ? '停用' : '启用'}此内容？确认后立即生效，历史训练记录保留。</p>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '确认'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
