import { useRef, useState } from 'react';
import { api, errorMessage, request } from '../../api/client';
import { Button } from '../../components/ui';
import { Field, Lines } from './fields';
import { exerciseMedia, type ExerciseContent } from './model';
import { availableTaxonomies, taxonomyName, type TaxonomyRow } from './taxonomy-data';

/** 文件编码只用于本次上传，图片数据不会进入日志或浏览器持久存储。 */
async function encodeFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** 动作资料与 GIF 在确认保存后生效，上传失败保留当前输入。 */
export function ExerciseFields({
  value,
  onChange,
  onUploading,
  bodyParts,
  equipment,
}: {
  value: ExerciseContent;
  onChange: (value: ExerciseContent) => void;
  onUploading: (busy: boolean) => void;
  bodyParts: TaxonomyRow[];
  equipment: TaxonomyRow[];
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const uploadLock = useRef(false);
  const media = exerciseMedia(value);
  const bodyOptions = availableTaxonomies(bodyParts, 'body_part');
  const equipmentOptions = availableTaxonomies(equipment, 'equipment');
  /** 限制本地文件体积并保留当前素材，服务器验证成功后再更新引用。 */
  async function upload(file: File | undefined) {
    if (!file || uploadLock.current) return;
    if (!/\.gif$/i.test(file.name) || file.size > 10 * 1024 * 1024) {
      setError('请选择不超过 10 MB 的 GIF 文件。');
      return;
    }
    uploadLock.current = true;
    setUploading(true);
    onUploading(true);
    setError('');
    try {
      const result = await request(
        () =>
          encodeFile(file).then((data_base64) => api.adminFitnessMedia.upload({ filename: file.name, data_base64 })),
        'fitness-media-upload',
      );
      onChange({ ...value, media_id: result.id, gif_asset: '' });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      uploadLock.current = false;
      setUploading(false);
      onUploading(false);
    }
  }
  return (
    <>
      <div className="fitness-form-grid">
        {(
          [
            ['name_zh', '标题 · 简体中文'],
            ['name_zh_hant', '标题 · 繁体中文'],
            ['name_en', '标题 · 英文'],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              required
              maxLength={key === 'name_en' ? 300 : 200}
              value={value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            />
          </Field>
        ))}
      </div>
      <div className="fitness-form-grid">
        <Field label="部位">
          <select
            required
            value={value.body_part}
            onChange={(event) => onChange({ ...value, body_part: event.target.value })}
          >
            <option value="">请选择部位</option>
            {value.body_part && !bodyOptions.some((row) => row.id === value.body_part) && (
              <option value={value.body_part} disabled>
                {taxonomyName(bodyParts, value.body_part)}，请重新选择
              </option>
            )}
            {bodyOptions.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name.zh}
              </option>
            ))}
          </select>
        </Field>
        <Field label="器械">
          <select
            required
            value={value.equipment}
            onChange={(event) => onChange({ ...value, equipment: event.target.value })}
          >
            <option value="">请选择器械</option>
            {value.equipment && !equipmentOptions.some((row) => row.id === value.equipment) && (
              <option value={value.equipment} disabled>
                {taxonomyName(equipment, value.equipment)}，请重新选择
              </option>
            )}
            {equipmentOptions.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name.zh}
              </option>
            ))}
          </select>
        </Field>
        <Field label="主要肌群">
          <input
            required
            maxLength={100}
            value={value.target}
            onChange={(event) => onChange({ ...value, target: event.target.value })}
          />
        </Field>
      </div>
      <Lines
        label="次要肌群"
        value={value.secondary_muscles}
        onChange={(secondary_muscles) => onChange({ ...value, secondary_muscles })}
      />
      <div className="fitness-form-grid">
        {(
          [
            ['instructions_zh', '教学步骤 · 简体中文'],
            ['instructions_zh_hant', '教学步骤 · 繁体中文'],
            ['instructions_en', '教学步骤 · 英文'],
          ] as const
        ).map(([key, label]) => (
          <Lines
            key={key}
            label={label}
            required
            value={value[key]}
            onChange={(steps) => onChange({ ...value, [key]: steps })}
          />
        ))}
      </div>
      <section className="fitness-media-editor">
        <div>
          {media ? (
            <img className="fitness-media-preview" src={media} alt={`${value.name_zh || '动作'}演示`} />
          ) : (
            <div className="fitness-media-empty">尚未上传 GIF</div>
          )}
        </div>
        <div className="form-stack">
          <Field label="动作 GIF">
            <input
              type="file"
              accept="image/gif,.gif"
              disabled={uploading}
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </Field>
          <small>GIF 最大 10 MB，保存动作后生效。</small>
          {uploading && <span role="status">正在校验并上传…</span>}
          {value.media_id && (
            <Button disabled={uploading} onClick={() => onChange({ ...value, media_id: null, gif_asset: '' })}>
              移除素材
            </Button>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
