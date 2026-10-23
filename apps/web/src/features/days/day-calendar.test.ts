import { describe, expect, it } from 'vitest';
import { monthOccurrences } from './day-calendar';
import { solarDate, type DayEvent } from './day-dates';

const event: DayEvent = {
  id: 'entry',
  day_book_id: 'book',
  sync_id: 'sync',
  revision: 1,
  deleted_at: null,
  name: '纪念日',
  category: 'anniversary',
  event: solarDate('2020-02-29'),
  start: null,
  end: null,
  countdown_mode: null,
  interval_days: null,
  repeat_type: 'yearly',
  statistic_type: 'day',
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2020-01-01T00:00:00Z',
};

describe('日历真实发生日', () => {
  it('年度事件只出现在本范围内真实日期', () => {
    expect(monthOccurrences(event, '2025-02-01', '2025-03-10')).toEqual(['2025-02-28']);
    expect(monthOccurrences(event, '2025-03-01', '2025-04-01')).toEqual([]);
  });
  it('阶段起止单独出现，同日起止不重复', () => {
    const stage = {
      ...event,
      category: 'stage' as const,
      event: null,
      start: solarDate('2026-01-01'),
      end: solarDate('2026-01-10'),
      repeat_type: 'none' as const,
    };
    expect(monthOccurrences(stage, '2026-01-01', '2026-01-31')).toEqual(['2026-01-01', '2026-01-10']);
    expect(monthOccurrences({ ...stage, end: stage.start }, '2026-01-01', '2026-01-31')).toEqual(['2026-01-01']);
  });
});
