import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { Value } from '@sinclair/typebox/value';
import {
  analyticsActorKey,
  analyticsRange,
  fillAnalyticsSeries,
  ingestAnalyticsEvents,
  readAnalyticsReport,
} from './analytics-service.js';
import {
  AnalyticsDefinitionSchema,
  AnalyticsEventSchema,
  AnalyticsQuerySchema,
  type AnalyticsEventInput,
} from './analytics-contract.js';
import { ANALYTICS_DEFINITIONS } from './analytics-catalog.js';

const now = new Date('2026-10-10T00:00:00Z');
const userId = '10000000-0000-4000-8000-000000000001';
const eventId = '20000000-0000-4000-8000-000000000001';
/** 使用固定行为标识覆盖重传、客户端切换和时区边界。 */
function event(overrides: Partial<AnalyticsEventInput> = {}): AnalyticsEventInput {
  return {
    event_id: eventId,
    occurred_at: now.toISOString(),
    kind: 'page_view',
    page_id: 'home',
    event_name: 'home_view',
    platform: 'web',
    session_id: '30000000-0000-4000-8000-000000000001',
    event_sequence: 1,
    ...overrides,
  };
}

describe('数据统计时间口径', () => {
  it('上海同一天包含 UTC 前一天 16 时起，到本日 16 时之前', () => {
    const range = analyticsRange({ start_date: '2026-10-10', end_date: '2026-10-10' });
    expect(range.start.toISOString()).toBe('2026-10-09T16:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-10T16:00:00.000Z');
    expect(range.bucket).toBe('hour');
  });
  it.each([
    ['2026-02-30', '2026-03-01'],
    ['2026-10-11', '2026-10-10'],
    ['2010-01-01', '2026-10-10'],
  ])('拒绝无效或过长范围 %s—%s', (start, end) => {
    expect(() => analyticsRange({ start_date: start, end_date: end })).toThrow();
  });
  it('自定义长范围不受 31 天限制，允许日粒度与月粒度', () => {
    expect(analyticsRange({ start_date: '2024-02-01', end_date: '2026-10-10', bucket: 'day' }).bucket).toBe('day');
    expect(analyticsRange({ start_date: '2024-02-01', end_date: '2026-10-10' }).bucket).toBe('month');
  });
  it('闰年完整自然月补齐 29 天，空段明确为零', () => {
    const range = analyticsRange({ start_date: '2024-02-01', end_date: '2024-02-29', bucket: 'day' });
    const series = fillAnalyticsSeries(range.start, range.end, range.bucket, []);
    expect(series).toHaveLength(29);
    expect(series.at(-1)).toEqual({
      period_start: '2024-02-28T16:00:00.000Z',
      new_users: 0,
      active_users: 0,
      page_views: 0,
    });
  });
  it('跨月自定义范围只返回相关月桶', () => {
    const range = analyticsRange({ start_date: '2025-12-25', end_date: '2026-02-02', bucket: 'month' });
    expect(fillAnalyticsSeries(range.start, range.end, range.bucket, []).map((row) => row.period_start)).toEqual([
      '2025-11-30T16:00:00.000Z',
      '2025-12-31T16:00:00.000Z',
      '2026-01-31T16:00:00.000Z',
    ]);
  });
  it('范围汇总读取全范围去重结果，不累加每天活跃人数', async () => {
    const rows = [
      { period_start: null, new_users: 0n, active_users: 1n, page_views: 5n },
      ...Array.from({ length: 5 }, (_, index) => ({
        period_start: new Date(`2026-10-${String(index + 4).padStart(2, '0')}T16:00:00Z`),
        new_users: 0n,
        active_users: 1n,
        page_views: 1n,
      })),
    ];
    const transaction = {
      productAnalyticsState: { findUnique: vi.fn().mockResolvedValue({ startedAt: new Date('2026-10-01T00:00:00Z') }) },
      $queryRaw: vi.fn().mockResolvedValue(rows),
    };
    const prisma = {
      $transaction: async (run: (tx: typeof transaction) => unknown) => run(transaction),
    } as unknown as PrismaClient;
    const result = await readAnalyticsReport(prisma, { start_date: '2026-10-05', end_date: '2026-10-11' });
    expect(result.summary.active_users).toBe(1);
    expect(result.series.reduce((sum, row) => sum + row.active_users, 0)).toBe(5);
    expect(result.series).toHaveLength(7);
    expect(result.range.platform).toBe('all');
    expect(result.coverage.collection_started_at).toBe('2026-10-01T00:00:00.000Z');
  });
  it('日期以北京时间今天为上限，不把未来日期当作已测量的零', () => {
    const now = new Date('2026-10-12T16:01:00Z');
    expect(analyticsRange({ start_date: '2026-10-13', end_date: '2026-10-13' }, now).bucket).toBe('hour');
    expect(() => analyticsRange({ start_date: '2026-10-13', end_date: '2026-10-14' }, now)).toThrow('北京时间今天');
  });
});

