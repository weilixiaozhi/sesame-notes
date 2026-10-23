import { describe, expect, it } from 'vitest';
import { equalAmounts } from './aa-money';
import { canonicalRate, inverseRate } from './currency-math';
import { billingRange, currentBillingMonth, customDateRange } from './accounting-periods';
import { sumAmounts } from './money';

describe('AA and currency precision', () => {
  it('assigns the exact cent remainder to the payer', () => {
    expect(equalAmounts('10', 3, 1)).toEqual(['3.33', '3.34', '3.33']);
    expect(sumAmounts(equalAmounts('1.12', 3, -1))).toBe('1.12');
    expect(() => equalAmounts('1.123', 3, -1)).toThrow();
    expect(equalAmounts('1000000000000000000000000000', 2, 0)).toEqual([
      '500000000000000000000000000',
      '500000000000000000000000000',
    ]);
  });
  it('does not generate zero shares or divide by zero', () => {
    expect(() => equalAmounts('0.01', 2, 0)).toThrow();
    expect(() => equalAmounts('1', 0, 0)).toThrow();
  });
  it('inverts reference rates at eighteen decimal places without binary rounding', () => {
    expect(inverseRate('2')).toBe('0.5');
    expect(inverseRate('3')).toBe('0.333333333333333333');
    expect(inverseRate('7')).toBe('0.142857142857142857');
    expect(inverseRate('0.5')).toBe('2');
    expect(canonicalRate('0001.230000')).toBe('1.23');
    expect(canonicalRate('0')).toBeNull();
    expect(canonicalRate('1e8')).toBeNull();
  });
});

describe('local billing periods', () => {
  it('clamps month-end billing starts in leap and nonleap years', () => {
    const leap = billingRange('2024-02', 31);
    expect(new Date(leap.start_at).getDate()).toBe(29);
    expect(new Date(leap.end_at).getDate()).toBe(31);
    expect(new Date(billingRange('2025-02', 31).start_at).getDate()).toBe(28);
  });
  it('selects the preceding billing month before the start day', () => {
    expect(currentBillingMonth(15, new Date(2026, 0, 10))).toBe('2025-12');
    expect(currentBillingMonth(15, new Date(2026, 0, 15))).toBe('2026-01');
  });
  it('treats the end date as inclusive but sends the following midnight', () => {
    const range = customDateRange('2026-09-30', '2026-09-30');
    expect(new Date(range.start_at).getDate()).toBe(30);
    expect(new Date(range.end_at).getDate()).toBe(1);
    expect(() => customDateRange('2026-09-30', '2026-09-29')).toThrow();
    expect(() => customDateRange('2026-02-30', '2026-03-01')).toThrow();
  });
});
