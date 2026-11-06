import { describe, expect, it } from 'vitest';
import { periodRange, sumVolume } from './statistics-model';

describe('健身统计日期与精确聚合', () => {
  it('周跨年从周一到周日，闰年自然月保留二月二十九日', () => {
    expect(periodRange('week', '2027-01-01')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
    expect(periodRange('month', '2028-02-29')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodRange('year', '2028-06-30')).toEqual({ start: '2028-01-01', end: '2028-12-31' });
  });
  it('大数和十位小数训练量不经过浮点', () => {
    expect(sumVolume(['9999999999999999990.1234567890', '10.8765432111'])).toBe('10000000000000000001.0000000001');
    expect(sumVolume(['0.1', '0.2'])).toBe('0.3');
  });
});
