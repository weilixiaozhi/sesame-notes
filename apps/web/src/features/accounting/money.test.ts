import { describe, expect, it } from 'vitest';
import { canonicalAmount, canonicalEntryAmount, localDateTime, roundEntryAmount, sumAmounts } from './money';

describe('accounting decimal amounts', () => {
  it('手工记账只接受两位小数，并支持键盘结束的小数点', () => {
    expect(canonicalEntryAmount('12.34')).toBe('12.34');
    expect(canonicalEntryAmount('12.')).toBe('12');
    expect(canonicalEntryAmount('0.01')).toBe('0.01');
    expect(canonicalEntryAmount('12.340')).toBeNull();
    expect(canonicalEntryAmount('0.001')).toBeNull();
    expect(canonicalEntryAmount('9999999999999999999999999999.99')).toBe('9999999999999999999999999999.99');
  });
  it('编辑已有金额时按分银行家舍入，与客户端显示一致', () => {
    expect(roundEntryAmount('1.245')).toBe('1.24');
    expect(roundEntryAmount('1.255')).toBe('1.26');
    expect(roundEntryAmount('9999999999999999999999999999.994')).toBe('9999999999999999999999999999.99');
    expect(roundEntryAmount('0.001')).toBe('0.00');
  });
  it('canonicalizes user input without precision loss', () => {
    expect(canonicalAmount(' 00012.3400 ')).toBe('12.34');
    expect(canonicalAmount('9999999999999999999999999999.1234567891')).toBe('9999999999999999999999999999.1234567891');
    expect(canonicalAmount('0.0000000001')).toBe('0.0000000001');
  });
  it.each([
    '0',
    '0.000',
    '-1',
    '1e3',
    '1,000',
    '1.',
    '.1',
    'NaN',
    '',
    '1.12345678901',
    '10000000000000000000000000000',
  ])('rejects invalid amount %s', (input) => {
    expect(canonicalAmount(input)).toBeNull();
  });
  it('sums decimal values exactly', () => {
    expect(sumAmounts(['0.1', '0.2'])).toBe('0.3');
    expect(sumAmounts(['9999999999999999999999999999.9999999999', '0.0000000001'])).toBe(
      '10000000000000000000000000000',
    );
    expect(sumAmounts([])).toBe('0');
  });
  it('formats a local date without a timezone shift', () => {
    expect(localDateTime(new Date(2026, 8, 30, 23, 5))).toBe('2026-09-30T23:05');
  });
});
