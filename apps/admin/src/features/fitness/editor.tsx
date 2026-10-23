import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, errorMessage, request } from '../../api/client';
import { queryClient } from '../../auth/session';
import { Button, Loading, Modal, RequestError } from '../../components/ui';
import { ExerciseFields } from './exercise-fields';
import { TemplateFields } from './template-fields';
import { PlanFields } from './plan-fields';
import { Field } from './fields';
import { saveFitness } from './data';
import {
  contentError,
  contentName,
  kindLabels,
  newContent,
  type ExerciseContent,
  type FitnessKind,
  type FitnessRow,
  type PlanContent,
  type TemplateContent,
} from './model';
import { taxonomyContentError, useTaxonomies } from './taxonomy-data';

/** 每次打开固定内容版本，二次确认后保存并立即生效，失败保留输入。 */
export function FitnessEditor({
  kind,
  current,
  onClose,
  onSaved,
}: {
  kind: FitnessKind;
  current?: FitnessRow;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [content, setContent] = useState(() => (current ? structuredClone(current.content) : newContent(kind)));
  const [enabled, setEnabled] = useState(current?.is_enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const lock = useRef(false);
  const bodyParts = useTaxonomies('body_part', kind === 'exercise');
  const equipment = useTaxonomies('equipment', kind !== 'plan');
  const taxonomiesPending = (kind === 'exercise' && bodyParts.isPending) || (kind !== 'plan' && equipment.isPending);
  const taxonomiesFailed = (kind === 'exercise' && bodyParts.isError) || (kind !== 'plan' && equipment.isError);
  const references = useQuery({
    queryKey: ['admin', 'fitness', 'references'],
    enabled: kind !== 'exercise',
    queryFn: ({ signal }) => request(() => api.adminFitnessReferences.list(signal), 'fitness-reference-list'),
  });
  /** 当前目录未成功读取时禁止保存，避免用缺失选项覆盖既有分类。 */
  function validateContent(): string | null {
    if (taxonomiesPending || taxonomiesFailed) return '请先成功加载部位和器械目录，再保存内容。';
    return (
      contentError(kind, content) ??
      taxonomyContentError(kind, content, bodyParts.data?.items ?? [], equipment.data?.items ?? [])
    );
  }
  /** 校验后提交当前版本，避免连续点击产生重复请求。 */
  async function submit() {
    if (lock.current || uploading) return;
    const invalid = validateContent();
    if (invalid) {
      setError(invalid);
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await saveFitness(kind, content, enabled, current);
      await onSaved();
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
      await queryClient.invalidateQueries({ queryKey: ['admin', 'fitness', 'taxonomies'] });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${current ? '修改' : '新增'}${kindLabels[kind]}`}
      onClose={onClose}
      busy={busy || uploading}
      className="fitness-editor"
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirming) void submit();
          else {
            const invalid = validateContent();
            setError(invalid ?? '');
            if (!invalid) setConfirming(true);
          }
        }}
      >
        <fieldset
          className="fitness-editor-fields form-stack"
          hidden={confirming}
          disabled={busy || uploading || confirming}
        >
          {references.isError && <RequestError error={references.error} retry={() => void references.refetch()} />}
          {kind === 'exercise' && bodyParts.isError && (
            <RequestError error={bodyParts.error} retry={() => void bodyParts.refetch()} />
          )}
          {kind !== 'plan' && equipment.isError && (
            <RequestError error={equipment.error} retry={() => void equipment.refetch()} />
          )}
          {taxonomiesPending && <Loading label="正在读取部位和器械…" />}
          {kind === 'exercise' ? (
            <ExerciseFields
              value={content as ExerciseContent}
              onChange={setContent}
              onUploading={setUploading}
              bodyParts={bodyParts.data?.items ?? []}
              equipment={equipment.data?.items ?? []}
            />
          ) : kind === 'template' ? (
            <TemplateFields
              value={content as TemplateContent}
              references={references.data}
              onChange={setContent}
              equipment={equipment.data?.items ?? []}
            />
          ) : (
            <PlanFields value={content as PlanContent} references={references.data} onChange={setContent} />
          )}
          <Field label="状态">
            <select
              value={enabled ? 'enabled' : 'disabled'}
              onChange={(event) => setEnabled(event.target.value === 'enabled')}
            >
              <option value="enabled">启用</option>
              <option value="disabled">停用</option>
            </select>
          </Field>
        </fieldset>
        {confirming && (
          <section className="form-stack" aria-label="确认保存">
            <strong>{contentName(content)}</strong>
            <p>确认保存此{kindLabels[kind]}？保存后立即更新到应用。</p>
            <span>状态：{enabled ? '启用' : '停用'}</span>
          </section>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <Button disabled={busy || uploading} onClick={() => (confirming ? setConfirming(false) : onClose())}>
            {confirming ? '返回修改' : '取消'}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || uploading || taxonomiesPending || taxonomiesFailed}>
            {busy ? '保存中…' : confirming ? '确认保存' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
