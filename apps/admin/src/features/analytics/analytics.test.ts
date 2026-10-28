// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { overviewPoints } from './overview';
import { selectionFromPath } from './events';
import { validateFunnel } from './funnel';
import { presetRange, validateRange } from './date-range';
import {
  alignSelection,
  analysisLink,
  analysisQuery,
  eventMeasure,
  eventRows,
  measured,
  pageLabel,
  rowMeasure,
  sourcePageChoices,
} from './model';
import { analyticsCatalogSchema, analyticsDetailsSchema, analyticsFunnelSchema } from '../../api/analytics-contracts';

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

/** 清单只含采集定义，不依赖上报数量、日期或可编辑分类。 */
function catalog() {
  return {
    events: [
      {
        id: 'accounting_view',
        name: '记账_首页_访问',
        kind: 'page_view' as const,
        behavior: 'view' as const,
        page_id: 'accounting',
        event_name: 'accounting_view',
        location: '记账首页',
        source_pages: [],
        platforms: ['app' as const, 'web' as const],
      },
      {
        id: 'accounting_transaction_create_click',
        name: '记账_交易_新增_点击',
        kind: 'action' as const,
        behavior: 'click' as const,
        page_id: null,
        event_name: 'accounting_transaction_create_click',
        location: '新增交易按钮',
        source_pages: [{ page_id: 'accounting', platforms: ['app' as const, 'web' as const] }],
        platforms: ['app' as const, 'web' as const],
      },
      {
        id: 'accounting_transaction_editor_view',
        name: '记账_交易编辑_访问',
        kind: 'page_view' as const,
        behavior: 'view' as const,
        page_id: 'accounting.transaction.editor',
        event_name: 'accounting_transaction_editor_view',
        location: '交易编辑器',
        source_pages: [],
        platforms: ['app' as const, 'web' as const],
      },
      {
        id: 'accounting_transaction_created',
        name: '记账_交易_新增_完成',
        kind: 'action' as const,
        behavior: 'complete' as const,
        page_id: null,
        event_name: 'accounting_transaction_created',
        location: '新增交易保存',
        source_pages: [{ page_id: 'accounting.transaction.editor', platforms: ['app' as const, 'web' as const] }],
        platforms: ['app' as const, 'web' as const],
      },
    ],
  };
}

/** 关联信息缺失必须区别于完整采集后的零转化。 */
function funnel() {
  return {
    range: {
      start_date: '2026-10-10',
      end_date: '2026-10-12',
      timezone: 'Asia/Shanghai' as const,
      platform: 'all' as const,
    },
    scope: 'user' as const,
    window_minutes: 30,
    steps: [
      {
        id: 'accounting_transaction_create_click',
        name: '记账_交易_新增_点击',
        users: 2,
        conversion_rate: 1,
        drop_off: 0,
      },
      {
        id: 'accounting_transaction_created',
        name: '记账_交易_新增_完成',
        users: 1,
        conversion_rate: 0.5,
        drop_off: 1,
      },
    ],
    completion_rate: 0.5,
    coverage: { collection_started_at: '2026-10-01T00:00:00Z', complete: true, missing_context_events: 0 },
  };
}

