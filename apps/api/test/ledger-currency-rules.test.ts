import { expect, it } from 'vitest';
import { recalculateCurrencyTransaction } from '../src/modules/accounting/testing.js';

const first = '00000000-0000-4000-8000-000000000001';
const payer = '00000000-0000-4000-8000-000000000002';
const transaction = {
  amount: '10',
  nativeAmount: '70',
  currencyCode: 'USD',
  aaMode: null,
  payerMemberId: null,
  splits: [],
};

it('原币乘以目标本币汇率，原币与目标相同时使用原金额', () => {
  expect(recalculateCurrencyTransaction(transaction, 'EUR', { USD: '0.9' })).toEqual({ nativeAmount: '9', splits: [] });
  expect(recalculateCurrencyTransaction(transaction, 'USD', {})).toEqual({ nativeAmount: '10', splits: [] });
});
it('38位金额不经过浮点或Decimal默认20位精度', () => {
  const amount = '1234567890123456789012345678.1234567891';
  expect(recalculateCurrencyTransaction({ ...transaction, amount }, 'EUR', { USD: '2' }).nativeAmount).toBe(
    '2469135780246913578024691356.2469135782',
  );
});
it.each([
  ['0.0000000003', '0.0000000002'],
  ['0.0000000005', '0.0000000002'],
])('十位小数以银行家舍入处理 %s', (amount, expected) => {
  expect(recalculateCurrencyTransaction({ ...transaction, amount }, 'EUR', { USD: '0.5' }).nativeAmount).toBe(expected);
});
it('AA按比例换算并把舍入余数给付款成员，分摊总额严格等于新本币总额', () => {
  expect(
    recalculateCurrencyTransaction(
      {
        ...transaction,
        amount: '1',
        nativeAmount: '3',
        aaMode: 2,
        payerMemberId: payer,
        splits: [
          { memberId: first, amount: '1' },
          { memberId: payer, amount: '2' },
        ],
      },
      'USD',
      {},
    ),
  ).toEqual({
    nativeAmount: '1',
    splits: [
      { memberId: first, amount: '0.3333333333' },
      { memberId: payer, amount: '0.6666666667' },
    ],
  });
});
it.each([{}, { USD: '0' }, { USD: '-1' }, { USD: 'NaN' }])('缺失或无效汇率不能悄悄退回1:1 %j', (rates) => {
  expect(() => recalculateCurrencyTransaction(transaction, 'EUR', rates as Record<string, string>)).toThrow();
});
it('溢出或换算小于最小正金额时拒绝操作', () => {
  expect(() =>
    recalculateCurrencyTransaction({ ...transaction, amount: '9999999999999999999999999999' }, 'EUR', { USD: '2' }),
  ).toThrow();
  expect(() =>
    recalculateCurrencyTransaction({ ...transaction, amount: '0.0000000001' }, 'EUR', { USD: '0.1' }),
  ).toThrow();
});
it('无效现有AA总额拒绝换算，避免改写损坏记录', () => {
  expect(() =>
    recalculateCurrencyTransaction(
      { ...transaction, aaMode: 2, splits: [{ memberId: first, amount: '1' }] },
      'USD',
      {},
    ),
  ).toThrow();
});
