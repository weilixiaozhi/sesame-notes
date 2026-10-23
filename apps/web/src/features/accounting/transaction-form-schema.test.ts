import { describe, expect, it } from 'vitest';
import { entryNoteCharacters, transactionFormSchema } from './transaction-form-schema';

const draft = {
  amount: '12.34',
  nativeAmount: '12.34',
  currency: 'CNY',
  happenedAt: '2026-10-19T12:00',
  categoryId: 'category',
  note: '',
  payerId: '',
  aaMode: '0',
  splits: [],
};

describe('手工记账输入规则', () => {
  it('金额最多两位小数，超精度草稿不进入保存', () => {
    expect(transactionFormSchema.safeParse(draft).success).toBe(true);
    expect(transactionFormSchema.safeParse({ ...draft, amount: '12.345' }).success).toBe(false);
  });

  it('备注最多二十个可见字符，单行粘贴也不能绕过校验', () => {
    expect(transactionFormSchema.safeParse({ ...draft, note: '记'.repeat(20) }).success).toBe(true);
    expect(transactionFormSchema.safeParse({ ...draft, note: '记'.repeat(21) }).success).toBe(false);
    for (const separator of ['\r', '\n', '\u0085', '\u2028', '\u2029']) {
      expect(transactionFormSchema.safeParse({ ...draft, note: `早餐${separator}午餐` }).success).toBe(false);
    }
  });

  it('组合表情与客户端一样按一个可见字符计数', () => {
    const emoji = '👨‍👩‍👧‍👦';
    expect(entryNoteCharacters(emoji.repeat(20))).toHaveLength(20);
    expect(transactionFormSchema.safeParse({ ...draft, note: emoji.repeat(20) }).success).toBe(true);
    expect(transactionFormSchema.safeParse({ ...draft, note: emoji.repeat(21) }).success).toBe(false);
  });
});
