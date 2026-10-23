import { useMemo, useState } from 'react';
import { useProductAnalyticsPage } from '../../lib/use-product-analytics';
import { LunarDay, SolarTerm } from 'tyme4ts';
import { Button, Dialog, Field } from '../../components/ui';
import { dateSpan, daysBetween, solarDate, todayDate, validateSolar } from './day-dates';

/** 日期偏移工具接受零天，结果越界时明确拒绝。 */
export function offsetDate(date: string, offset: number): string {
  validateSolar(date);
  if (!Number.isInteger(offset) || Math.abs(offset) > 36500) throw new Error('请输入 0 至 36500 的整数天数');
  return validateSolar(new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10));
}

/** 节日以真实公历日期排序，列表涵盖未来十二个月，不计算放假调休安排。 */
export function upcomingHolidays(today: string): Array<{ name: string; date: string }> {
  const { original_year: year, original_month: month, original_day: day } = solarDate(today);
  const maxDay = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  const end =
    year === 2100
      ? '2100-12-31'
      : `${year + 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, maxDay)).padStart(2, '0')}`;
  const dates: Array<{ name: string; date: string }> = [];
  const format = (date: { getYear: () => number; getMonth: () => number; getDay: () => number }) =>
    `${date.getYear()}-${String(date.getMonth()).padStart(2, '0')}-${String(date.getDay()).padStart(2, '0')}`;
  for (let current = year - 1; current <= Math.min(year + 1, 2100); current++) {
    if (current < 1900) continue;
    dates.push(
      { name: '元旦', date: `${current}-01-01` },
      { name: '劳动节', date: `${current}-05-01` },
      { name: '国庆节', date: `${current}-10-01` },
    );
    for (const [name, lunarMonth, lunarDay] of [
      ['春节', 1, 1],
      ['元宵节', 1, 15],
      ['端午节', 5, 5],
      ['七夕', 7, 7],
      ['中秋节', 8, 15],
      ['重阳节', 9, 9],
    ] as const) {
      dates.push({ name, date: format(LunarDay.fromYmd(current, lunarMonth, lunarDay).getSolarDay()) });
    }
    dates.push({ name: '清明节', date: format(SolarTerm.fromName(current, '清明').getSolarDay()) });
    const newYear = format(LunarDay.fromYmd(current + 1, 1, 1).getSolarDay());
    const eve = new Date(Date.parse(`${newYear}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    dates.push({ name: '除夕', date: eve });
  }
  return dates
    .filter((item) => item.date >= today && item.date < end)
    .sort((left, right) => left.date.localeCompare(right.date));
}

/** 纯日期工具不保存账号数据，所有结果都从当前输入即时推导。 */
export function DayTools({ onClose }: { onClose: () => void }) {
  useProductAnalyticsPage('days.tools');
  const [from, setFrom] = useState(todayDate);
  const [to, setTo] = useState(todayDate);
  const [count, setCount] = useState('30');
  const [tab, setTab] = useState<'difference' | 'offset' | 'holidays'>('difference');
  const holidays = useMemo(() => upcomingHolidays(todayDate()), []);
  let result = '';
  let error = '';
  try {
    if (tab === 'difference') {
      validateSolar(from);
      validateSolar(to);
      result = `相差 ${Math.abs(daysBetween(from, to))} 天 · ${dateSpan(from, to)}`;
    }
    if (tab === 'offset') {
      const amount = Number(count);
      if (!count || amount < 0) throw new Error('请输入非负整数天数');
      result = `向前：${offsetDate(from, -amount)} · 向后：${offsetDate(from, amount)}`;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : '请检查日期输入';
  }
  return (
    <Dialog open onClose={onClose} title="日期工具" description="按自然日计算。">
      <div className="stack">
        <div className="toolbar">
          <Button variant={tab === 'difference' ? 'primary' : 'secondary'} onClick={() => setTab('difference')}>
            日期差
          </Button>
          <Button variant={tab === 'offset' ? 'primary' : 'secondary'} onClick={() => setTab('offset')}>
            前后推算
          </Button>
          <Button variant={tab === 'holidays' ? 'primary' : 'secondary'} onClick={() => setTab('holidays')}>
            未来节日
          </Button>
        </div>
        {tab !== 'holidays' ? (
          <>
            <div className="form-grid">
              <Field label={tab === 'offset' ? '基准日期' : '开始日期'}>
                <input
                  type="date"
                  min="1901-01-01"
                  max="2100-12-31"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </Field>
              {tab === 'difference' ? (
                <Field label="结束日期">
                  <input
                    type="date"
                    min="1901-01-01"
                    max="2100-12-31"
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </Field>
              ) : (
                <Field label="间隔天数">
                  <input
                    type="number"
                    min={0}
                    max={36500}
                    step={1}
                    value={count}
                    onChange={(event) => setCount(event.target.value)}
                  />
                </Field>
              )}
            </div>
            <p className={error ? 'field-error' : 'panel'} role="status">
              {error || result}
            </p>
          </>
        ) : (
          <>
            <p className="muted">未来十二个月的节日日期，不代表法定放假与调休安排。</p>
            <ul className="holiday-list">
              {holidays.map((holiday) => (
                <li key={`${holiday.name}-${holiday.date}`}>
                  <span>{holiday.name}</span>
                  <time>{holiday.date}</time>
                  <span className="muted">{daysBetween(todayDate(), holiday.date)} 天后</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
