import { describe, expect, it } from 'vitest';
import { transactionData, validateTransactionSource } from './transactions.js';

const ledgerId = '11111111-1111-4111-8111-111111111111';
const ruleId = '22222222-2222-4222-8222-222222222222';
const auth = { userId: '33333333-3333-4333-8333-333333333333', deviceId: ledgerId };
const ordinary = {
  tx_type: 'expense',
  amount: '10',
  native_amount: '10',
  currency_code: 'CNY',
  happened_at: '2026-01-10T00:00:00.000Z',
};

describe('交易周期来源边界', () => {
  it.each([
    { recurring_id: ruleId },
    { recurring_id: ruleId, occurrence_date: null },
    { recurring_id: ruleId, occurrence_date: '2026-01-10' },
    { occurrence_date: '2026-01-10' },
  ])('普通创建和通用导入拒绝周期来源：%j', (source) => {
    expect(() =>
      transactionData(ledgerId, auth.userId, auth, { ...ordinary, ...source }, null, new Date(), ledgerId),
    ).toThrow('周期发生请通过到期生成或完整周期历史迁入');
  });

  it('普通交易可创建，显式空来源不产生周期引用', () => {
    const saved = transactionData(
      ledgerId,
      auth.userId,
      auth,
      {
        ...ordinary,
        recurring_id: null,
        occurrence_date: null,
      },
      null,
      new Date(),
      ledgerId,
    );
    expect(saved.recurringId).toBeNull();
    expect(saved.amount).toBe('10');
  });

  it('存量无发生日来源允许编辑，已确认发生的来源不可重写', () => {
    expect(() => validateTransactionSource({ recurringId: ruleId, occurrenceDate: null }, {})).not.toThrow();
    expect(() =>
      validateTransactionSource(
        { recurringId: ruleId, occurrenceDate: null },
        {
          recurring_id: ruleId,
          occurrence_date: null,
        },
      ),
    ).not.toThrow();
    expect(() =>
      validateTransactionSource(
        { recurringId: ruleId, occurrenceDate: '2026-01-10' },
        {
          recurring_id: null,
        },
      ),
    ).toThrow('交易的周期来源和发生日期不能修改');
  });

  it.each([
    { current: { recurringId: null, occurrenceDate: null }, patch: { recurring_id: ruleId } },
    { current: { recurringId: ruleId, occurrenceDate: null }, patch: { recurring_id: null } },
  ])('更新不能引入或改挂无发生日来源：%j', ({ current, patch }) => {
    expect(() => validateTransactionSource(current, patch)).toThrow('交易的周期来源和发生日期不能修改');
  });
});
