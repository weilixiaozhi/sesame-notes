import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

import { validateAaFields, validateAaSplitTotals } from '../src/modules/accounting/testing.js';
import { decimalToCanonical } from '../src/shared/decimal.js';

describe('AA 指定金额', () => {
  it('精确求和，不受二进制浮点 0.1 + 0.2 影响', () => {
    expect(() =>
      validateAaSplitTotals('0.3', [
        { member_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c761', amount: '0.1' },
        { member_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c762', amount: '0.2' },
      ]),
    ).not.toThrow();
  });

  it('拒绝分摊总和与本位币快照不相等', () => {
    expect(() =>
      validateAaSplitTotals('0.3000000001', [
        { member_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c761', amount: '0.1' },
        { member_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c762', amount: '0.2' },
      ]),
    ).toThrow('AA_SPLIT_TOTAL_MISMATCH');
  });

  it.each([
    ['100000000000000000000', '0.0000000001'],
    ['0.0000000001', '100000000000000000000'],
  ])('大额与最小单位分摊相加仍保留全部精度：%s + %s', (first, second) => {
    const splits = [
      { member_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c761', amount: first },
      { member_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c762', amount: second },
    ];
    expect(() => validateAaSplitTotals('100000000000000000000.0000000001', splits)).not.toThrow();
    expect(() => validateAaSplitTotals('100000000000000000000', splits)).toThrow('AA_SPLIT_TOTAL_MISMATCH');
  });

  it('支持二十八位整数和十位小数的协议金额上界，并拒绝一单位差额', () => {
    const maximum = '9999999999999999999999999999.9999999999';
    const splits = [
      {
        member_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c761',
        amount: '9999999999999999999999999999.9999999998',
      },
      { member_id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c762', amount: '0.0000000001' },
    ];
    expect(() => validateAaSplitTotals(maximum, splits)).not.toThrow();
    expect(() =>
      validateAaSplitTotals(maximum, [{ ...splits[0]! }, { ...splits[1]!, amount: '0.0000000002' }]),
    ).toThrow('AA_SPLIT_TOTAL_MISMATCH');
  });

  it('每行参与人必须是有效的账本级成员引用', () => {
    expect(() => validateAaFields('1', 2, [{ member_id: null, amount: '1' }])).toThrow('INVALID_AA_PARTICIPANT');
    expect(() => validateAaFields('1', 2, [{ amount: '1' }])).toThrow('INVALID_AA_PARTICIPANT');
    expect(() => validateAaFields('1', 2, [{ member_id: 'not-a-uuid', amount: '1' }])).toThrow(
      'INVALID_AA_PARTICIPANT',
    );
  });

  it('拒绝同一参与人重复出现，避免统计时被重复计入', () => {
    const memberId = '018f7f95-4b8a-4f5e-8d0c-2ebf4682c761';
    expect(() =>
      validateAaFields('1', 2, [
        { member_id: memberId, amount: '0.4' },
        { member_id: memberId, amount: '0.6' },
      ]),
    ).toThrow('DUPLICATE_AA_PARTICIPANT');
  });
});

describe('Decimal 协议舍入', () => {
  it('在精度边界显式使用 round-half-even', () => {
    expect(decimalToCanonical(new Prisma.Decimal('1.23456789015'), 10)).toBe('1.2345678902');
    expect(decimalToCanonical(new Prisma.Decimal('1.23456789025'), 10)).toBe('1.2345678902');
  });
});
