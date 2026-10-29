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

it('当前素材按位置来源版本统计，重传幂等且恢复默认只显示内置数据', async () => {
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
    const range = { start_date: '2035-01-19', end_date: '2035-01-19' };
    const result = await readBannerStatistics(database, range, now);
    expect(result.items).toEqual([
      {
        banner_id: planBannerId,
        slot: 'fitness-plan-library',
        source: 'remote',
        version: 5,
        impressions: 2,
        clicks: 3,
        ctr: 1.5,
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
      {
        banner_id: 'builtin:fitness-template-library',
        slot: 'fitness-template-library',
        source: 'builtin',
        version: 0,
        impressions: 1,
        clicks: 0,
        ctr: 0,
      },
    ]);
    expect(result.coverage.complete).toBe(true);
    await tx.appBanner.update({
      where: { id: planBannerId },
      data: { version: 6 },
    });
    expect((await readBannerStatistics(database, range, now)).items[0]).toMatchObject({
      banner_id: planBannerId,
      version: 6,
      impressions: 0,
      clicks: 0,
      ctr: null,
    });
    await tx.appBanner.update({ where: { id: planBannerId }, data: { deletedAt: now, isEnabled: false } });
    expect((await readBannerStatistics(database, range, now)).items.map((row) => row.banner_id)).toEqual([
      secondBannerId,
      'builtin:fitness-template-library',
    ]);
    await tx.appBanner.update({ where: { id: secondBannerId }, data: { deletedAt: now, isEnabled: false } });
    expect((await readBannerStatistics(database, range, now)).items[0]).toEqual({
      banner_id: 'builtin:fitness-plan-library',
      slot: 'fitness-plan-library',
      source: 'builtin',
      version: 0,
      impressions: 1,
      clicks: 1,
      ctr: 1,
    });
    const empty = await readBannerStatistics(database, { start_date: '2035-01-17', end_date: '2035-01-17' }, now);
    expect(empty.coverage.complete).toBe(false);
    expect(empty.items.every((item) => item.impressions === 0 && item.clicks === 0 && item.ctr === null)).toBe(true);
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
