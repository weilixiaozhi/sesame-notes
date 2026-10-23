import { describe, expect, it } from 'vitest';
import { dateSpan, daySummary, solarDate, type DayEvent } from './day-dates';

/** 月末样例确保日期统计与移动端原始锚点算法一致。 */
function stage(overrides: Partial<DayEvent> = {}): DayEvent {
  return {
    id: 'event',
    day_book_id: 'book',
    sync_id: 'sync',
    revision: 1,
    deleted_at: null,
    name: '阶段',
    category: 'stage',
    countdown_mode: null,
    interval_days: null,
    repeat_type: 'none',
    statistic_type: 'day',
    event: null,
    start: solarDate('2026-01-01'),
    end: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('日子统计显示', () => {
  it('阶段时长不包含起日，只有间隔倒数包含起日', () => {
    expect(daySummary(stage(), '2026-01-02').value).toBe('1');
  });
  it('有结束日期时显示阶段总长', () => {
    expect(daySummary(stage({ end: solarDate('2026-01-11') }), '2026-01-02').value).toBe('10');
  });
  it('计年遵守原始月末锚点，保留日差', () => {
    expect(dateSpan('2020-02-29', '2021-02-28')).toBe('1年');
    expect(dateSpan('2026-01-31', '2026-03-30')).toBe('1个月30天');
    expect(dateSpan('2026-01-01', '2026-01-01')).toBe('0天');
  });
  it('统计选项会改变Web展示单位', () => {
    expect(daySummary(stage({ statistic_type: 'year' }), '2027-02-03').value).toBe('1年1个月2天');
  });
});
