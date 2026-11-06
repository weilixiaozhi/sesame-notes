import { describe, expect, it } from 'vitest';
import { maskPhoneE164, normalizeE164Phone, PhoneInvalidError } from './phone.js';

describe('手机号账号输入', () => {
  it.each([
    ['+86', '138 0013-8000', '+8613800138000'],
    ['+1', '12345678901234', '+112345678901234'],
  ])('区号 %s 与本地号码 %s 生成稳定账号标识', (code, phone, expected) => {
    expect(normalizeE164Phone(code, phone)).toBe(expected);
  });

  it.each([
    ['+86', '1a'],
    ['+86', '12345678901234'],
    ['+0', '1111'],
  ])('无效区号或号码不会成为账号：%s / %s', (code, phone) => {
    expect(() => normalizeE164Phone(code, phone)).toThrow(PhoneInvalidError);
  });

  it.each([
    ['+11', '+1 *'],
    ['+8613800138000', '+86 138****8000'],
  ])('管理员展示隐藏短号码及普通手机号：%s', (phone, masked) => {
    expect(maskPhoneE164(phone)).toBe(masked);
  });
});