describe('统计来源筛选', () => {
  it.each(['all', 'app', 'web', undefined])('只允许约定的来源值：%s', (platform) => {
    expect(Value.Check(AnalyticsQuerySchema, { start_date: '2026-10-10', end_date: '2026-10-10', platform })).toBe(
      true,
    );
  });

  it.each(['ios', 'android', '', "app' OR TRUE --"])('拒绝未定义的来源值：%s', (platform) => {
    expect(Value.Check(AnalyticsQuerySchema, { start_date: '2026-10-10', end_date: '2026-10-10', platform })).toBe(
      false,
    );
  });

  it.each(['app', 'web'] as const)('单端 %s 在聚合前过滤，完整性使用统一采集起点', async (platform) => {
    const transaction = {
      productAnalyticsState: {
        findUnique: vi.fn().mockResolvedValue({
          startedAt: new Date('2026-10-01T00:00:00Z'),
        }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const prisma = {
      $transaction: async (run: (tx: typeof transaction) => unknown) => run(transaction),
    } as unknown as PrismaClient;
    const result = await readAnalyticsReport(prisma, {
      start_date: '2026-10-05',
      end_date: '2026-10-11',
      platform,
    });
    const sql = transaction.$queryRaw.mock.calls[0]![0];
    expect(sql.sql).toContain('AND platform = ?');
    expect(sql.values.at(-1)).toBe(platform);
    expect(result.range.platform).toBe(platform);
    expect(result.coverage).toEqual({
      collection_started_at: '2026-10-01T00:00:00.000Z',
      complete: true,
    });

    const complete = await readAnalyticsReport(prisma, {
      start_date: '2026-10-11',
      end_date: '2026-10-11',
      platform,
    });
    expect(complete.coverage.complete).toBe(true);
  });

  it('全部来源不增加平台筛选，并使用统一采集起点', async () => {
    const transaction = {
      productAnalyticsState: {
        findUnique: vi.fn().mockResolvedValue({
          startedAt: new Date('2026-10-01T00:00:00Z'),
        }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const prisma = {
      $transaction: async (run: (tx: typeof transaction) => unknown) => run(transaction),
    } as unknown as PrismaClient;
    const result = await readAnalyticsReport(prisma, {
      start_date: '2026-10-05',
      end_date: '2026-10-11',
      platform: 'all',
    });
    expect(transaction.$queryRaw.mock.calls[0]![0].sql).not.toContain('AND platform =');
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.collection_started_at).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('可信账号事件采集', () => {
  it('页面访问以独立访问事件名入库，缺失、错配和类型混用标识整批拒绝', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
    const visit = event({ page_id: 'accounting.transaction.editor', event_name: 'accounting_transaction_editor_view' });
    expect(Value.Check(AnalyticsEventSchema.properties.event_name, visit.event_name)).toBe(true);
    await ingestAnalyticsEvents(prisma, userId, [visit], now);
    expect(createMany.mock.calls[0]![0].data[0]).toMatchObject({
      kind: 'page_view',
      pageId: 'accounting.transaction.editor',
      eventName: 'accounting_transaction_editor_view',
    });
    createMany.mockClear();
    for (const invalid of [
      { ...visit, event_name: undefined },
      { ...visit, event_name: 'accounting.transaction.editor' },
      { ...visit, event_name: 'accounting_view' },
      { ...visit, event_name: 'accounting_transaction_created' },
      { ...visit, kind: 'action' },
      { ...visit, kind: 'active' },
    ]) {
      await expect(
        ingestAnalyticsEvents(prisma, userId, [visit, invalid as AnalyticsEventInput], now),
      ).rejects.toThrow();
      expect(createMany).not.toHaveBeenCalled();
    }
  });
  it('固定动作携带事件英文名入库，未知事件、来源不匹配和缺少页面整批拒绝', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
    const action = event({
      kind: 'action',
      page_id: 'accounting.transaction.editor',
      event_name: 'accounting_transaction_created',
    });
    await ingestAnalyticsEvents(prisma, userId, [action], now);
    expect(createMany.mock.calls[0]![0].data[0]).toMatchObject({
      kind: 'action',
      eventName: 'accounting_transaction_created',
      pageId: 'accounting.transaction.editor',
    });
    createMany.mockClear();
    for (const invalid of [
      { ...action, event_name: undefined },
      { ...action, page_id: undefined },
      { ...action, event_name: 'settings_theme_changed' },
      { ...action, kind: 'page_view' },
    ]) {
      await expect(ingestAnalyticsEvents(prisma, userId, [invalid as AnalyticsEventInput], now)).rejects.toThrow();
      expect(createMany).not.toHaveBeenCalled();
    }
    expect(Value.Check(AnalyticsEventSchema, { ...action, event_name: 'free_event' })).toBe(false);
    expect(Value.Check(AnalyticsEventSchema, { ...action, properties: { amount: 100 } })).toBe(false);
  });
  it('所有事件使用唯一英文身份，页面访问与操作名称都带行为后缀', () => {
    expect(new Set(ANALYTICS_DEFINITIONS.map((definition) => definition.id)).size).toBe(ANALYTICS_DEFINITIONS.length);
    for (const definition of ANALYTICS_DEFINITIONS) {
      expect(definition.id).toBe(definition.event_name);
      expect(definition.event_name).toMatch(/^[a-z][a-z0-9_]+$/);
      if (definition.kind === 'page_view')
        expect(definition.event_name).toBe(`${definition.page_id!.replaceAll('.', '_')}_view`);
      expect(definition.location.trim().length).toBeGreaterThan(0);
      expect(definition.platforms.length).toBeGreaterThan(0);
      expect(definition.name).not.toContain('undefined');
      expect(definition.name).not.toContain('..');
      expect(definition.name).not.toContain('__');
      expect(definition.name).not.toContain('.');
      expect(
        definition.name.endsWith(
          definition.behavior === 'view' ? '_访问' : definition.behavior === 'click' ? '_点击' : '_完成',
        ),
      ).toBe(true);
      expect(Object.keys(definition).sort()).toEqual([
        'behavior',
        'event_name',
        'id',
        'kind',
        'location',
        'name',
        'page_id',
        'platforms',
        'source_pages',
      ]);
    }
  });
  it('目录仅包含真实已采集页面，采集端契约拒绝空来源或重复来源', () => {
    const transaction = ANALYTICS_DEFINITIONS.find((definition) => definition.id === 'accounting_transaction_view')!;
    expect(transaction.platforms).toEqual(['app', 'web']);
    expect(ANALYTICS_DEFINITIONS).toHaveLength(134);
    expect(ANALYTICS_DEFINITIONS.some((definition) => definition.id === 'accounting_settings_view')).toBe(false);
    expect(ANALYTICS_DEFINITIONS.some((definition) => definition.id === 'settings_devices_view')).toBe(false);
    expect(ANALYTICS_DEFINITIONS.every((definition) => Value.Check(AnalyticsDefinitionSchema, definition))).toBe(true);
    expect(Value.Check(AnalyticsDefinitionSchema, { ...transaction, platforms: [] })).toBe(false);
    expect(Value.Check(AnalyticsDefinitionSchema, { ...transaction, platforms: ['app', 'app'] })).toBe(false);
    const pages = new Map(
      ANALYTICS_DEFINITIONS.filter((definition) => definition.kind === 'page_view').map((definition) => [
        definition.page_id,
        definition,
      ]),
    );
    for (const definition of ANALYTICS_DEFINITIONS) {
      if (definition.kind === 'page_view') expect(definition.source_pages).toEqual([]);
      else expect(definition.source_pages.length).toBeGreaterThan(0);
      for (const source of definition.source_pages) {
        expect(pages.has(source.page_id)).toBe(true);
        for (const platform of source.platforms) expect(pages.get(source.page_id)?.platforms).toContain(platform);
      }
    }
  });
  it.each(['app', 'web'] as const)('%s 支出详情访问沿用相同页面身份并可记录前台活跃', async (platform) => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
    const visit = event({ platform, page_id: 'accounting.transaction', event_name: 'accounting_transaction_view' });
    const active = event({
      event_id: '20000000-0000-4000-8000-000000000002',
      event_sequence: 2,
      platform,
      page_id: 'accounting.transaction',
      kind: 'active',
      event_name: undefined,
    });
    await expect(ingestAnalyticsEvents(prisma, userId, [visit, active], now)).resolves.toEqual({
      accepted: 2,
      duplicates: 0,
    });
    expect(createMany.mock.calls[0]![0].data).toEqual([
      expect.objectContaining({
        platform,
        pageId: 'accounting.transaction',
        eventName: 'accounting_transaction_view',
        kind: 'page_view',
      }),
      expect.objectContaining({ platform, pageId: 'accounting.transaction', eventName: null, kind: 'active' }),
    ]);
  });
  it('相同业务页面使用唯一身份，目录按实际产品名称和来源区分编辑、详情与内容库', () => {
    const byId = new Map(ANALYTICS_DEFINITIONS.map((definition) => [definition.id, definition]));
    for (const page of [
      'accounting.members',
      'accounting.members.detail',
      'fitness.session',
      'fitness.sessions',
      'fitness.sessions.edit',
    ]) {
      expect(byId.has(`${page.replaceAll('.', '_')}_view`)).toBe(false);
      expect(Value.Check(AnalyticsEventSchema, { ...event(), page_id: page })).toBe(false);
    }
    expect(byId.get('accounting_aa_split_editor_view')).toMatchObject({
      name: '记账_编辑分摊_访问',
      platforms: ['app'],
    });
    expect(byId.get('accounting_aa_member_detail_view')).toMatchObject({
      name: '记账_AA 成员账单详情_访问',
      platforms: ['app'],
    });
    expect(byId.get('accounting_aa_statistics_view')).toMatchObject({ platforms: ['app', 'web'] });
    expect(byId.get('memos_editor_view')).toMatchObject({ name: '备忘录_编辑_访问', platforms: ['app', 'web'] });
    expect(byId.get('credentials_editor_view')).toMatchObject({
      name: '账号密码_编辑_访问',
      platforms: ['app', 'web'],
    });
    expect(byId.get('fitness_library_view')).toMatchObject({ name: '健身_官方内容库_访问', platforms: ['web'] });
    expect(byId.get('fitness_templates_library_view')).toMatchObject({ name: '健身_模板库_访问', platforms: ['app'] });
    expect(byId.get('memos_book_select')?.name).toBe('备忘录_备忘录本切换_点击');
    expect(byId.get('credentials_book_select')?.name).toBe('账号密码_账号密码本切换_点击');
    expect(byId.has('calendar_record_open_click')).toBe(false);
    expect(byId.get('calendar_section_open_click')).toMatchObject({
      name: '日历_业务入口_点击',
      source_pages: [{ page_id: 'calendar', platforms: ['web'] }],
    });
    for (const action of [
      'days_event_open_click',
      'memos_note_open_click',
      'credentials_open_click',
      'fitness_workout_open_click',
    ]) {
      expect(byId.get(action)?.source_pages).toContainEqual({
        page_id: 'calendar',
        platforms: ['app', 'web'],
      });
    }
  });
  it('关联 UUID 随事件保存，缺失关联不伪造流程且无效输入无法通过契约', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const associated = event({
      session_id: '30000000-0000-4000-8000-000000000001',
      flow_id: '40000000-0000-4000-8000-000000000001',
    });
    await ingestAnalyticsEvents(
      { productAnalyticsEvent: { createMany } } as unknown as PrismaClient,
      userId,
      [associated],
      now,
    );
    expect(createMany.mock.calls[0]![0].data[0]).toMatchObject({
      sessionId: associated.session_id,
      flowId: associated.flow_id,
    });
    expect(Value.Check(AnalyticsEventSchema, { ...associated, session_id: 'session-1' })).toBe(false);
    expect(Value.Check(AnalyticsEventSchema, { ...associated, flow_id: 'record-business-id' })).toBe(false);
    expect(Value.Check(AnalyticsEventSchema, { ...associated, session_id: undefined })).toBe(false);
    for (const event_sequence of [undefined, 0, -1, 1.5, 2_147_483_648]) {
      expect(Value.Check(AnalyticsEventSchema, { ...associated, event_sequence })).toBe(false);
    }
  });
  it('页面采集端与动作发生页面必须匹配同源目录，错误组合不能污染整批事实', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
    for (const invalid of [
      event({ page_id: 'accounting.aa_split.editor', event_name: 'accounting_aa_split_editor_view', platform: 'web' }),
      event({ page_id: 'home', platform: 'app' }),
      event({ kind: 'action', page_id: 'settings', event_name: 'credentials_save_click' }),
      event({ kind: 'action', page_id: 'fitness.templates.edit', event_name: 'fitness_template_added' }),
    ]) {
      await expect(ingestAnalyticsEvents(prisma, userId, [event(), invalid], now)).rejects.toThrow();
      expect(createMany).not.toHaveBeenCalled();
    }
    await ingestAnalyticsEvents(
      prisma,
      userId,
      [event({ kind: 'action', page_id: 'fitness.templates.library.detail', event_name: 'fitness_template_added' })],
      now,
    );
    expect(createMany).toHaveBeenCalledOnce();
  });
  it('同一个账号的 Web/App 事件始终派生同一统计身份，重报跳过原事件', async () => {
    const keys = new Set<string>();
    const persisted: Array<{ actorKey: string; eventId: string; platform: string }> = [];
    const createMany = vi.fn(async ({ data }: { data: typeof persisted }) => {
      let count = 0;
      for (const row of data) {
        const key = `${row.actorKey}:${row.eventId}`;
        if (!keys.has(key)) {
          keys.add(key);
          persisted.push(row);
          count++;
        }
      }
      return { count };
    });
    const prisma = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
    expect(await ingestAnalyticsEvents(prisma, userId, [event()], now)).toEqual({ accepted: 1, duplicates: 0 });
    expect(await ingestAnalyticsEvents(prisma, userId, [event()], now)).toEqual({ accepted: 0, duplicates: 1 });
    await ingestAnalyticsEvents(
      prisma,
      userId,
      [
        event({
          event_id: '20000000-0000-4000-8000-000000000002',
          platform: 'app',
          page_id: 'accounting',
          event_name: 'accounting_view',
        }),
      ],
      now,
    );
    expect(new Set(persisted.map((row) => row.actorKey))).toEqual(new Set([analyticsActorKey(userId)]));
    expect(createMany.mock.calls[0]![0]).toMatchObject({ skipDuplicates: true });
  });
  it.each([{ occurred_at: '2025-01-01T00:00:00Z' }, { occurred_at: '2026-10-10T00:05:01Z' }, { page_id: undefined }])(
    '整批拒绝无效行为且不写入任何数据',
    async (overrides) => {
      const createMany = vi.fn();
      const prisma = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
      await expect(ingestAnalyticsEvents(prisma, userId, [event(), event(overrides)], now)).rejects.toThrow();
      expect(createMany).not.toHaveBeenCalled();
    },
  );
  it('无页面的前台活跃记录可以记录，统计身份不暴露原始用户 UUID', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    await ingestAnalyticsEvents(
      { productAnalyticsEvent: { createMany } } as unknown as PrismaClient,
      userId,
      [event({ kind: 'active', page_id: undefined, event_name: undefined })],
      now,
    );
    const row = createMany.mock.calls[0]![0].data[0];
    expect(row.actorKey).toMatch(/^[a-f0-9]{64}$/);
    expect(row.actorKey).not.toContain(userId);
    expect(row).not.toHaveProperty('userId');
  });
});
