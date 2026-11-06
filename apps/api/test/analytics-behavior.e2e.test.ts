import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import {
  analyticsActorKey,
  ingestAnalyticsEvents,
  readAnalyticsReport,
  readAnalyticsDetails,
  readAnalyticsFunnel,
  type AnalyticsEventInput,
} from '../src/modules/analytics/testing.js';

const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2035-01-20T04:00:00Z'));
});
afterAll(async () => {
  try {
    await prisma.$disconnect();
  } finally {
    vi.useRealTimers();
  }
});

/** 所有真实 SQL 夹具置于独立事务，结束时整体回滚，不留下统计事件、账号或元数据。 */
async function inRollback(operation: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>) {
  const rollback = new Error('analytics-test-rollback');
  try {
    await prisma.$transaction(
      async (tx) => {
        await operation(tx);
        throw rollback;
      },
      { timeout: 30_000 },
    );
  } catch (cause) {
    if (cause !== rollback) throw cause;
  }
}

it.each([null, 'accounting', 'fitness_view'])('数据库拒绝页面访问缺失或错配的事件标识 %s', async (eventName) => {
  await inRollback(async (tx) => {
    await expect(
      tx.productAnalyticsEvent.create({
        data: {
          actorKey: analyticsActorKey(randomUUID()),
          eventId: randomUUID(),
          kind: 'page_view',
          occurredAt: new Date(),
          platform: 'web',
          pageId: 'accounting',
          eventName,
        },
      }),
    ).rejects.toThrow('product_analytics_source_check');
  });
});

