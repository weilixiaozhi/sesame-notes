import { z } from 'zod';

/** 邮箱按登录匹配规则统一大小写，未填写时返回数据库空值。 */
export function normalizeEmail(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

/** 手机号统一为国际格式，国内完整手机号可省略 +86，其他号码需要明确区号。 */
export function normalizePhone(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  const compact = input.replace(/[\s()-]/g, '');
  if (/^1[3-9]\d{9}$/.test(compact)) return `+86${compact}`;
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
}

export const optionalEmail = z.string().refine((value) => {
  const normalized = normalizeEmail(value);
  return (
    normalized === null ||
    (/^[\x21-\x7E]+$/.test(value.trim()) && normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
  );
}, '请输入有效的邮箱地址。');

export const optionalPhone = z.string().refine((value) => {
  const normalized = normalizePhone(value);
  return normalized === null || /^\+[1-9]\d{5,14}$/.test(normalized);
}, '请输入国内 11 位手机号，或包含国际区号的手机号。');

/** 仅比较实际登录标识，空白、大小写或号码排版不应触发凭据变更。 */
export function contactsChanged(
  previous: { email: string | null; phone: string | null },
  next: { email: string; phone: string },
): boolean {
  return (
    normalizeEmail(previous.email) !== normalizeEmail(next.email) ||
    normalizePhone(previous.phone) !== normalizePhone(next.phone)
  );
}
