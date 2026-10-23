import { expect, it } from 'vitest';
import { aaStatistics } from '../src/modules/accounting/testing.js';
const members = [
  { id: 'a', displayName: 'A', linkedAccountId: 'self' },
  { id: 'b', displayName: 'B', linkedAccountId: null },
  { id: 'c', displayName: 'C', linkedAccountId: null },
];
it('均摊不足一分余数给付款人，所有金额不经过浮点数', () => {
  const result = aaStatistics(
    members,
    [{ nativeAmount: '10.005', aaMode: null, payerMemberId: 'a', splits: [] }],
    'self',
  );
  expect(result.participants.map((row) => [row.total_paid, row.total_should_pay, row.net])).toEqual([
    ['10.005', '3.345', '6.66'],
    ['0', '3.33', '-3.33'],
    ['0', '3.33', '-3.33'],
  ]);
  expect(result.transfers.map((row) => row.amount)).toEqual(['3.33', '3.33']);
});
it('自定义、不分摊、未知付款人与损坏分摊分别统计，不冒充当前用户', () => {
  const result = aaStatistics(
    members,
    [
      {
        nativeAmount: '3',
        aaMode: 2,
        payerMemberId: 'unknown',
        splits: [
          { memberId: 'a', amount: '1' },
          { memberId: 'b', amount: '2' },
        ],
      },
      { nativeAmount: '7', aaMode: 1, payerMemberId: 'b', splits: [] },
      { nativeAmount: '4', aaMode: 2, payerMemberId: 'a', splits: [{ memberId: 'a', amount: '3' }] },
      { nativeAmount: '4', aaMode: 0, payerMemberId: null, splits: [] },
    ],
    'self',
  );
  expect(result).toMatchObject({ transaction_count: 1, excluded_count: 1, skipped_count: 2 });
  expect(result.participants.find((row) => row.member_id === 'unknown')).toMatchObject({
    display_name: '未知',
    is_self: false,
    total_paid: '3',
  });
  expect(result.participants[1]!.non_split_paid).toBe('7');
});
it('转账金额银行家舍入且仍保留精确结算量', () => {
  const result = aaStatistics(
    members,
    [
      {
        nativeAmount: '2.025',
        aaMode: 2,
        payerMemberId: 'a',
        splits: [
          { memberId: 'b', amount: '1.005' },
          { memberId: 'c', amount: '1.02' },
        ],
      },
    ],
    'self',
  );
  expect(result.transfers.map((row) => [row.exact_amount, row.amount])).toEqual([
    ['1.02', '1.02'],
    ['1.005', '1'],
  ]);
});
it('大金额十位精度以及无成员、缺失付款人不丢失精度', () => {
  const result = aaStatistics(
    members,
    [{ nativeAmount: '9999999999999999999999999999.9999999999', aaMode: 0, payerMemberId: 'a', splits: [] }],
    'self',
  );
  expect(result.participants[0]!.total_paid).toBe('9999999999999999999999999999.9999999999');
  expect(
    aaStatistics([], [{ nativeAmount: '1', aaMode: 0, payerMemberId: 'a', splits: [] }], 'self').skipped_count,
  ).toBe(1);
});