it('页面、动作与行为筛选独立去重，活跃和注册事实进入整体报表', async () => {
  await inRollback(async (tx) => {
    const now = new Date('2035-01-15T04:00:00Z');
    const date = '2035-01-15';
    const yesterday = new Date('2035-01-14T00:00:00Z');
    await tx.productAnalyticsState.update({
      where: { id: 1 },
      data: { startedAt: yesterday },
    });
    const users = Array.from({ length: 6 }, () => randomUUID());
    /** 同一账号可跨端到达路径，重传保持 UUID；相同时间的两个动作不能推进路径。 */
    async function action(
      actor: number,
      event_name: AnalyticsEventInput['event_name'],
      offset: number,
      platform: 'app' | 'web' = 'web',
    ) {
      const event: AnalyticsEventInput = {
        event_id: randomUUID(),
        occurred_at: new Date(now.getTime() + offset).toISOString(),
        platform,
        kind: 'action',
        event_name,
        page_id: event_name?.endsWith('create_click') ? 'accounting' : 'accounting.transaction.editor',
        session_id: randomUUID(),
        event_sequence: 1,
      };
      const client = { productAnalyticsEvent: tx.productAnalyticsEvent } as PrismaClient;
      expect(await ingestAnalyticsEvents(client, users[actor]!, [event], now)).toEqual({ accepted: 1, duplicates: 0 });
      expect(await ingestAnalyticsEvents(client, users[actor]!, [event], now)).toEqual({ accepted: 0, duplicates: 1 });
    }
    await action(0, 'accounting_transaction_create_click', 0, 'app');
    await action(0, 'accounting_transaction_create_click', 1);
    await action(0, 'accounting_transaction_created', 2);
    await action(0, 'accounting_transaction_created', 3);
    await action(1, 'accounting_transaction_created', 0);
    await action(1, 'accounting_transaction_create_click', 3);
    await action(2, 'accounting_transaction_create_click', 0);
    await action(2, 'accounting_transaction_created', 0);
    await action(3, 'accounting_transaction_create_click', 0);
    await action(3, 'accounting_transaction_updated', 3);
    await tx.productAnalyticsEvent.createMany({
      data: [
        ...['accounting', 'accounting.statistics'].map((pageId) => ({
          actorKey: analyticsActorKey(users[0]!),
          eventId: randomUUID(),
          kind: 'page_view',
          occurredAt: now,
          platform: 'web',
          pageId,
          eventName: `${pageId.replaceAll('.', '_')}_view`,
        })),
        {
          actorKey: analyticsActorKey(users[4]!),
          eventId: randomUUID(),
          kind: 'active',
          occurredAt: now,
          platform: 'app',
        },
        { actorKey: analyticsActorKey(users[5]!), eventId: randomUUID(), kind: 'registration', occurredAt: now },
      ],
    });
    const database = {
      $transaction: async (run: (database: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as PrismaClient;
    const query = { start_date: date, end_date: date };
    const result = await readAnalyticsDetails(database, query);
    expect(result.summary).toEqual({
      page_views: 2,
      visitors: 1,
      clicks: 5,
      click_users: 4,
      completions: 5,
      completion_users: 4,
    });
    expect(result).not.toHaveProperty('categories');
    expect(result.pages.map((page) => page.visitors)).toEqual([1, 1]);
    expect(result.pages.map((page) => page.event_name).sort()).toEqual([
      'accounting_statistics_view',
      'accounting_view',
    ]);
    expect(result.pages[0]).not.toHaveProperty('category_id');
    expect(result.events[0]).not.toHaveProperty('category_id');
    expect(result.series.reduce((sum, row) => sum + row.page_views, 0)).toBe(2);
    const funnelQuery = {
      ...query,
      steps: ['accounting_transaction_create_click', 'accounting_transaction_created'],
      scope: 'user' as const,
      window_minutes: 30,
    };
    expect(await readAnalyticsFunnel(database, funnelQuery)).toMatchObject({
      completion_rate: 0.25,
      steps: [{ users: 4 }, { users: 1, drop_off: 3, conversion_rate: 0.25 }],
    });
    const appOnly = await readAnalyticsFunnel(database, { ...funnelQuery, platform: 'app' });
    expect(appOnly).toMatchObject({
      completion_rate: 0,
      steps: [{ users: 1 }, { users: 0, drop_off: 1, conversion_rate: 0 }],
    });
    const viewed = await readAnalyticsDetails(database, { ...query, behavior: 'view' });
    expect(viewed.summary).toEqual({
      page_views: 2,
      visitors: 1,
      clicks: 0,
      click_users: 0,
      completions: 0,
      completion_users: 0,
    });
    expect(viewed.events).toEqual([]);
    const accountingVisit = await readAnalyticsDetails(database, {
      ...query,
      behavior: 'view',
      event_name: 'accounting_view',
    });
    expect(accountingVisit.summary).toMatchObject({ page_views: 1, visitors: 1, clicks: 0 });
    expect(accountingVisit.pages).toEqual([
      { page_id: 'accounting', event_name: 'accounting_view', name: '记账_首页_访问', page_views: 1, visitors: 1 },
    ]);
    await expect(
      readAnalyticsDetails(database, { ...query, event_name: 'accounting_view', page_id: 'accounting.statistics' }),
    ).rejects.toThrow('筛选条件不匹配');
    expect(viewed).not.toHaveProperty('funnels');
    const clicked = await readAnalyticsDetails(database, { ...query, behavior: 'click' });
    expect(clicked.summary).toEqual({
      page_views: 0,
      visitors: 0,
      clicks: 5,
      click_users: 4,
      completions: 0,
      completion_users: 0,
    });
    expect(clicked.pages).toEqual([]);
    const completed = await readAnalyticsDetails(database, { ...query, behavior: 'complete' });
    expect(completed.summary).toEqual({
      page_views: 0,
      visitors: 0,
      clicks: 0,
      click_users: 0,
      completions: 5,
      completion_users: 4,
    });
    expect((await readAnalyticsDetails(database, { ...query, page_id: 'accounting' })).summary.page_views).toBe(1);
    const created = await readAnalyticsDetails(database, { ...query, event_name: 'accounting_transaction_created' });
    expect(created.summary.completions).toBe(4);
    expect(created.summary.completion_users).toBe(3);
    expect(created).not.toHaveProperty('funnels');
    const overview = await readAnalyticsReport(database, query);
    expect(overview.summary).toEqual({ new_users: 1, active_users: 5, page_views: 2 });
    const incomplete = await readAnalyticsDetails(database, { ...query, start_date: '2035-01-13' });
    expect(incomplete.coverage.complete).toBe(false);
    const incompleteFunnel = await readAnalyticsFunnel(database, { ...funnelQuery, start_date: '2035-01-13' });
    expect(incompleteFunnel.completion_rate).toBeNull();
    expect(incompleteFunnel.coverage.complete).toBe(false);
    await tx.productAnalyticsState.update({ where: { id: 1 }, data: { startedAt: new Date('2035-01-12') } });
    const editor = await readAnalyticsDetails(database, {
      start_date: '2035-01-13',
      end_date: '2035-01-13',
      page_id: 'accounting.transaction.editor',
    });
    expect(editor.coverage.complete).toBe(true);
    const homepage = await readAnalyticsDetails(database, {
      start_date: '2035-01-13',
      end_date: '2035-01-13',
      page_id: 'accounting',
    });
    expect(homepage.coverage.complete).toBe(true);
  });
}, 30_000);

it('同毫秒按同会话采集顺序推进，保留不可比较候选并隔离逆序、跨会话和跨流程', async () => {
  await inRollback(async (tx) => {
    const start = Date.parse('2035-01-18T04:00:00Z');
    await tx.productAnalyticsState.update({ where: { id: 1 }, data: { startedAt: new Date('2035-01-01') } });
    const actors = Array.from({ length: 7 }, () => analyticsActorKey(randomUUID()));
    const sessions = Array.from({ length: 10 }, () => randomUUID());
    const flows = Array.from({ length: 8 }, () => randomUUID());
    const data: Array<{
      actorKey: string;
      eventId: string;
      kind: string;
      occurredAt: Date;
      platform: string;
      pageId: string;
      eventName: string | null;
      sessionId: string;
      eventSequence: number;
      flowId: string;
    }> = [];
    /** 事件时间保持真实毫秒值，序号仅表示同一运行会话内的实际采集先后。 */
    function add(
      actor: number,
      step: number,
      offset: number,
      sequence: number,
      session = sessions[actor]!,
      flow = flows[actor]!,
    ) {
      data.push({
        actorKey: actors[actor]!,
        eventId: randomUUID(),
        kind: step ? 'action' : 'page_view',
        occurredAt: new Date(start + offset),
        platform: 'web',
        pageId: 'fitness.workout',
        eventName:
          step === 1 ? 'fitness_workout_started' : step === 2 ? 'fitness_workout_completed' : 'fitness_workout_view',
        sessionId: session,
        eventSequence: sequence,
        flowId: flow,
      });
    }
    add(0, 0, 0, 1);
    add(0, 1, 0, 2);
    add(0, 2, 0, 3);
    add(1, 0, 0, 2);
    add(1, 1, 0, 1);
    add(1, 2, 0, 3);
    add(2, 0, 0, 1);
    add(2, 1, 0, 2, sessions[7]!);
    add(2, 2, 0, 3, sessions[7]!);
    // 第二步在同一毫秒来自两个会话，只有后一会话在该毫秒继续完成，不能任意丢掉它。
    add(3, 0, 0, 1);
    add(3, 1, 1, 1, sessions[7]!);
    add(3, 1, 1, 1, sessions[8]!);
    add(3, 2, 1, 2, sessions[8]!);
    // 同一会话的两个候选必须保留更小序号，否则会错误地把完成判断为逆序。
    add(4, 0, 0, 1);
    add(4, 1, 1, 1, sessions[9]!);
    add(4, 1, 1, 3, sessions[9]!);
    add(4, 2, 1, 2, sessions[9]!);
    add(5, 0, 0, 1);
    add(5, 1, 0, 2);
    add(5, 0, 60_000, 3);
    add(5, 1, 60_000, 4);
    add(5, 2, 60_001, 5);
    add(6, 0, 0, 1);
    add(6, 1, 0, 2, sessions[6]!, flows[7]!);
    add(6, 2, 0, 3, sessions[6]!, flows[7]!);
    expect((await tx.productAnalyticsEvent.createMany({ data: [...data, data[0]!], skipDuplicates: true })).count).toBe(
      data.length,
    );
    const database = {
      $transaction: async (run: (database: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as PrismaClient;
    const query = {
      start_date: '2035-01-18',
      end_date: '2035-01-18',
      steps: ['fitness_workout_view', 'fitness_workout_started', 'fitness_workout_completed'],
      window_minutes: 1,
    };
    for (const [scope, users] of [
      ['user', 5],
      ['session', 3],
      ['flow', 4],
    ] as const) {
      const result = await readAnalyticsFunnel(database, { ...query, scope });
      expect(result.steps.map((step) => step.users)).toEqual([7, users, users]);
      expect(result.completion_rate).toBe(users / 7);
    }
  });
}, 30_000);
