import { describe, expect, it } from 'vitest';
import { calendarRange, durationLabel, periodRange, shiftPeriod, sumVolume } from './statistics-model';
import anatomy from './body-anatomy.json';

describe('健身统计日期与精确聚合', () => {
  it('周跨年从周一到周日，闰年自然月保留二月二十九日', () => {
    expect(periodRange('week', '2027-01-01')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
    expect(periodRange('month', '2028-02-29')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodRange('year', '2028-06-30')).toEqual({ start: '2028-01-01', end: '2028-12-31' });
  });
  it('月末导航不溢出跳月，日历包括完整跨月周', () => {
    expect(shiftPeriod('month', '2027-01-31', 1)).toBe('2027-02-01');
    expect(shiftPeriod('month', '2027-03-31', -1)).toBe('2027-02-01');
    const calendar = calendarRange('2028-02-29');
    expect(calendar.start).toBe('2028-01-31');
    expect(calendar.end).toBe('2028-03-05');
    expect(calendar.dates).toHaveLength(35);
    expect(new Set(calendar.dates).size).toBe(35);
  });
  it('大数和十位小数训练量不经过浮点', () => {
    expect(sumVolume(['9999999999999999990.1234567890', '10.8765432111'])).toBe('10000000000000000001.0000000001');
    expect(sumVolume(['0.1', '0.2'])).toBe('0.3');
    expect(durationLabel(3661000)).toBe('1 小时 1 分钟');
  });
  it('日期边界的日历范围不跨出四位年份，也不会在最后一日继续循环', () => {
    const first = calendarRange('0001-01-01');
    expect(first.start).toBe('0001-01-01');
    expect(first.dates[0]).toBe(first.start);
    const last = calendarRange('9999-12-31');
    expect(last.end).toBe('9999-12-31');
    expect(last.dates.at(-1)).toBe(last.end);
    expect(last.dates.length).toBeLessThanOrEqual(42);
    expect(last.dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))).toBe(true);
  });
  it('复用人体图保留前背肌群、镜像基础和源哈希', () => {
    expect(anatomy.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(anatomy.muscles.find((entry) => !entry.back && entry.muscle === 'pectorals')?.paths).toHaveLength(2);
    expect(anatomy.muscles.find((entry) => entry.back && entry.muscle === 'lats')?.paths).toHaveLength(1);
    expect(anatomy.muscles.find((entry) => !entry.back && entry.muscle === 'abs')?.paths).toHaveLength(6);
    expect(
      anatomy.muscles.every((entry) => entry.paths.every((path) => path.startsWith('M ') && path.endsWith(' Z'))),
    ).toBe(true);
  });
});
