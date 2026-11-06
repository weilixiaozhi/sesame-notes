// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { presetRange, validateRange } from './date-range';
import { eventMeasure, measured, rowMeasure } from './model';

/** 固定范围内同一用户多次触发，验证总次数、去重人数与人均次数不混淆。 */
function details() {
  const summary = { page_views: 9, visitors: 2, clicks: 6, click_users: 1, completions: 3, completion_users: 1 };
  return {
    range: {
      start_date: '2026-10-10',
      end_date: '2026-10-12',
      timezone: 'Asia/Shanghai' as const,
      platform: 'all' as const,
      bucket: 'day' as const,
    },
    summary,
    series: [{ ...summary, period_start: '2026-10-10T00:00:00Z' }],
    pages: [
      {
        event_name: 'accounting_view',
        page_id: 'accounting',
        name: '记账_首页_访问',
        page_views: 9,
        visitors: 2,
      },
    ],
    events: [
      {
        event_name: 'accounting_transaction_create_click',
        name: '记账_交易_新增_点击',
        behavior: 'click' as const,
        total: 6,
        users: 1,
      },
    ],
    coverage: {
      collection_started_at: '2026-10-01T00:00:00Z',
      complete: true,
    },
  };
}

describe('统计计算与查询规则', () => {
  it('曝光空结果遵循采集覆盖，不把未采集或未知来源填成真实零', () => {
    const empty = { ...details(), exposures: [] };
    expect(eventMeasure(empty, 'exposure', 'total')).toBe(0);
    expect(eventMeasure(empty, 'exposure', 'average')).toBeNull();
    expect(
      eventMeasure({ ...empty, coverage: { ...empty.coverage, complete: false } }, 'exposure', 'total'),
    ).toBeNull();
  });
  it('按当前行为独立计算人均次数，不使用其他行为或逐日去重数之和', () => {
    expect(eventMeasure(details(), 'view', 'average')).toBe(4.5);
    expect(eventMeasure(details(), 'click', 'users')).toBe(1);
    expect(eventMeasure(details(), 'click', 'average')).toBe(6);
    expect(rowMeasure({ id: 'event', code: 'event', name: '事件', total: 0, users: 0 }, 'average')).toBeNull();
    expect(measured(0, false, '2026-10-15T00:00:00Z')).toBeNull();
    expect(measured(0, true, '2026-10-01T00:00:00Z')).toBe(0);
  });
  it('近7天含当前日并按北京时间计算，跨月与无效日期正确处理', () => {
    expect(presetRange('week', new Date('2026-03-01T16:00:00Z'))).toMatchObject({
      start_date: '2026-02-24',
      end_date: '2026-03-02',
    });
    expect(presetRange('yesterday', new Date('2026-01-01T00:00:00Z'))).toMatchObject({
      start_date: '2025-12-31',
      end_date: '2025-12-31',
    });
    expect(() => validateRange({ start_date: '2026-02-30', end_date: '2026-03-02', platform: 'all' })).toThrow();
    expect(() => validateRange({ start_date: '2026-03-02', end_date: '2026-03-01', platform: 'all' })).toThrow();
  });
});
