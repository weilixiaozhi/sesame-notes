import { describe, expect, it } from 'vitest';
import { contactsChanged } from './contact-input';
import { loginSchema } from './validation';

describe('后台联系方式和登录输入', () => {
  it('增删或更换联系方式会改变登录凭据，显示名称不参与比较', () => {
    expect(contactsChanged({ email: null, phone: null }, { email: 'operator@example.com', phone: '' })).toBe(true);
    expect(
      contactsChanged(
        { email: 'operator@example.com', phone: '+8613812345678' },
        { email: '', phone: '+8613812345678' },
      ),
    ).toBe(true);
    expect(contactsChanged({ email: null, phone: '+8613812345678' }, { email: '', phone: '13912345678' })).toBe(true);
  });

  it('登录标识必填且限制通用输入长度，密码原样提交', () => {
    expect(loginSchema.safeParse({ username: ' ', password: 'a' }).success).toBe(false);
    expect(loginSchema.safeParse({ username: 'a'.repeat(255), password: 'a' }).success).toBe(false);
    expect(loginSchema.parse({ username: 'a'.repeat(254), password: ' a ' }).password).toBe(' a ');
  });
});
