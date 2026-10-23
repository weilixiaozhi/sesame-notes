import { useState } from 'react';
import { Button } from '../../components/ui';
import { CommonFields, Field } from './fields';
import { ReferencePicker } from './reference-picker';
import { contentName, type References, type TemplateContent, type TemplateExercise } from './model';
import { availableTaxonomies, taxonomyName, type TaxonomyRow } from './taxonomy-data';

/** 模板动作编排保留顺序与重复动作，不改写用户已经导入的训练副本。 */
export function TemplateFields({
  value,
  references,
  onChange,
  equipment,
}: {
  value: TemplateContent;
  references?: References;
  onChange: (value: TemplateContent) => void;
  equipment: TaxonomyRow[];
}) {
  const [adding, setAdding] = useState(false);
  const [pickedNames, setPickedNames] = useState<Record<string, string>>({});
  const names = new Map(references?.exercises.map((item) => [item.id, item.name]));
  const options = availableTaxonomies(equipment, 'equipment');
  const unavailable = value.equipment.filter((id) => !options.some((row) => row.id === id));
  /** 修改单行动作参数，不改变其余动作及位置。 */
  function update(index: number, patch: Partial<TemplateExercise>) {
    onChange({
      ...value,
      exercises: value.exercises.map((entry, current) => (current === index ? { ...entry, ...patch } : entry)),
    });
  }
  /** 只交换相邻位置，保持动作参数一起移动。 */
  function move(index: number, direction: number) {
    const next = [...value.exercises];
    const other = index + direction;
    if (!next[index] || !next[other]) return;
    [next[index], next[other]] = [next[other]!, next[index]!];
    onChange({ ...value, exercises: next });
  }
  return (
    <>
      <CommonFields value={value} onChange={(common) => onChange({ ...value, ...common })} />
      <Field label="预计时长（分钟）">
        <input
          required
          type="number"
          min={1}
          max={1440}
          value={value.duration_minutes}
          onChange={(event) => onChange({ ...value, duration_minutes: Number(event.target.value) })}
        />
      </Field>
      <fieldset className="fitness-equipment">
        <legend>所需器械</legend>
        {options.map(({ id, name }) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={value.equipment.includes(id)}
              onChange={(event) =>
                onChange({
                  ...value,
                  equipment: event.target.checked
                    ? [...value.equipment, id]
                    : value.equipment.filter((entry) => entry !== id),
                })
              }
            />
            {name.zh}
          </label>
        ))}
        {unavailable.map((id) => (
          <label key={id}>
            <input
              type="checkbox"
              checked
              onChange={() => onChange({ ...value, equipment: value.equipment.filter((entry) => entry !== id) })}
            />
            {taxonomyName(equipment, id)}（请取消并重新选择）
          </label>
        ))}
        {!options.length && <p className="muted">暂无可用器械，请先到动作库的器械管理中新增。</p>}
      </fieldset>
      <div className="fitness-section-heading">
        <h3>训练动作</h3>
        <Button onClick={() => setAdding(true)}>添加动作</Button>
      </div>
      {!value.exercises.length && <p className="muted">尚未添加动作</p>}
      <div className="fitness-sequence">
        {value.exercises.map((entry, index) => (
          <section className="fitness-sequence-item" key={index}>
            <div className="fitness-section-heading">
              <strong>
                {index + 1}. {pickedNames[entry.exercise_id] ?? names.get(entry.exercise_id) ?? '动作资料暂不可用'}
              </strong>
              <div className="row-actions">
                <Button aria-label={`上移动作 ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}>
                  上移
                </Button>
                <Button
                  aria-label={`下移动作 ${index + 1}`}
                  disabled={index === value.exercises.length - 1}
                  onClick={() => move(index, 1)}
                >
                  下移
                </Button>
                <Button
                  onClick={() =>
                    onChange({ ...value, exercises: value.exercises.filter((_, current) => current !== index) })
                  }
                >
                  移除
                </Button>
              </div>
            </div>
            <div className="fitness-exercise-parameters">
              <Field label="组数">
                <input
                  type="number"
                  required
                  min={1}
                  max={1000}
                  value={entry.sets}
                  onChange={(event) => update(index, { sets: Number(event.target.value) })}
                />
              </Field>
              <Field label="每组次数">
                <input
                  type="number"
                  required
                  min={1}
                  value={entry.reps}
                  onChange={(event) => update(index, { reps: Number(event.target.value) })}
                />
              </Field>
              <Field label="重量方式">
                <select
                  value={entry.weight_mode}
                  onChange={(event) => {
                    const mode = event.target.value as TemplateExercise['weight_mode'];
                    update(index, {
                      weight_mode: mode,
                      weight_kg: mode === 'body_weight' ? null : (entry.weight_kg ?? '0'),
                    });
                  }}
                >
                  <option value="body_weight">自重</option>
                  <option value="total">总重</option>
                  <option value="per_side">单侧</option>
                </select>
              </Field>
              <Field label="重量（kg）">
                <input
                  inputMode="decimal"
                  disabled={entry.weight_mode === 'body_weight'}
                  value={entry.weight_kg ?? ''}
                  onChange={(event) => update(index, { weight_kg: event.target.value })}
                />
              </Field>
              <Field label="组间休息（秒）">
                <input
                  required
                  type="number"
                  min={0}
                  value={entry.rest_seconds}
                  onChange={(event) => update(index, { rest_seconds: Number(event.target.value) })}
                />
              </Field>
            </div>
          </section>
        ))}
      </div>
      {adding && (
        <ReferencePicker
          kind="exercise"
          onClose={() => setAdding(false)}
          onSelect={(row) => {
            setPickedNames({ ...pickedNames, [row.id]: contentName(row.content) });
            onChange({
              ...value,
              exercises: [
                ...value.exercises,
                {
                  exercise_id: row.id,
                  sets: 3,
                  reps: 12,
                  weight_mode: 'body_weight',
                  weight_kg: null,
                  rest_seconds: 90,
                },
              ],
            });
          }}
        />
      )}
    </>
  );
}
