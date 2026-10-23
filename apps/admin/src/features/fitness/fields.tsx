import type { ReactNode } from 'react';
import type { CommonContent, Localized } from './model';
import { difficultyLabels } from './model';

/** 可见标签始终包裹真实输入，键盘与读屏使用同一名称。 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
    </label>
  );
}

/** 换行代表有序条目，编辑期间保留空行以便连续输入。 */
export function Lines({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  required?: boolean;
}) {
  return (
    <Field label={`${label}（每行一项）`}>
      <textarea
        required={required}
        value={value.join('\n')}
        onChange={(event) => onChange(event.target.value.split('\n'))}
      />
    </Field>
  );
}

/** 同一业务字段的三种语言并列编辑，避免把内容隐藏在原始 JSON 中。 */
function LocalizedFields({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: Localized;
  onChange: (value: Localized) => void;
  multiline?: boolean;
}) {
  return (
    <div className="fitness-form-grid">
      {(
        [
          ['zh', '简体中文'],
          ['zh_hant', '繁体中文'],
          ['en', '英文'],
        ] as const
      ).map(([key, language]) => (
        <Field key={key} label={`${label} · ${language}`}>
          {multiline ? (
            <textarea
              required
              value={value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            />
          ) : (
            <input
              required
              maxLength={key === 'en' ? 1000 : 500}
              value={value[key]}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            />
          )}
        </Field>
      ))}
    </div>
  );
}

/** 模板和计划共用内容字段，排班与动作编排由各自编辑器处理。 */
export function CommonFields({ value, onChange }: { value: CommonContent; onChange: (value: CommonContent) => void }) {
  return (
    <>
      <LocalizedFields label="标题" value={value.name} onChange={(name) => onChange({ ...value, name })} />
      <LocalizedFields
        label="说明"
        value={value.description}
        onChange={(description) => onChange({ ...value, description })}
        multiline
      />
      <Field label="难度">
        <select
          value={value.difficulty}
          onChange={(event) => onChange({ ...value, difficulty: event.target.value as CommonContent['difficulty'] })}
        >
          {Object.entries(difficultyLabels).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className="fitness-form-grid">
        {(
          [
            ['zh', '简体中文'],
            ['zh_hant', '繁体中文'],
            ['en', '英文'],
          ] as const
        ).map(([key, language]) => (
          <Lines
            key={key}
            label={`训练目标 · ${language}`}
            value={value.goals[key]}
            onChange={(goals) => onChange({ ...value, goals: { ...value.goals, [key]: goals } })}
            required
          />
        ))}
      </div>
    </>
  );
}
