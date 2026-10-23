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
  it('生日、纪念日、倒数日和阶段固定分组，同类按下一次日期排列', () => {
    const rows = [
      event('生日六月', 'birthday', '2026-06-06'),
      event('阶段', 'stage', '2023-09-25'),
      event('三天后', 'countdown', '2026-10-14'),
      event('生日四月', 'birthday', '2023-04-14'),
      event('纪念日', 'anniversary', '2020-10-12'),
    ];
    const result = groupDayEvents(rows, '2026-10-11', 'book');
    expect(result.groups.map((group) => [group.category, group.events.map((row) => row.id)])).toEqual([
      ['birthday', ['生日四月', '生日六月']],
      ['anniversary', ['纪念日']],
      ['countdown', ['三天后']],
      ['stage', ['阶段']],
    ]);
    expect(result.invalid).toEqual([]);
  });

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

  it('同日按创建时间与实体 ID 稳定排序，不依赖接口返回顺序', () => {
    const rows = [
      event('later', 'birthday', '2000-01-01', { created_at: '2026-01-01T01:00:00Z' }),
      event('b', 'birthday', '2001-01-01'),
      event('a', 'birthday', '2002-01-01', { created_at: '2026-01-01T08:00:00+08:00' }),
    ];
    const ids = (input: DayEvent[]) =>
      groupDayEvents(input, '2026-10-11', 'book').groups[0]!.events.map((row) => row.id);
    expect(ids(rows)).toEqual(['a', 'b', 'later']);
    expect(ids([...rows].reverse())).toEqual(['a', 'b', 'later']);
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

  it('整本超过三十条时仍由最近的事件排在首位，保留原始输入顺序', () => {
    const rows = Array.from({ length: 31 }, (_, index) =>
      event(`birthday-${index}`, 'birthday', '2000-12-31', {
        created_at: `2026-10-${String(31 - index).padStart(2, '0')}T00:00:00Z`,
      }),
    );
    rows.push(event('最早创建但即将到来', 'birthday', '2000-10-12', { created_at: '2020-01-01T00:00:00Z' }));
    const original = [...rows];
    const result = groupDayEvents(Object.freeze(rows), '2026-10-11', 'book');
    expect(result.groups[0]!.events).toHaveLength(32);
    expect(result.groups[0]!.events[0]!.id).toBe('最早创建但即将到来');
    expect(rows).toEqual(original);
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
