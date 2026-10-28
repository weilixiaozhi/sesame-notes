import { describe, expect, it } from 'vitest';

import { normalizeDayName, validateDayEvent } from '../src/modules/days/testing.js';
import { ApiError } from '../src/shared/errors.js';
import { readFileSync } from 'node:fs';

const vectors = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/day_calendar_vectors.json', import.meta.url), 'utf8'),
) as {
  lunar_to_solar: Array<{ year: number; month: number; day: number; is_leap_month: boolean; solar_date: string }>;
  name_normalization: Array<{ input: string; expected: string }>;
};

/** 构造明确的公历日期定义，不依赖被测转换逻辑生成期望。 */
function solar(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return {
    calendar_type: 'solar',
    original_year: year,
    original_month: month,
    original_day: day,
    is_leap_month: false,
    solar_date: date,
  };
}

/** 构造生日的完整需求输入，未来生日仍允许静态同步校验。 */
function birthday() {
  return {
    name: '生日',
    category: 'birthday',
    countdown_mode: null,
    interval_days: null,
    repeat_type: 'yearly',
    statistic_type: 'year',
    event: solar('2099-02-28'),
    start: null,
    end: null,
    created_at: '2026-09-07T00:00:00.000Z',
  };
}

describe('日子静态写边界', () => {
  it.each(['2026-02-30T00:00:00.000Z', '2025-02-29T00:00:00.000Z', '0000-01-01T00:00:00.000Z'])(
    '创建审计时间必须是可原样回读的时间戳：%s',
    (createdAt) => {
      expect(() => validateDayEvent({ ...birthday(), created_at: createdAt })).toThrow(ApiError);
    },
  );

  it.each(vectors.lunar_to_solar)('共享独立向量 $year-$month-$day → $solar_date', (sample) => {
    const event = {
      calendar_type: 'lunar',
      original_year: sample.year,
      original_month: sample.month,
      original_day: sample.day,
      is_leap_month: sample.is_leap_month,
      solar_date: sample.solar_date,
    };
    expect(validateDayEvent({ ...birthday(), event }).event?.solar_date).toBe(sample.solar_date);
  });
  it.each(vectors.name_normalization)('共享名称空白样本 $input', (sample) => {
    if (sample.expected === null) expect(() => normalizeDayName(sample.input)).toThrow();
    else expect(normalizeDayName(sample.input)).toBe(sample.expected);
  });
  it('拒绝原始农历闰二月三十及不存在的闰月', () => {
    const event = {
      calendar_type: 'lunar',
      original_year: 2023,
      original_month: 2,
      original_day: 30,
      is_leap_month: true,
      solar_date: '2023-04-20',
    };
    expect(() => validateDayEvent({ ...birthday(), event })).toThrow(ApiError);
    expect(() =>
      validateDayEvent({ ...birthday(), event: { ...event, original_year: 2024, original_day: 1 } }),
    ).toThrow(ApiError);
  });
  it('按完整 Unicode 空白集合去除两端空白并按码点计数', () => {
    expect(normalizeDayName('\u0085\uFEFF\u3000生日\u00A0')).toBe('生日');
    expect(normalizeDayName('😀'.repeat(100))).toBe('😀'.repeat(100));
    expect(() => normalizeDayName('😀'.repeat(101))).toThrow();
    expect(() => normalizeDayName('\u0085\uFEFF')).toThrow();
  });

  it('不根据今天拒绝已有未来生日，保留真实纯日期', () => {
    expect(validateDayEvent(birthday()).event?.solar_date).toBe('2099-02-28');
  });

  it.each(['2023-02-29', '1900-12-31', '2101-01-01'])('拒绝非法或越界公历 %s', (date) => {
    expect(() => validateDayEvent({ ...birthday(), event: solar(date) })).toThrow();
  });

  it('拒绝投影篡改和公历闰月标志', () => {
    expect(() =>
      validateDayEvent({ ...birthday(), event: { ...solar('2024-02-29'), solar_date: '2024-03-01' } }),
    ).toThrow();
    expect(() => validateDayEvent({ ...birthday(), event: { ...solar('2024-02-29'), is_leap_month: true } })).toThrow();
  });

  it('拒绝半组日期和类型组合，阶段允许同日且禁止倒序', () => {
    expect(() => validateDayEvent({ ...birthday(), event: { calendar_type: 'solar' } })).toThrow();
    expect(() => validateDayEvent({ ...birthday(), repeat_type: 'monthly' })).toThrow();
    const stage = {
      ...birthday(),
      category: 'stage',
      statistic_type: 'day',
      repeat_type: 'none',
      event: null,
      start: solar('2026-09-07'),
      end: solar('2026-09-07'),
    };
    expect(validateDayEvent(stage).category).toBe('stage');
    expect(validateDayEvent({ ...stage, end: null }).end).toBeNull();
    expect(() => validateDayEvent({ ...stage, end: solar('2026-09-06') })).toThrow();
  });

  it('只接受当前统计与倒数规则，不转换废弃枚举', () => {
    expect(validateDayEvent(birthday()).statistic_type).toBe('year');
    expect(() => validateDayEvent({ ...birthday(), statistic_type: 'age' })).toThrow(ApiError);
    const countdown = {
      ...birthday(),
      category: 'countdown',
      countdown_mode: 'fixed_date',
      statistic_type: 'day',
      repeat_type: 'none',
    };
    expect(validateDayEvent(countdown).event?.solar_date).toBe('2099-02-28');
    for (const repeat of ['yearly', 'monthly', 'interval_days']) {
      expect(() => validateDayEvent({ ...countdown, repeat_type: repeat })).toThrow(ApiError);
    }
  });

  it('X 天含起日，首目标在范围内才能保存', () => {
    const interval = {
      ...birthday(),
      category: 'countdown',
      countdown_mode: 'interval_days',
      interval_days: 1,
      statistic_type: 'day',
      repeat_type: 'none',
      event: null,
      start: solar('2100-12-31'),
    };
    expect(validateDayEvent(interval).interval_days).toBe(1);
    expect(validateDayEvent(interval).repeat_type).toBe('none');
    expect(() => validateDayEvent({ ...interval, interval_days: 2 })).toThrow();
    expect(() => validateDayEvent({ ...interval, interval_days: 0 })).toThrow();
  });
});
