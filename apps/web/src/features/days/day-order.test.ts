import { describe, expect, it, vi } from 'vitest';
import { solarDate, type DayEvent } from './day-dates';
import { groupDayEvents } from './day-order';

/** 创建保留真实类别约束的排序样例。 */
function event(id: string, category: DayEvent['category'], date: string, overrides: Partial<DayEvent> = {}): DayEvent {
  return {
    id,
    day_book_id: 'book',
    sync_id: 'sync',
    revision: 1,
    deleted_at: null,
    name: id,
    category,
    countdown_mode: category === 'countdown' ? 'fixed_date' : null,
    interval_days: null,
    repeat_type: category === 'birthday' || category === 'anniversary' ? 'yearly' : 'none',
    statistic_type: 'day',
    event: category === 'stage' ? null : solarDate(date),
    start: category === 'stage' ? solarDate(date) : null,
    end: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('日子列表分组排序', () => {
  it('周年按下次发生日期跨年排列，未来原始起点不会提前参与', () => {
    const rows = [
      event('明年一月', 'anniversary', '2020-01-01'),
      event('今年十二月', 'anniversary', '2020-12-31'),
      event('未来起点', 'anniversary', '2030-10-12'),
      event('今天', 'anniversary', '2020-10-11'),
    ];
    expect(groupDayEvents(rows, '2026-10-11', 'book').groups[0]!.events.map((row) => row.id)).toEqual([
      '今天',
      '今年十二月',
      '明年一月',
      '未来起点',
    ]);
  });

  it('倒数以唯一目标日排序，今天优先，已过期目标从近到远', () => {
    const rows = [
      event('旧目标', 'countdown', '2026-09-01'),
      event('未来固定', 'countdown', '2026-10-20'),
      event('昨天', 'countdown', '2026-10-10'),
      event('今天', 'countdown', '2026-10-11'),
      event('三天后', 'countdown', '2026-10-08', {
        countdown_mode: 'interval_days',
        event: null,
        start: solarDate('2026-10-08'),
        interval_days: 7,
      }),
      event('间隔过期', 'countdown', '2026-10-01', {
        countdown_mode: 'interval_days',
        event: null,
        start: solarDate('2026-10-01'),
        interval_days: 5,
      }),
    ];
    expect(groupDayEvents(rows, '2026-10-11', 'book').groups[0]!.events.map((row) => row.id)).toEqual([
      '今天',
      '三天后',
      '未来固定',
      '昨天',
      '间隔过期',
      '旧目标',
    ]);
  });

  it('阶段按开始日期从近到远，与持续或结束状态无关', () => {
    const rows = [
      event('仍持续', 'stage', '2020-01-01'),
      event('已结束较新', 'stage', '2023-01-01', { end: solarDate('2024-01-01') }),
      event('已结束较旧', 'stage', '2019-01-01', { end: solarDate('2025-01-01') }),
    ];
    expect(groupDayEvents(rows, '2026-10-11', 'book').groups[0]!.events.map((row) => row.id)).toEqual([
      '已结束较新',
      '仍持续',
      '已结束较旧',
    ]);
  });

  it('只展示当前本有效记录，过滤墓碑且不产生空分类', () => {
    const rows = [
      event('其他本', 'birthday', '2000-10-11', { day_book_id: 'other' }),
      event('已删除', 'anniversary', '2000-10-11', { deleted_at: '2026-10-10T00:00:00Z' }),
      event('保留', 'countdown', '2026-10-12'),
    ];
    expect(groupDayEvents(rows, '2026-10-11', 'book').groups).toEqual([{ category: 'countdown', events: [rows[2]] }]);
    expect(groupDayEvents(rows, '2026-10-11', 'empty')).toEqual({ groups: [], invalid: [] });
  });

  it('单条损坏日期保留为待确认，其他记录正常排序且日志不含名称和原始日期', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = event('broken-id', 'birthday', '2000-01-01', {
      name: '私密名称',
      event: { ...solarDate('2000-01-01'), solar_date: '无法识别的原始日期' },
    });
    const invalidStage = event('bad-stage', 'stage', '2026-10-12', { end: solarDate('2026-10-11') });
    const valid = event('正常', 'birthday', '2000-10-12');
    const result = groupDayEvents([broken, valid, invalidStage], '2026-10-11', 'book');
    expect(result.groups).toEqual([{ category: 'birthday', events: [valid] }]);
    expect(result.invalid.map((row) => row.id)).toEqual(['bad-stage', 'broken-id']);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('计算日子排序失败', { eventId: 'broken-id', errorType: 'Error' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('私密名称');
    expect(JSON.stringify(log.mock.calls)).not.toContain('无法识别的原始日期');
  });

  it('跨过午夜重新计算下次周年与已过期倒数的顺序', () => {
    const rows = [event('今天生日', 'birthday', '2000-10-11'), event('明天生日', 'birthday', '2000-10-12')];
    expect(groupDayEvents(rows, '2026-10-11', 'book').groups[0]!.events.map((row) => row.id)).toEqual([
      '今天生日',
      '明天生日',
    ]);
    expect(groupDayEvents(rows, '2026-10-12', 'book').groups[0]!.events.map((row) => row.id)).toEqual([
      '明天生日',
      '今天生日',
    ]);
    const countdowns = [event('今天倒数', 'countdown', '2026-10-11'), event('明天倒数', 'countdown', '2026-10-12')];
    expect(groupDayEvents(countdowns, '2026-10-11', 'book').groups[0]!.events.map((row) => row.id)).toEqual([
      '今天倒数',
      '明天倒数',
    ]);
    expect(groupDayEvents(countdowns, '2026-10-12', 'book').groups[0]!.events.map((row) => row.id)).toEqual([
      '明天倒数',
      '今天倒数',
    ]);
  });
});
