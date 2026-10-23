import { describe, expect, it } from 'vitest';
import { offsetDate, upcomingHolidays } from './day-tools';

describe('日期工具', () => {
  it('零天和跨闰月偏移准确', () => {
    expect(offsetDate('2024-02-28', 0)).toBe('2024-02-28');
    expect(offsetDate('2024-02-28', 2)).toBe('2024-03-01');
    expect(offsetDate('2024-03-01', -1)).toBe('2024-02-29');
  });
  it('不钳制越界结果或接受小数', () => {
    expect(() => offsetDate('1901-01-01', -1)).toThrow();
    expect(() => offsetDate('2100-12-31', 1)).toThrow();
    expect(() => offsetDate('2026-01-01', 0.5)).toThrow();
  });
  it('未来节日包含准确的春节、清明和除夕', () => {
    const holidays = upcomingHolidays('2026-01-01');
    expect(holidays).toContainEqual({ name: '春节', date: '2026-02-17' });
    expect(holidays).toContainEqual({ name: '除夕', date: '2026-02-16' });
    expect(holidays).toContainEqual({ name: '清明节', date: '2026-04-05' });
    expect(holidays.every((entry, index) => index === 0 || entry.date >= holidays[index - 1]!.date)).toBe(true);
  });
});
