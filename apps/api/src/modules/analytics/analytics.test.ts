import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { analyticsRange, fillAnalyticsSeries, readAnalyticsReport } from './analytics-service.js';

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
