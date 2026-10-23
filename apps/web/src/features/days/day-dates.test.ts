import { describe, expect, it } from 'vitest';
import {
  buildDefinition,
  convertCalendar,
  daysBetween,
  intervalTarget,
  nextOccurrence,
  projectDate,
  solarDate,
  todayDate,
  validateSolar,
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
  it('非法日期和边界外日期不能被 Date 自动滚动', () => {
    for (const value of ['2023-02-29', '2026-04-31', '1900-12-31', '2101-01-01', '2026-1-01'])
      expect(() => validateSolar(value)).toThrow();
    expect(validateSolar('2024-02-29')).toBe('2024-02-29');
  });
  it('跨夏令时仍按自然日计算', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });
  it('今天取设备本地年月日', () => {
    const date = new Date(2026, 0, 2, 0, 15);
    expect(todayDate(date)).toBe('2026-01-02');
  });
  it('公农历切换保持同一天', () => {
    const solar = solarDate('2026-02-17');
    const lunar = convertCalendar(solar, 'lunar');
    expect(lunar.original_month).toBe(1);
    expect(lunar.original_day).toBe(1);
    expect(convertCalendar(lunar, 'solar')).toEqual(solar);
  });
  it('拒绝不存在的农历闰月和日号', () => {
    const lunar = convertCalendar(solarDate('2026-02-17'), 'lunar');
    expect(() => projectDate({ ...lunar, is_leap_month: true })).toThrow();
    expect(() => projectDate({ ...lunar, original_day: 31 })).toThrow();
  });
});

describe('生日与纪念日年度重复', () => {
  it('2月29日在平年取2月末，不漂移到3月', () => {
    expect(nextOccurrence(definition(), '2025-01-01')).toBe('2025-02-28');
  });
  it('当天仍属于下一次，过后进入下一年', () => {
    expect(nextOccurrence(definition(), '2024-02-29')).toBe('2024-02-29');
    expect(nextOccurrence(definition(), '2024-03-01')).toBe('2025-02-28');
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
  it('间隔包含起日且不自动循环', () => {
    expect(intervalTarget('2026-01-01', 1)).toBe('2026-01-01');
    expect(intervalTarget('2026-01-01', 30)).toBe('2026-01-30');
    const countdown = definition({
      category: 'countdown',
      countdown_mode: 'interval_days',
      interval_days: 30,
      event: null,
      start: solarDate('2026-01-01'),
      repeat_type: 'none',
    });
    expect(nextOccurrence(countdown, '2026-01-30')).toBe('2026-01-30');
    expect(nextOccurrence(countdown, '2026-01-31')).toBeNull();
  });
  it('拒绝范围外间隔和目标，允许最晚日当天', () => {
    for (const count of [0, 1.5, 36501]) expect(() => intervalTarget('2026-01-01', count)).toThrow();
    expect(() => intervalTarget('2100-12-31', 2)).toThrow();
    expect(intervalTarget('2100-12-31', 1)).toBe('2100-12-31');
  });
  it('阶段结束不能早于开始，也允许开放结束', () => {
    expect(() =>
      buildDefinition(definition({ category: 'stage', start: solarDate('2026-01-02'), end: solarDate('2026-01-01') })),
    ).toThrow('结束日期');
    expect(buildDefinition(definition({ category: 'stage', start: solarDate('2026-01-01'), end: null }))).toMatchObject(
      { event: null, repeat_type: 'none', end: null },
    );
  });
  it('切换类别移除不适用字段，保留创建时间和计年方式', () => {
    const result = buildDefinition(
      definition({
        category: 'countdown',
        countdown_mode: 'fixed_date',
        start: solarDate('2020-01-01'),
        interval_days: 3,
        statistic_type: 'year',
      }),
    );
    expect(result).toMatchObject({
      start: null,
      interval_days: null,
      repeat_type: 'none',
      statistic_type: 'year',
      created_at: '2020-01-01T00:00:00Z',
    });
  });
});
