import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import {
  ingestAnalyticsEvents,
  readAnalyticsReport,
  readAnalyticsDetails,
  readAnalyticsFunnel,
  readBannerStatistics,
  type AnalyticsEventInput,
} from '../src/modules/analytics/testing.js';

const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });
const now = new Date('2035-01-20T04:00:00Z');
const planBannerId = randomUUID();
const secondBannerId = randomUUID();
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterAll(async () => {
  try {
    await prisma.$disconnect();
  } finally {
    vi.useRealTimers();
  }
});

/** 所有统计夹具在事务结束时回滚，避免污染已登记的测试配置。 */
async function inRollback(operation: (tx: Prisma.TransactionClient) => Promise<void>) {
  const rollback = new Error('banner-analytics-rollback');
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

/** 为内置、当前在线及历史版本分别构造真实采集时间与可重传身份。 */
function event(overrides: Partial<AnalyticsEventInput> = {}): AnalyticsEventInput {
  return {
    event_id: randomUUID(),
    occurred_at: '2035-01-19T00:00:00Z',
    kind: 'action',
    event_name: 'banner_impression',
    platform: 'app',
    page_id: 'fitness.plans',
    session_id: randomUUID(),
    event_sequence: 1,
    banner_slot: 'fitness-plan-library',
    banner_source: 'remote',
    banner_version: 5,
    banner_id:
      overrides.banner_source === 'builtin'
        ? `builtin:${overrides.banner_slot ?? 'fitness-plan-library'}`
        : planBannerId,
    ...overrides,
  };
}

it('同一 Banner 跨日期版本位置累计，重传幂等、未来事件不计数且删除后不返回默认行', async () => {
  await inRollback(async (tx) => {
    await tx.productAnalyticsState.update({
      where: { id: 1 },
      data: { startedAt: new Date('2035-01-01'), bannerStartedAt: new Date('2035-01-18') },
    });
    const imageId = 'b'.repeat(64);
    await tx.appBannerMedia.upsert({
      where: { id: imageId },
      create: { id: imageId, fileName: 'test.webp', byteSize: 10, width: 30, height: 10 },
      update: {},
    });
    await tx.appBanner.updateMany({ data: { deletedAt: now, isEnabled: false } });
    await tx.appBanner.createMany({
      data: [
        {
          id: planBannerId,
          slot: 'fitness-plan-library',
          imageId,
          target: 'fitness-plan-library',
          isEnabled: true,
          version: 5,
          sortOrder: 0,
        },
        {
          id: secondBannerId,
          slot: 'fitness-plan-library',
          imageId,
          target: 'fitness-template-library',
          isEnabled: true,
          version: 5,
          sortOrder: 1,
        },
      ],
    });
    const input = [
      event({ occurred_at: '2035-01-18T16:00:00Z' }),
      event({ occurred_at: '2035-01-19T15:59:59.999Z' }),
      event({ event_name: 'banner_click' }),
      event({ event_name: 'banner_click' }),
      event({ event_name: 'banner_click' }),
      event({ occurred_at: '2035-01-18T15:59:59.999Z' }),
      event({ occurred_at: '2035-01-19T16:00:00Z' }),
      event({ banner_version: 4 }),
      event({ banner_version: 4, event_name: 'banner_click' }),
      event({
        occurred_at: '2035-01-17T00:00:00Z',
        page_id: 'fitness.templates',
        banner_slot: 'fitness-template-library',
        banner_version: 3,
      }),
      event({
        occurred_at: '2035-01-17T00:00:00Z',
        page_id: 'fitness.templates',
        banner_slot: 'fitness-template-library',
        banner_version: 3,
        event_name: 'banner_click',
      }),
      event({ occurred_at: now.toISOString() }),
      event({ occurred_at: new Date(now.getTime() + 1).toISOString() }),
      event({ occurred_at: new Date(now.getTime() + 1).toISOString(), event_name: 'banner_click' }),
      event({ banner_id: secondBannerId }),
      event({ banner_id: secondBannerId, event_name: 'banner_click' }),
      event({ banner_source: 'builtin', banner_version: 0 }),
      event({ banner_source: 'builtin', banner_version: 0, event_name: 'banner_click' }),
      event({
        page_id: 'fitness.templates',
        banner_slot: 'fitness-template-library',
        banner_source: 'builtin',
        banner_version: 0,
      }),
    ];
    const user = randomUUID();
    const client = { productAnalyticsEvent: tx.productAnalyticsEvent } as PrismaClient;
    expect(await ingestAnalyticsEvents(client, user, input, now)).toEqual({ accepted: input.length, duplicates: 0 });
    expect(await ingestAnalyticsEvents(client, user, input, now)).toEqual({ accepted: 0, duplicates: input.length });
    // 已保存的三维历史事实没有图片身份，不能被归入任意新轮播图。
    await tx.productAnalyticsEvent.create({
      data: {
        actorKey: 'a'.repeat(64),
        eventId: randomUUID(),
        kind: 'action',
        platform: 'app',
        pageId: 'fitness.plans',
        eventName: 'banner_impression',
        occurredAt: new Date('2035-01-19T00:00:00Z'),
        bannerSlot: 'fitness-plan-library',
        bannerSource: 'remote',
        bannerVersion: 5,
        bannerId: null,
      },
    });
    const database = {
      $transaction: async (run: (tx: Prisma.TransactionClient) => unknown) => run(tx),
    } as unknown as PrismaClient;
    const result = await readBannerStatistics(database, now);
    expect(result.scope).toBe('total');
    expect(result).not.toHaveProperty('range');
    expect(result.items).toEqual([
      {
        banner_id: planBannerId,
        slot: 'fitness-plan-library',
        source: 'remote',
        version: 5,
        impressions: 7,
        clicks: 5,
        ctr: 5 / 7,
      },
      {
        banner_id: secondBannerId,
        slot: 'fitness-plan-library',
        source: 'remote',
        version: 5,
        impressions: 1,
        clicks: 1,
        ctr: 1,
      },
    ]);
    expect(result.coverage.complete).toBe(true);
    await tx.appBanner.update({
      where: { id: planBannerId },
      data: { version: 6, slot: 'fitness-template-library', sortOrder: 99 },
    });
    expect(
      (await readBannerStatistics(database, now)).items.find((item) => item.banner_id === planBannerId),
    ).toMatchObject({
      banner_id: planBannerId,
      slot: 'fitness-template-library',
      version: 6,
      impressions: 7,
      clicks: 5,
      ctr: 5 / 7,
    });
    await tx.appBanner.update({ where: { id: planBannerId }, data: { deletedAt: now, isEnabled: false } });
    expect((await readBannerStatistics(database, now)).items.map((row) => row.banner_id)).toEqual([secondBannerId]);
    await tx.appBanner.update({ where: { id: secondBannerId }, data: { deletedAt: now, isEnabled: false } });
    const empty = await readBannerStatistics(database, now);
    expect(empty.items).toEqual([]);
    expect(empty.coverage.complete).toBe(true);
    expect(
      await tx.productAnalyticsEvent.count({
        where: {
          eventId: { in: input.filter((item) => item.banner_source === 'builtin').map((item) => item.event_id) },
        },
      }),
    ).toBe(3);
  });
});

it('曝光在行为分析保留次数和真实人数，不能抬高页面访问或页面排行', async () => {
  await inRollback(async (tx) => {
    await tx.productAnalyticsState.update({
      where: { id: 1 },
      data: { startedAt: new Date('2035-01-01'), bannerStartedAt: new Date('2035-01-19T01:00:00Z') },
    });
    const client = { productAnalyticsEvent: tx.productAnalyticsEvent } as PrismaClient;
    const user = randomUUID();
    const page = event({
      kind: 'page_view',
      event_name: 'fitness_plans_view',
      banner_slot: undefined,
      banner_id: undefined,
      banner_source: undefined,
      banner_version: undefined,
    });
    await ingestAnalyticsEvents(client, user, [page, event(), event(), event({ event_name: 'banner_click' })], now);
    const database = {
      $transaction: async (run: (tx: Prisma.TransactionClient) => unknown) => run(tx),
    } as unknown as PrismaClient;
    const range = { start_date: '2035-01-19', end_date: '2035-01-19' };
    const detail = await readAnalyticsDetails(database, {
      ...range,
      event_name: 'banner_impression',
      behavior: 'view',
    });
    expect(detail.summary.page_views).toBe(0);
    expect(detail.pages).toEqual([]);
    expect(detail.events).toEqual([]);
    expect(detail.exposures).toEqual([{ event_name: 'banner_impression', name: 'Banner_曝光', total: 2, users: 1 }]);
    expect(detail.coverage).toEqual({ collection_started_at: '2035-01-19T01:00:00.000Z', complete: false });
    const funnel = await readAnalyticsFunnel(database, {
      ...range,
      steps: ['banner_impression', 'banner_click'],
      scope: 'user',
      window_minutes: 30,
    });
    expect(funnel.coverage.collection_started_at).toBe('2035-01-19T01:00:00.000Z');
    expect(funnel.coverage.complete).toBe(false);
    expect(funnel.completion_rate).toBeNull();
    const overview = await readAnalyticsReport(database, range);
    expect(overview.summary.page_views).toBe(1);
    expect(overview.summary.active_users).toBe(1);
  });
});
