import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, request } from '../../api/client';
import { Modal, RequestError, StatusBadge } from '../../components/ui';
import {
  contentName,
  difficultyLabels,
  exerciseMedia,
  type ExerciseContent,
  type FitnessRow,
  type PlanContent,
  type TemplateContent,
} from './model';
import { taxonomyName, useTaxonomies } from './taxonomy-data';

/** 预览当前内容与多语言资料，完整动图仅在预览窗口加载。 */
export function FitnessPreview({ row, onClose }: { row: FitnessRow; onClose: () => void }) {
  const [language, setLanguage] = useState<'zh' | 'zh_hant' | 'en'>('zh');
  const [mediaFailed, setMediaFailed] = useState(false);
  const content = row.content;
  const bodyParts = useTaxonomies('body_part', row.kind === 'exercise');
  const equipment = useTaxonomies('equipment', row.kind !== 'plan');
  const references = useQuery({
    queryKey: ['admin', 'fitness', 'references'],
    enabled: row.kind !== 'exercise',
    queryFn: ({ signal }) => request(() => api.adminFitnessReferences.list(signal), 'fitness-reference-preview'),
  });
  const exercise = row.kind === 'exercise' ? (content as ExerciseContent) : null;
  const common = row.kind !== 'exercise' ? (content as TemplateContent | PlanContent) : null;
  const names = new Map(
    (row.kind === 'template' ? references.data?.exercises : references.data?.templates)?.map((item) => [
      item.id,
      item.name,
    ]),
  );
  return (
    <Modal
      title={`预览 · ${contentName(content)}`}
      titleAside={<StatusBadge enabled={row.is_enabled} enabledLabel="启用" disabledLabel="停用" />}
      onClose={onClose}
      className="fitness-preview"
    >
      <div className="form-stack">
        {references.isError && <RequestError error={references.error} retry={() => void references.refetch()} />}
        {row.kind === 'exercise' && bodyParts.isError && (
          <RequestError error={bodyParts.error} retry={() => void bodyParts.refetch()} />
        )}
        {row.kind !== 'plan' && equipment.isError && (
          <RequestError error={equipment.error} retry={() => void equipment.refetch()} />
        )}
        <div className="fitness-section-heading">
          <label className="field">
            语言
            <select value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>
              <option value="zh">简体中文</option>
              <option value="zh_hant">繁体中文</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
        {exercise && (
          <>
            <h3>
              {language === 'zh' ? exercise.name_zh : language === 'zh_hant' ? exercise.name_zh_hant : exercise.name_en}
            </h3>
            <div className="fitness-preview-meta">
              <span>部位：{taxonomyName(bodyParts.data?.items, exercise.body_part, language)}</span>
              <span>器械：{taxonomyName(equipment.data?.items, exercise.equipment, language)}</span>
              <span>主要肌群：{exercise.target}</span>
              <span>次要肌群：{exercise.secondary_muscles.join('、') || '未填写'}</span>
            </div>
            {exerciseMedia(exercise) && !mediaFailed ? (
              <img
                className="fitness-preview-animation"
                src={exerciseMedia(exercise)}
                alt={`${exercise.name_zh}演示`}
                onError={() => setMediaFailed(true)}
              />
            ) : (
              <p className="muted">{mediaFailed ? '素材暂时无法加载' : '未配置 GIF'}</p>
            )}
            <h3>教学步骤</h3>
            <ol className="fitness-instructions">
              {(language === 'zh'
                ? exercise.instructions_zh
                : language === 'zh_hant'
                  ? exercise.instructions_zh_hant
                  : exercise.instructions_en
              ).map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </>
        )}
        {common && (
          <>
            <h3>{common.name[language]}</h3>
            <p className="fitness-preserve-lines">{common.description[language]}</p>
            <div className="fitness-preview-meta">
              <span>难度：{difficultyLabels[common.difficulty]}</span>
              <span>训练目标：{common.goals[language].join('、')}</span>
            </div>
          </>
        )}
        {row.kind === 'template' && (
          <>
            <p>
              预计 {(content as TemplateContent).duration_minutes} 分钟 ·{' '}
              {(content as TemplateContent).equipment
                .map((entry) => taxonomyName(equipment.data?.items, entry, language))
                .join('、')}
            </p>
            <ol className="fitness-instructions">
              {(content as TemplateContent).exercises.map((entry, index) => (
                <li key={index}>
                  <strong>{names.get(entry.exercise_id) ?? '正在读取动作名称'}</strong>
                  <p>
                    {entry.sets} 组 × {entry.reps} 次 ·{' '}
                    {entry.weight_mode === 'body_weight'
                      ? '自重'
                      : `${entry.weight_mode === 'per_side' ? '单侧' : '总重'} ${entry.weight_kg} kg`}{' '}
                    · 休息 {entry.rest_seconds} 秒
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
        {row.kind === 'plan' && (
          <>
            <p>周期 {(content as PlanContent).cycle_days} 天</p>
            <div className="fitness-plan-days">
              {(content as PlanContent).days.map((day) => (
                <div className="fitness-plan-day" key={day.day_index}>
                  <strong>第 {day.day_index + 1} 天</strong>
                  <span>{day.template_id ? (names.get(day.template_id) ?? '正在读取模板名称') : '休息'}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
