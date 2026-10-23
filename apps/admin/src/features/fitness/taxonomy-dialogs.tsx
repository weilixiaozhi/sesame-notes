import { useRef, useState } from 'react';
import { api, InputError, request } from '../../api/client';
import { queryClient, useSession } from '../../auth/session';
import { Button, ConfirmDialog, Empty, Loading, Modal, RequestError } from '../../components/ui';
import { Field } from './fields';
import {
  availableTaxonomies,
  taxonomyFormSchema,
  taxonomyLabels,
  taxonomyReplacementError,
  useTaxonomies,
  type TaxonomyKind,
  type TaxonomyRow,
} from './taxonomy-data';
import type { Localized } from './model';

/** 分类写入失败也核对最新目录，避免并发冲突后继续展示旧引用数。 */
async function changeTaxonomy(operation: () => Promise<unknown>, context: string): Promise<void> {
  try {
    await request(operation, context);
  } finally {
    await queryClient.invalidateQueries({ queryKey: ['admin', 'fitness'] });
  }
}

/** 动作库内管理部位和器械，读取权限允许查看，写入入口仍独立受控。 */
export function TaxonomyManager({ kind, onClose }: { kind: TaxonomyKind; onClose: () => void }) {
  const query = useTaxonomies(kind);
  const write = useSession().session?.admin.permissions.includes('fitness:write');
  const [dialog, setDialog] = useState<{ mode: 'edit' | 'delete'; row?: TaxonomyRow } | null>(null);
  const [notice, setNotice] = useState('');
  const rows = availableTaxonomies(query.data?.items, kind);
  return (
    <>
      <Modal title={`${taxonomyLabels[kind]}管理`} onClose={onClose} className="fitness-taxonomy-manager">
        <div className="form-stack">
          <div className="fitness-section-heading">
            <p>名称和排序会同步用于动作与训练模板。</p>
            {write && (
              <Button
                variant="primary"
                onClick={() => {
                  setNotice('');
                  setDialog({ mode: 'edit' });
                }}
              >
                新增{taxonomyLabels[kind]}
              </Button>
            )}
          </div>
          {notice && (
            <div role="status" className="notice">
              {notice}
            </div>
          )}
          {query.isPending ? (
            <Loading />
          ) : query.isError ? (
            <RequestError error={query.error} retry={() => void query.refetch()} />
          ) : rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>排序</th>
                    <th>动作引用</th>
                    <th>模板引用</th>
                    {write && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td data-label="名称">
                        <strong>{row.name.zh}</strong>
                        <small className="fitness-table-subtitle">
                          {row.name.zh_hant} · {row.name.en}
                        </small>
                      </td>
                      <td data-label="排序">{row.sort_order}</td>
                      <td data-label="动作引用">{row.exercise_count}</td>
                      <td data-label="模板引用">{row.template_count}</td>
                      {write && (
                        <td data-label="操作">
                          <div className="row-actions">
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setNotice('');
                                setDialog({ mode: 'edit', row });
                              }}
                            >
                              修改
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setNotice('');
                                setDialog({ mode: 'delete', row });
                              }}
                            >
                              删除
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>暂无{taxonomyLabels[kind]}，可新增后用于动作与模板。</Empty>
          )}
        </div>
      </Modal>
      {write && dialog?.mode === 'edit' && (
        <TaxonomyEditor kind={kind} current={dialog.row} onClose={() => setDialog(null)} onSaved={setNotice} />
      )}
      {write && dialog?.mode === 'delete' && dialog.row && (
        <TaxonomyDelete
          row={dialog.row}
          rows={query.data?.items ?? []}
          onClose={() => setDialog(null)}
          onSaved={setNotice}
        />
      )}
    </>
  );
}