describe('统计计算与查询规则', () => {
  it('按当前行为独立计算人均次数，不使用其他行为或逐日去重数之和', () => {
    expect(eventMeasure(details(), 'view', 'average')).toBe(4.5);
    expect(eventMeasure(details(), 'click', 'users')).toBe(1);
    expect(eventMeasure(details(), 'click', 'average')).toBe(6);
    expect(rowMeasure({ id: 'event', code: 'event', name: '事件', total: 0, users: 0 }, 'average')).toBeNull();
    expect(measured(0, false, '2026-10-15T00:00:00Z')).toBeNull();
    expect(measured(0, true, '2026-10-01T00:00:00Z')).toBe(0);
  });
  it('概览下钻完整保留日期来源事件，并拒绝未知目录身份', () => {
    const range = { start_date: '2026-10-01', end_date: '2026-10-02', platform: 'app' as const };
    const restored = selectionFromPath(analysisLink(range, 'click', 'accounting_transaction_create_click'));
    expect(restored.range).toEqual(range);
    expect(analysisQuery(restored.range, restored.selection, catalog())).toMatchObject({
      ...range,
      behavior: 'click',
      event_name: 'accounting_transaction_create_click',
    });
    expect(() => analysisQuery(range, { ...restored.selection, event: 'unknown' }, catalog())).toThrow('不可用');
  });
  it('页面访问使用完整事件标识下钻与展示，页面上下文不替代事件筛选', () => {
    const range = { start_date: '2026-10-01', end_date: '2026-10-02', platform: 'app' as const };
    const restored = selectionFromPath(analysisLink(range, 'view', 'accounting_view'));
    expect(analysisQuery(range, restored.selection, catalog())).toEqual({
      ...range,
      bucket: 'day',
      behavior: 'view',
      event_name: 'accounting_view',
      page_id: undefined,
    });
    expect(eventRows(details(), 'view')).toEqual([
      { id: 'accounting_view', code: 'accounting_view', name: '记账_首页_访问', total: 9, users: 2 },
    ]);
    expect(pageLabel(catalog().events[0]!)).toBe('记账_首页');
  });
  it('事件与来源页面只允许实际采集组合，改来源时清除失效事件与页面', () => {
    const definitions = catalog();
    definitions.events[1]!.platforms = ['app'];
    definitions.events[1]!.source_pages = [{ page_id: 'accounting', platforms: ['app'] }];
    const selection = {
      ...selectionFromPath('/analytics/events').selection,
      behavior: 'click' as const,
      event: 'accounting_transaction_create_click',
      page: 'accounting',
    };
    expect(sourcePageChoices(definitions, selection, 'app').map((entry) => entry.page_id)).toEqual(['accounting']);
    expect(sourcePageChoices(definitions, selection, 'web')).toEqual([]);
    expect(alignSelection(definitions, selection, 'web')).toMatchObject({ event: '', page: '' });
    expect(() => analysisQuery({ ...presetRange(), platform: 'web' }, selection, definitions)).toThrow('来源');
    expect(() =>
      analysisQuery(
        { ...presetRange(), platform: 'app' },
        { ...selection, page: 'accounting.transaction.editor' },
        definitions,
      ),
    ).toThrow('发生页面');
    expect(() =>
      validateFunnel(
        { steps: [selection.event, 'accounting_transaction_created'], scope: 'user', window_minutes: 30 },
        definitions,
        'web',
      ),
    ).toThrow('来源');
  });
  it('刷新查询链接保留页面与粒度，按小时范围和未来日期在提交前校验', () => {
    const range = { start_date: '2026-10-01', end_date: '2026-10-02', platform: 'app' as const };
    const selection = selectionFromPath(
      analysisLink(range, 'click', 'accounting_transaction_create_click', {
        page: 'accounting',
        bucket: 'hour',
      }),
    );
    expect(selection.selection).toMatchObject({ page: 'accounting', bucket: 'hour' });
    expect(selectionFromPath('/analytics/events?platform=unknown').error).toContain('来源无效');
    expect(selectionFromPath('/analytics/events?bucket=unknown').error).toContain('时间粒度无效');
    expect(() => analysisQuery({ ...range, start_date: '2026-01-01' }, selection.selection, catalog())).toThrow(
      '31 天',
    );
    expect(() => validateRange({ ...range, end_date: '2026-10-14' }, new Date('2026-10-12T16:00:00Z'))).toThrow('今天');
  });
  it('两个概览请求跨整点时，点击趋势只使用自身时间桶，不把汇总值当小时数据', () => {
    const clicks = details();
    clicks.summary.clicks = 99;
    clicks.series[0]!.clicks = 3;
    const report = {
      range: clicks.range,
      coverage: clicks.coverage,
      summary: { new_users: 2, active_users: 3, page_views: 9 },
      series: [
        { period_start: clicks.series[0]!.period_start, new_users: 1, active_users: 2, page_views: 4 },
        { period_start: '2026-10-11T00:00:00Z', new_users: 1, active_users: 1, page_views: 5 },
      ],
    };
    expect(overviewPoints(report, clicks, 'clicks').map((point) => point.value)).toEqual([3]);
    clicks.series.push({ ...clicks.series[0]!, period_start: '2026-10-11T00:00:00Z', clicks: 4 });
    report.series.pop();
    expect(overviewPoints(report, clicks, 'clicks').map((point) => point.value)).toEqual([3, 4]);
    expect(overviewPoints(report, clicks, 'page_views').map((point) => point.value)).toEqual([4]);
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
  it('漏斗验证有界窗口及完整步骤，支持以回访为目的的重复有序事件', () => {
    expect(
      validateFunnel({ steps: ['accounting_view', 'accounting_view'], scope: 'session', window_minutes: 30 }, catalog())
        .steps,
    ).toHaveLength(2);
    expect(() =>
      validateFunnel({ steps: ['accounting_view', 'unknown'], scope: 'flow', window_minutes: 30 }, catalog()),
    ).toThrow();
    expect(() =>
      validateFunnel({ steps: ['accounting_view', 'accounting_view'], scope: 'user', window_minutes: 0 }, catalog()),
    ).toThrow();
  });
  it('协议明确区分纯定义、统计结果和窗口漏斗，不接收不可能的转化率', () => {
    expect(analyticsCatalogSchema.safeParse(catalog()).success).toBe(true);
    const emptyDefinition = { ...catalog().events[0], platforms: [] };
    expect(analyticsCatalogSchema.safeParse({ events: [emptyDefinition] }).success).toBe(false);
    for (const event_name of [null, '']) {
      expect(analyticsCatalogSchema.safeParse({ events: [{ ...catalog().events[0], event_name }] }).success).toBe(
        false,
      );
      expect(
        analyticsDetailsSchema.safeParse({ ...details(), pages: [{ ...details().pages[0], event_name }] }).success,
      ).toBe(false);
    }
    expect(analyticsDetailsSchema.safeParse(details()).success).toBe(true);
    expect(analyticsFunnelSchema.safeParse(funnel()).success).toBe(true);
    expect(analyticsFunnelSchema.safeParse({ ...funnel(), completion_rate: 1.1 }).success).toBe(false);
  });
});
