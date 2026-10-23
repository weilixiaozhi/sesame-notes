import { describe, expect, it } from 'vitest';
import { amountPercent, dailyAverage, periodChange, previousRange, rangeDays, weekRange } from './accounting-analytics';

describe('accounting analytics', () => {
  it('computes chart percentages and averages beyond floating point precision', () => {
    expect(amountPercent('9999999999999999999999999999', '9999999999999999999999999999')).toBe(100);
    expect(amountPercent('0.1', '0.3')).toBe(33.33);
    expect(dailyAverage('0.3', 3)).toBe('0.10');
    expect(dailyAverage('1', 3)).toBe('0.33');
    expect(dailyAverage('9999999999999999999999999999', 3)).toBe('3,333,333,333,333,333,333,333,333,333.00');
  });
  it('将日均按分四舍五入，临界值与大额金额均保留正确结果', () => {
    expect(dailyAverage('0.0049999999', 1)).toBe('0.00');
    expect(dailyAverage('0.005', 1)).toBe('0.01');
    expect(dailyAverage('0.01', 2)).toBe('0.01');
    expect(dailyAverage('9999999999999999999999999999.995', 1)).toBe('10,000,000,000,000,000,000,000,000,000.00');
    expect(dailyAverage('10', 0)).toBe('—');
  });
  it('handles zero-baseline comparisons without NaN or infinity', () => {
    expect(periodChange('2', '0')).toBe('上期无支出');
    expect(periodChange('0', '0')).toBe('与上期持平');
    expect(periodChange('0.3', '0.2')).toBe('+50.00%');
    expect(periodChange('1', '2')).toBe('−50.00%');
  });
  it('uses Monday week boundaries and keeps prior monthly billing semantics', () => {
    const range = weekRange('2026-09-30');
    expect(new Date(range.start_at).getDay()).toBe(1);
    expect(new Date(range.start_at).getDate()).toBe(28);
    expect(rangeDays(range.start_at, range.end_at)).toBe(7);
    const previous = previousRange('month', '2024-03', '2024-03-05', 31)!;
    expect(new Date(previous.start_at).getDate()).toBe(29);
    expect(new Date(previous.end_at).getDate()).toBe(31);
    expect(rangeDays(previous.start_at, previous.end_at)).toBe(31);
  });
});
