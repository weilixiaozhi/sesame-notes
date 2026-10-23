import { useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { CommonFields, Field } from './fields';
import { ReferencePicker } from './reference-picker';
import { contentName, resizePlanDays, type PlanContent, type References } from './model';

/** 周期按天配置模板或休息，新增天数默认休息且保持已有安排。 */
export function PlanFields({
  value,
  references,
  onChange,
}: {
  value: PlanContent;
  references?: References;
  onChange: (value: PlanContent) => void;
}) {
  const [selecting, setSelecting] = useState<number | null>(null);
  const [count, setCount] = useState(String(value.cycle_days));
  const [pickedNames, setPickedNames] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const names = new Map(references?.templates.map((item) => [item.id, item.name]));
  /** 缩短周期前明确确认将移除的训练安排，取消时不改变当前输入。 */
  function applyCount() {
    const next = Number(count);
    if (!Number.isInteger(next) || next < 1 || next > 36500) {
      setError('周期天数应为 1 至 36500 的整数。');
      return;
    }
    if (next < value.cycle_days && value.days.slice(next).some((day) => day.template_id)) {
      setPendingCount(next);
      return;
    }
    setError('');
    onChange(resizePlanDays(value, next));
  }
  return (
    <>
      <CommonFields value={value} onChange={(common) => onChange({ ...value, ...common })} />
      <div className="fitness-cycle-field">
        <Field label="周期天数">
          <input type="number" min={1} max={36500} value={count} onChange={(event) => setCount(event.target.value)} />
        </Field>
        <Button onClick={applyCount}>设置周期</Button>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <h3>每日安排</h3>
      <div className="fitness-plan-days">
        {value.days.map((day) => (
          <section className="fitness-plan-day" key={day.day_index}>
            <strong>第 {day.day_index + 1} 天</strong>
            <span>
              {day.template_id
                ? (pickedNames[day.template_id] ?? names.get(day.template_id) ?? '模板资料暂不可用')
                : '休息'}
            </span>
            <div className="row-actions">
              <Button onClick={() => setSelecting(day.day_index)}>{day.template_id ? '更换模板' : '选择模板'}</Button>
              {day.template_id && (
                <Button
                  onClick={() =>
                    onChange({
                      ...value,
                      days: value.days.map((current) =>
                        current.day_index === day.day_index ? { ...current, template_id: null } : current,
                      ),
                    })
                  }
                >
                  设为休息
                </Button>
              )}
            </div>
          </section>
        ))}
      </div>
      {selecting !== null && (
        <ReferencePicker
          kind="template"
          onClose={() => setSelecting(null)}
          onSelect={(row) => {
            setPickedNames({ ...pickedNames, [row.id]: contentName(row.content) });
            onChange({
              ...value,
              days: value.days.map((day) => (day.day_index === selecting ? { ...day, template_id: row.id } : day)),
            });
          }}
        />
      )}
      {pendingCount !== null && (
        <Modal title="缩短训练周期" onClose={() => setPendingCount(null)}>
          <div className="form-stack">
            <p>缩短为 {pendingCount} 天将移除超出天数的训练安排。</p>
            <div className="dialog-actions">
              <Button onClick={() => setPendingCount(null)}>取消</Button>
              <Button
                variant="primary"
                onClick={() => {
                  onChange(resizePlanDays(value, pendingCount));
                  setError('');
                  setPendingCount(null);
                }}
              >
                确认缩短
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
