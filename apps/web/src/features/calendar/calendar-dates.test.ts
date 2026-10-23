import { describe, expect, it } from 'vitest';
import { calendarDates, calendarRange, localDateKey, shiftCalendarMonth, validCalendarDate } from './calendar-dates';

describe('日历日期边界', () => {
  it('拒绝滚入下月的日期与支持区间外深链', () => {
    expect(validCalendarDate('2026-02-29')).toBe(false);
    expect(validCalendarDate('2024-02-29')).toBe(true);
    expect(validCalendarDate('2101-01-01')).toBe(false);
    expect(validCalendarDate(null)).toBe(false);
    expect(validCalendarDate('2026-9-01')).toBe(false);
  });
  it('六行月历始终周一开始，日期连续且覆盖相邻月', () => {
    const dates = calendarDates('2026-09');
    expect(dates).toHaveLength(42);
    expect(dates[0]).toBe('2026-08-31');
    expect(dates.at(-1)).toBe('2026-10-11');
    expect(new Set(dates).size).toBe(42);
  });
  it('按当地零点生成半开区间，结尾为次日而非固定加24小时', () => {
    const range = calendarRange('2026-03-08', '2026-03-08');
    expect(localDateKey(new Date(range.start_at))).toBe('2026-03-08');
    expect(localDateKey(new Date(range.end_at))).toBe('2026-03-09');
    expect(new Date(range.start_at).getHours()).toBe(0);
    expect(new Date(range.end_at).getHours()).toBe(0);
  });
  it('跨年翻月与最小最大年份不会产生不可用页面', () => {
    expect(shiftCalendarMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftCalendarMonth('1901-01', -1)).toBeNull();
    expect(shiftCalendarMonth('2100-12', 1)).toBeNull();
  });
});
