/** 手机号规范化与脱敏：所有注册、登录入口共用带区号的数字账号标识。 */

// 区号与本地号码各至少一位，总数字最多 15 位，区号首位不能为 0。
const PHONE_IDENTIFIER_PATTERN = /^\+[1-9]\d{1,14}$/;
// 区号输入形态：+86、+852 等，只接受 1-3 位数字
const COUNTRY_CODE_PATTERN = /^\+[1-9]\d{0,2}$/;

/**
 * 把区号与本地号码规范化为稳定的数字账号标识。
 *
 * 规则：去除本地号码中的 ASCII 空格和短横线 → 拼接区号 → 校验总位数。
 * 校验失败抛出 PHONE_INVALID 业务错误；解析异常统一包装，调用方日志只记录
 * 脱敏值或不可逆摘要，绝不记录完整手机号。
 */
export function normalizeE164Phone(countryCode: string, phone: string): string {
  try {
    const code = countryCode.trim();
    const national = phone.replace(/[ -]/g, '');
    if (!COUNTRY_CODE_PATTERN.test(code) || !national) throw new Error('INVALID_PHONE');
    const combined = `${code}${national}`;
    if (!PHONE_IDENTIFIER_PATTERN.test(combined)) throw new Error('INVALID_PHONE');
    return combined;
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_PHONE') {
      throw new PhoneInvalidError();
    }
    throw new Error('手机号规范化失败', { cause: error });
  }
}

/** 手机号格式错误的业务异常，路由层转为 400 PHONE_INVALID。 */
export class PhoneInvalidError extends Error {
  constructor() {
    super('INVALID_PHONE');
    this.name = 'PhoneInvalidError';
  }
}

// 常用区号列表（与 UI 稿区号选择器一致）：脱敏展示需要正确切分区号与本地号码
const SUPPORTED_COUNTRY_CODES = ['+852', '+853', '+886', '+86', '+44', '+61', '+65', '+81', '+82', '+1'];

/**
 * 生成仅本人可见的脱敏展示值，例如 +86 138****8000（含区号、隐藏中间位）。
 * 隐藏规则：至少 8 位保留前 3 后 4 位，5-7 位只留首尾，更短号码全部隐藏。
 * 区号按常用列表最长前缀切分，未知区号退化为整串脱敏。
 */
export function maskPhoneE164(phoneE164: string): string {
  try {
    const digits = phoneE164.replace(/^\+/, '');
    if (!PHONE_IDENTIFIER_PATTERN.test(phoneE164)) return phoneE164;
    const code = SUPPORTED_COUNTRY_CODES.find((candidate) => digits.startsWith(candidate.slice(1)));
    const national = code ? digits.slice(code.length - 1) : digits;
    const masked = maskNational(national);
    return code ? `${code} ${masked}` : `+${masked}`;
  } catch (error) {
    throw new Error('手机号脱敏失败', { cause: error });
  }
}

/** 按号码长度保留有限首尾位，最多四位的短号码全部隐藏。 */
function maskNational(national: string): string {
  if (national.length >= 8) {
    return `${national.slice(0, 3)}${'*'.repeat(national.length - 7)}${national.slice(-4)}`;
  }
  if (national.length > 4) {
    return `${national.slice(0, 1)}${'*'.repeat(national.length - 2)}${national.slice(-1)}`;
  }
  return '*'.repeat(national.length);
}
