import { describe, expect, it } from 'vitest';
import {
  convertCalendar,
  daysBetween,
  dateSpan,
  nextOccurrence,
  projectDate,
  solarDate,
  type DayDefinition,
} from './day-dates';

/** 以真实契约定义构造边界样例，断言可见业务结果。 */
function definition(overrides: Partial<DayDefinition> = {}): DayDefinition {
  return {
    name: '纪念日',
    category: 'anniversary',
    countdown_mode: null,
    interval_days: null,
    repeat_type: 'yearly',
    statistic_type: 'day',
    event: solarDate('2020-02-29'),
    start: null,
    end: null,
    created_at: '2020-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('跨时区自然日与原始日期', () => {
  it('跨夏令时仍按自然日计算', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });
  it('公农历切换保持同一天', () => {
    const solar = solarDate('2026-02-17');
    const lunar = convertCalendar(solar, 'lunar');
    expect(lunar.original_month).toBe(1);
    expect(lunar.original_day).toBe(1);
    expect(convertCalendar(lunar, 'solar')).toEqual(solar);
  });
});

describe('生日与纪念日年度重复', () => {
  it('2月29日在平年取2月末，不漂移到3月', () => {
    expect(nextOccurrence(definition(), '2025-01-01')).toBe('2025-02-28');
  });
  it('未来开始的事件不生成早于原始起点的重复', () => {
    expect(nextOccurrence(definition({ event: solarDate('2030-05-01') }), '2026-01-01')).toBe('2030-05-01');
  });
  it('农历闰月不会偷换为普通月', () => {
    const original = projectDate({
      calendar_type: 'lunar',
      original_year: 2023,
      original_month: 2,
      original_day: 1,
      is_leap_month: true,
      solar_date: '',
    });
    const next = nextOccurrence(definition({ event: original }), '2024-01-01');
    expect(next).not.toBeNull();
    const lunar = convertCalendar(solarDate(next!), 'lunar');
    expect(lunar.original_month).toBe(2);
    expect(lunar.is_leap_month).toBe(true);
    expect(lunar.original_year).toBeGreaterThan(2024);
  });
});

describe('倒数与阶段的保存约束', () => {
  it('计年和计月保留原始月末锚点及剩余日数', () => {
    expect(dateSpan('2020-02-29', '2021-02-28')).toBe('1年');
    expect(dateSpan('2026-01-31', '2026-03-30')).toBe('1个月30天');
    expect(dateSpan('2026-01-01', '2026-01-01')).toBe('0天');
    expect(dateSpan('2026-01-01', '2027-02-03')).toBe('1年1个月2天');
  });
});
