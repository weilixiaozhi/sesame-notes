import { useState, type ReactNode } from 'react';
import { Button } from '../../components/ui';
import { reportError } from '../../api/client';
import { PLATFORMS, type AnalyticsRange, type Platform } from './model';

type RangePreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom';
const DAY_MS = 86_400_000;
const PRESETS: Record<RangePreset, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '近 7 天',
  month: '近 30 天',
  custom: '自定义',
};

/** 北京自然日只按日期计算，不受电脑时区或夏令时影响。 */
export function presetRange(preset: Exclude<RangePreset, 'custom'> = 'week', now = new Date()): AnalyticsRange {
  const today = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  const end = new Date(`${today}T00:00:00Z`);
  if (preset === 'yesterday') end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end.getTime() - (preset === 'week' ? 6 : preset === 'month' ? 29 : 0) * DAY_MS);
  return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10), platform: 'all' };
}

/** 反查日期以拒绝自动进位，并限制查询跨度与现有服务端一致。 */
export function validateRange(range: AnalyticsRange, now = new Date()): AnalyticsRange {
  try {
    const values = [range.start_date, range.end_date].map((value) => {
      const stamp = Date.parse(`${value}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(stamp) ||
        new Date(stamp).toISOString().slice(0, 10) !== value
      )
        throw new Error('请选择有效的起止日期。');
      return stamp;
    });
    const days = (values[1]! - values[0]!) / DAY_MS + 1;
    if (days < 1 || days > 3660) throw new Error('结束日期不能早于开始日期，单次查询最长十年。');
    if (range.end_date > presetRange('today', now).end_date) throw new Error('结束日期不能晚于今天。');
    if (!Object.hasOwn(PLATFORMS, range.platform)) throw new Error('请选择有效来源。');
    return { ...range };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('日期范围不可用，请重新选择。', { cause: error });
  }
}

/** 全局日期和来源在提交后同步生效，防止筛选草稿与结果口径混用。 */
export function DateRangeBar({
  value,
  onSubmit,
  busy = false,
  onChange,
  children,
}: {
  value: AnalyticsRange;
  onSubmit: (range: AnalyticsRange) => void;
  busy?: boolean;
  onChange?: (range: AnalyticsRange) => void;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const [preset, setPreset] = useState<RangePreset>(() => {
    for (const key of ['today', 'yesterday', 'week', 'month'] as const) {
      const candidate = presetRange(key);
      if (candidate.start_date === value.start_date && candidate.end_date === value.end_date) return key;
    }
    return 'custom';
  });
  const [error, setError] = useState('');
  const today = presetRange('today').end_date;
  /** 日期、来源与附加条件共用一次提交，草稿变更可同步收窄事件候选。 */
  function changeRange(next: AnalyticsRange): void {
    setDraft(next);
    onChange?.(next);
    setError('');
  }
  /** 选择快捷范围时保留当前来源，等待统一提交。 */
  function changePreset(next: RangePreset): void {
    try {
      setPreset(next);
      if (next !== 'custom') changeRange({ ...presetRange(next), platform: draft.platform });
      setError('');
    } catch (failure) {
      reportError('analytics-date-preset', failure);
      setError('日期范围暂时不可用，请手动选择。');
    }
  }
  /** 只在用户提交有效日期后发起查询，重复提交同一范围也刷新数据。 */
  function submit(): void {
    try {
      onSubmit(validateRange(draft));
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '日期范围无效。');
    }
  }
  return (
    <form
      className="analytics-range-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="analytics-range-fields">
        <label className="field">
          时间范围
          <select value={preset} onChange={(event) => changePreset(event.target.value as RangePreset)}>
            {Object.entries(PRESETS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          开始日期
          <input
            type="date"
            required
            value={draft.start_date}
            max={today}
            onChange={(event) => {
              setPreset('custom');
              changeRange({ ...draft, start_date: event.target.value });
            }}
          />
        </label>
        <label className="field">
          结束日期
          <input
            type="date"
            required
            value={draft.end_date}
            max={today}
            onChange={(event) => {
              setPreset('custom');
              changeRange({ ...draft, end_date: event.target.value });
            }}
          />
        </label>
        <label className="field">
          来源
          <select
            value={draft.platform}
            onChange={(event) => changeRange({ ...draft, platform: event.target.value as Platform })}
          >
            {Object.entries(PLATFORMS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {children && <div className="analytics-query-fields">{children}</div>}
      <div className="analytics-query-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? '查询中…' : '查询'}
        </Button>
        <span className="muted">北京时间</span>
      </div>
      {error && (
        <p role="alert" className="form-error analytics-filter-error">
          {error}
        </p>
      )}
    </form>
  );
}
