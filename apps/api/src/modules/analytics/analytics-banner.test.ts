import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { AnalyticsEventSchema, type AnalyticsEventInput } from './analytics-contract.js';
import { ANALYTICS_DEFINITION_MAP } from './analytics-catalog.js';
import { ingestAnalyticsEvents } from './analytics-service.js';
import { readBannerStatistics } from './analytics-banner-statistics.js';
import { BannerStatisticsSchema } from './analytics-banner-contract.js';

const now = new Date('2026-10-29T08:00:00Z');
const remoteId = randomUUID();
const originalFormats = FormatRegistry.Entries();
beforeAll(() => {
  FormatRegistry.Set('uuid', (value) => /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value));
  FormatRegistry.Set('date-time', (value) => Number.isFinite(Date.parse(value)));
});
afterAll(() => {
  for (const name of ['uuid', 'date-time']) {
    const previous = originalFormats.get(name);
    if (previous) FormatRegistry.Set(name, previous);
    else FormatRegistry.Delete(name);
  }
});

/** 事件携带采集时的素材身份，重传保持同一个 UUID 和会话序号。 */
function bannerEvent(overrides: Partial<AnalyticsEventInput> = {}): AnalyticsEventInput {
  return {
    event_id: randomUUID(),
    occurred_at: now.toISOString(),
    kind: 'action',
    event_name: 'banner_impression',
    page_id: 'fitness.plans',
    platform: 'app',
    session_id: randomUUID(),
    event_sequence: 1,
    banner_slot: 'fitness-plan-library',
    banner_source: 'builtin',
    banner_version: 0,
    banner_id:
      overrides.banner_source === 'remote' ? remoteId : `builtin:${overrides.banner_slot ?? 'fitness-plan-library'}`,
    ...overrides,
  };
}

describe('Banner 受控采集维度', () => {
  it.each(['banner_impression', 'banner_click'] as const)(
    '固定事件 %s 保存同一素材身份且注册到采集目录',
    async (event_name) => {
      const createMany = vi.fn().mockResolvedValue({ count: 1 });
      const event = bannerEvent({ event_name, banner_source: 'remote', banner_version: 7 });
      const db = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
      expect(Value.Check(AnalyticsEventSchema, event)).toBe(true);
      expect(await ingestAnalyticsEvents(db, randomUUID(), [event], now)).toEqual({ accepted: 1, duplicates: 0 });
      expect(createMany.mock.calls[0]![0].data[0]).toMatchObject({
        kind: 'action',
        eventName: event_name,
        eventId: event.event_id,
        eventSequence: 1,
        bannerSlot: 'fitness-plan-library',
        bannerId: remoteId,
        bannerSource: 'remote',
        bannerVersion: 7,
      });
      expect(ANALYTICS_DEFINITION_MAP.get(event_name)).toMatchObject({
        kind: 'action',
        behavior: event_name === 'banner_impression' ? 'view' : 'click',
        platforms: ['app'],
      });
    },
  );

  it.each([
    { banner_slot: undefined },
    { banner_id: undefined },
    { banner_id: 'not-a-uuid', banner_source: 'remote', banner_version: 1 },
    { banner_id: remoteId },
    { banner_id: 'builtin:fitness-template-library' },
    { banner_source: undefined },
    { banner_version: undefined },
    { banner_slot: 'unknown' },
    { banner_source: 'unknown' },
    { banner_source: 'builtin', banner_version: 1 },
    { banner_source: 'remote', banner_version: 0 },
    { banner_version: -1 },
    { banner_version: 1.5 },
    { banner_version: null },
    { banner_slot: 'fitness-template-library' },
    { page_id: 'fitness' },
    { platform: 'web' },
    { kind: 'page_view' },
  ])('整批拒绝缺失或矛盾的归因 %j', async (overrides) => {
    const createMany = vi.fn();
    const db = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
    await expect(
      ingestAnalyticsEvents(
        db,
        randomUUID(),
        [bannerEvent(), bannerEvent(overrides as Partial<AnalyticsEventInput>)],
        now,
      ),
    ).rejects.toMatchObject({ code: 'ANALYTICS_BANNER_INVALID' });
    expect(createMany).not.toHaveBeenCalled();
  });

  it.each(['banner_id', 'banner_slot', 'banner_source', 'banner_version'] as const)(
    '普通事件不能携带专属字段 %s',
    async (field) => {
      const original = bannerEvent();
      const event = {
        ...original,
        kind: 'page_view',
        event_name: 'fitness_plans_view',
        banner_slot: undefined,
        banner_id: undefined,
        banner_source: undefined,
        banner_version: undefined,
        [field]: original[field],
      } as AnalyticsEventInput;
      const createMany = vi.fn();
      await expect(
        ingestAnalyticsEvents(
          { productAnalyticsEvent: { createMany } } as unknown as PrismaClient,
          randomUUID(),
          [event],
          now,
        ),
      ).rejects.toMatchObject({ code: 'ANALYTICS_BANNER_INVALID' });
      expect(createMany).not.toHaveBeenCalled();
    },
  );

  it('模板位只能在模板页记录，超过现有补报时限的真实 Banner 事件仍被拒绝', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { productAnalyticsEvent: { createMany } } as unknown as PrismaClient;
    const event = bannerEvent({ banner_slot: 'fitness-template-library', page_id: 'fitness.templates' });
    await expect(ingestAnalyticsEvents(db, randomUUID(), [event], now)).resolves.toMatchObject({ accepted: 1 });
    await expect(
      ingestAnalyticsEvents(db, randomUUID(), [{ ...event, occurred_at: '2026-01-01T00:00:00Z' }], now),
    ).rejects.toMatchObject({ code: 'ANALYTICS_EVENT_TIME_INVALID' });
  });
});

