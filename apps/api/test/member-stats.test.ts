import { describe, expect, it } from 'vitest';

import { analyticsRange } from '../src/modules/sharing/testing.js';

describe('成员统计周期', () => {
  it('按客户端时区和账本月起始日生成左闭右开 UTC 范围', () => {
    expect(analyticsRange('month', '2026-06', 480, 10, new Date('2026-06-15T00:00:00Z'))).toEqual({
      period: '2026-06',
      startAt: new Date('2026-06-09T16:00:00.000Z'),
      endAt: new Date('2026-07-09T16:00:00.000Z'),
    });
  });

  it('当前日期未到月起始日时归入上一周期', () => {
    expect(analyticsRange('month', undefined, 480, 10, new Date('2026-06-05T00:00:00Z')).period).toBe('2026-05');
  });

  it.each([
    ['2026-01', 31, '2026-01-31', '2026-02-28'],
    ['2024-02', 31, '2024-02-29', '2024-03-31'],
    ['2026-12', 31, '2026-12-31', '2027-01-31'],
  ])('%s 起始日 %i：当前月和下一月各自回退至最后一天', (period, day, start, end) => {
    expect(analyticsRange('month', period, 0, day)).toEqual({
      period,
      startAt: new Date(`${start}T00:00:00.000Z`),
      endAt: new Date(`${end}T00:00:00.000Z`),
    });
  });

  it.each([
    ['2026-02-27T15:59:59.999Z', 480, '2026-01', '2026-01-30T16:00:00Z', '2026-02-27T16:00:00Z'],
    ['2026-02-27T16:00:00.000Z', 480, '2026-02', '2026-02-27T16:00:00Z', '2026-03-30T16:00:00Z'],
  ])('%s 时区 %i：31 日周期在该月实际最后一天零点切换', (now, offset, period, start, end) => {
    expect(analyticsRange('month', undefined, offset, 31, new Date(now))).toEqual({
      period,
      startAt: new Date(start),
      endAt: new Date(end),
    });
  });

  it('all 不设置时间边界', () => {
    expect(analyticsRange('all', undefined, 0, 1, new Date())).toEqual({ period: null, startAt: null, endAt: null });
  });
});
