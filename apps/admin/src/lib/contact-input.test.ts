import { describe, expect, it } from 'vitest';
import { contactsChanged, normalizeEmail, normalizePhone, optionalEmail, optionalPhone } from './contact-input';
import { loginSchema } from './validation';

describe('后台联系方式和登录输入', () => {
  it('空白字段可清除，邮箱大小写统一后比较', () => {
    expect(normalizeEmail('  ')).toBeNull();
    expect(normalizePhone('  ')).toBeNull();
    expect(normalizeEmail(' Operator@Example.COM ')).toBe('operator@example.com');
    expect(optionalEmail.safeParse('').success).toBe(true);
    expect(optionalPhone.safeParse('').success).toBe(true);
    expect(contactsChanged({ email: null, phone: null }, { email: ' ', phone: ' ' })).toBe(false);
    expect(
      contactsChanged({ email: 'operator@example.com', phone: null }, { email: ' OPERATOR@example.COM ', phone: '' }),
    ).toBe(false);
  });

  it.each(['13812345678', '+86 138-1234-5678', '0086(138)12345678'])(
    '国内号码的等价写法不引发凭据变更：%s',
    (value) => {
      expect(normalizePhone(value)).toBe('+8613812345678');
      expect(optionalPhone.safeParse(value).success).toBe(true);
      expect(contactsChanged({ email: null, phone: '+8613812345678' }, { email: '', phone: value })).toBe(false);
    },
  );

  it('国际手机号保留显式区号，无法识别的号码或邮箱给出校验错误', () => {
    expect(normalizePhone('001(415)555-0123')).toBe('+14155550123');
    expect(optionalPhone.safeParse('+14155550123').success).toBe(true);
    for (const value of ['12345', '44155550123', '+0123456', '+12345', '+1234567890123456', '+86abc', '()-']) {
      expect(optionalPhone.safeParse(value).success).toBe(false);
    }
    for (const value of [
      'abc',
      'user@@example.com',
      'user @example.com',
      'user@example',
      'K@example.com',
      `${'a'.repeat(244)}@example.com`,
    ]) {
      expect(optionalEmail.safeParse(value).success).toBe(false);
    }
  });

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

  it('解绑草稿提交为空值，恢复原联系方式可取消凭据变更', () => {
    const previous = { email: 'operator@example.com', phone: '+8613812345678' };
    const draft = { email: '', phone: '' };
    expect(contactsChanged(previous, draft)).toBe(true);
    expect({ email: normalizeEmail(draft.email), phone: normalizePhone(draft.phone) }).toEqual({
      email: null,
      phone: null,
    });
    expect(previous).toEqual({ email: 'operator@example.com', phone: '+8613812345678' });
    expect(contactsChanged(previous, { email: ' OPERATOR@example.COM ', phone: '13812345678' })).toBe(false);
  });

  it.each(['operator', 'Operator@example.com', '13812345678', '+1 (415) 555-0123', '0014155550123'])(
    '登录允许三类标识而不套用登录账号创建规则：%s',
    (value) => {
      expect(loginSchema.parse({ username: ` ${value} `, password: ' ' })).toEqual({ username: value, password: ' ' });
    },
  );

  it('登录标识必填且限制通用输入长度，密码原样提交', () => {
    expect(loginSchema.safeParse({ username: ' ', password: 'a' }).success).toBe(false);
    expect(loginSchema.safeParse({ username: 'a'.repeat(255), password: 'a' }).success).toBe(false);
    expect(loginSchema.parse({ username: 'a'.repeat(254), password: ' a ' }).password).toBe(' a ');
  });
});