describe('Banner 累计统计口径', () => {
  it('零曝光保持不可计算，多次真实点击的比率不截断，并标明采集起点', async () => {
    const tx = {
      productAnalyticsState: {
        findUnique: vi.fn().mockResolvedValue({ bannerStartedAt: new Date('2026-10-29T00:00:00Z') }),
      },
      $queryRaw: vi.fn().mockResolvedValue([
        {
          banner_id: remoteId,
          slot: 'fitness-plan-library',
          source: 'remote',
          version: 4,
          impressions: 2n,
          clicks: 3n,
        },
        {
          banner_id: randomUUID(),
          slot: 'fitness-template-library',
          source: 'remote',
          version: 1,
          impressions: 0n,
          clicks: 0n,
        },
      ]),
    };
    const db = {
      $transaction: async (operation: (database: typeof tx) => unknown) => operation(tx),
    } as unknown as PrismaClient;
    const result = await readBannerStatistics(db, now);
    expect(result.scope).toBe('total');
    expect(result).not.toHaveProperty('range');
    expect(result.items.map((item) => item.ctr)).toEqual([1.5, null]);
    expect(result.coverage).toEqual({
      collection_started_at: '2026-10-29T00:00:00.000Z',
      complete: true,
      audience: 'authenticated_users',
    });
    expect(Value.Check(BannerStatisticsSchema, result)).toBe(true);
    const sql = tx.$queryRaw.mock.calls[0]![0];
    expect(sql.values).toEqual([now]);
  });

  it('没有自定义 Banner 时返回空累计列表，不伪造默认图记录', async () => {
    const tx = {
      productAnalyticsState: { findUnique: vi.fn().mockResolvedValue({ bannerStartedAt: now }) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const db = {
      $transaction: async (operation: (database: typeof tx) => unknown) => operation(tx),
    } as unknown as PrismaClient;
    const result = await readBannerStatistics(db, now);
    expect(result.items).toEqual([]);
    expect(Value.Check(BannerStatisticsSchema, result)).toBe(true);
  });
});
