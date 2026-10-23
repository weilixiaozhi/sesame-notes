import type { components } from '@sesame-notes/api-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { groupTransactionsByDay } from './transaction-timeline';
type Transaction = components['schemas']['Transaction'];

/** 以本地日期构造完整交易，保证测试不依赖执行机器的时区。 */
function transaction(id: string, happened: Date | string, amount = '29'): Transaction {
  const happenedAt = typeof happened === 'string' ? happened : happened.toISOString();
  return {
    id,
    ledger_id: 'daily-ledger',
    tx_type: 'expense',
    amount,
    happened_at: happenedAt,
    note: id,
    category_id: null,
    category_name: null,
    category_kind: null,

    currency_code: 'CNY',
    native_amount: amount,
    recurring_id: null,
    occurrence_date: null,
    created_by_member_id: null,
    last_edited_by_member_id: null,
    payer_member_id: null,
    aa_mode: null,
    splits: [],
    revision: 1,
    last_edited_at: null,
    updated_at: happenedAt,
    created_at: happenedAt,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 0, 1, 12));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('以本地午夜分日，跨年的昨天仍归为昨天，并保持同日服务端顺序', () => {
  const earlyToday = transaction('凌晨', new Date(2026, 0, 1, 0, 1));
  const lateYesterday = transaction('昨晚', new Date(2025, 11, 31, 23, 59));
  const laterToday = transaction('早餐', new Date(2026, 0, 1, 9));
  const groups = groupTransactionsByDay([earlyToday, lateYesterday, laterToday]);

  expect(groups.map(({ date, label }) => ({ date, label }))).toEqual([
    { date: '2026-01-01', label: '今天' },
    { date: '2025-12-31', label: '昨天' },
  ]);
  expect(groups[0]!.items.map(({ id }) => id)).toEqual(['凌晨', '早餐']);
});

it('跨年历史记录显示年份，避免不同年份的相同月日混淆', () => {
  const groups = groupTransactionsByDay([
    transaction('去年', new Date(2025, 9, 8, 12)),
    transaction('前年', new Date(2024, 9, 8, 12)),
  ]);

  expect(groups.map(({ date }) => date)).toEqual(['2025-10-08', '2024-10-08']);
  expect(groups[0]!.label).toContain('2025');
  expect(groups[1]!.label).toContain('2024');
});