/** 名称和排序与操作原因一次提交，修改携带打开弹窗时的分类版本。 */
export function TaxonomyEditor({
  kind,
  current,
  onClose,
  onSaved,
}: {
  kind: TaxonomyKind;
  current?: TaxonomyRow;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState<Localized>(() => (current ? { ...current.name } : { zh: '', zh_hant: '', en: '' }));
  const [sort, setSort] = useState(String(current?.sort_order ?? 0));
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const label = taxonomyLabels[kind];
  /** 验证三种语言和排序，服务端成功后再让所有分类引用刷新。 */
  async function save(reason: string) {
    if (lock.current) return;
    const parsed = taxonomyFormSchema.safeParse({ name, sort_order: sort.trim() ? Number(sort) : Number.NaN });
    if (!parsed.success) throw new InputError(parsed.error.issues[0]?.message || '请检查名称和排序。');
    lock.current = true;
    setBusy(true);
    try {
      await changeTaxonomy(
        () =>
          current
            ? api.adminFitnessTaxonomies.update(kind, current.id, { ...parsed.data, version: current.version, reason })
            : api.adminFitnessTaxonomies.create(kind, { ...parsed.data, reason }),
        `fitness-${kind}-save`,
      );
      onSaved(`${label}已${current ? '更新' : '新增'}。`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <ConfirmDialog
      title={`${current ? '修改' : '新增'}${label}`}
      confirmText={`保存${label}`}
      danger={false}
      onConfirm={save}
      onClose={onClose}
    >
      {(
        [
          ['zh', '简体中文名称'],
          ['zh_hant', '繁体中文名称'],
          ['en', '英文名称'],
        ] as const
      ).map(([language, title]) => (
        <Field key={language} label={title}>
          <input
            value={name[language]}
            disabled={busy}
            maxLength={100}
            onChange={(event) => setName({ ...name, [language]: event.target.value })}
          />
        </Field>
      ))}
      <Field label="排序">
        <input
          type="number"
          min={0}
          max={9999}
          step={1}
          value={sort}
          disabled={busy}
          onChange={(event) => setSort(event.target.value)}
        />
      </Field>
      <small>数值越小，显示越靠前。</small>
    </ConfirmDialog>
  );
}

/** 引用中的分类先迁移到有效替代项，再删除分类本身，动作和模板保持保留。 */
export function TaxonomyDelete({
  row,
  rows,
  onClose,
  onSaved,
}: {
  row: TaxonomyRow;
  rows: TaxonomyRow[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const referenced = row.exercise_count + row.template_count > 0;
  const options = availableTaxonomies(rows, row.kind).filter((candidate) => candidate.id !== row.id);
  /** 按当前版本确认替代关系，引用变化由服务端拒绝并要求重新核对。 */
  async function remove(reason: string) {
    if (lock.current) return;
    const invalid = taxonomyReplacementError(row, replacement, rows);
    if (invalid) throw new InputError(invalid);
    lock.current = true;
    setBusy(true);
    try {
      await changeTaxonomy(
        () =>
          api.adminFitnessTaxonomies.delete(row.kind, row.id, {
            version: row.version,
            replacement_id: replacement || undefined,
            reason,
          }),
        `fitness-${row.kind}-delete`,
      );
      onSaved(`${taxonomyLabels[row.kind]}已删除${referenced ? '，相关引用已迁移' : ''}。`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <ConfirmDialog
      title={`删除${taxonomyLabels[row.kind]}`}
      confirmText="确认删除"
      onConfirm={remove}
      onClose={onClose}
      confirmDisabled={referenced && !options.length}
    >
      <div className="impact">
        <strong>{row.name.zh}</strong>
        <p>
          {row.exercise_count} 个动作 · {row.template_count} 个模板正在引用
        </p>
      </div>
      {referenced ? (
        <>
          <p>
            请先选择替代{taxonomyLabels[row.kind]}
            。确认后，相关动作和模板会迁移到替代项，再删除此分类；动作、模板和历史训练记录保留。
          </p>
          {options.length ? (
            <Field label={`替代${taxonomyLabels[row.kind]}`}>
              <select value={replacement} disabled={busy} onChange={(event) => setReplacement(event.target.value)}>
                <option value="">请选择替代项</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name.zh}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div role="status" className="notice">
              暂无可用的替代项，请先新增同类型分类后再删除。
            </div>
          )}
        </>
      ) : (
        <p>此分类当前未被动作或模板引用，确认后将从选项中移除。已有动作、模板和历史训练记录保留。</p>
      )}
    </ConfirmDialog>
  );
}
