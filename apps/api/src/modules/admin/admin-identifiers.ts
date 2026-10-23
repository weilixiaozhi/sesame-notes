import type { Prisma } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { normalizeAdminUsername } from './admin-security.js';

/** 后台邮箱统一裁剪并转小写；保留加号标签和点号，不合并不同邮箱地址。 */
export function normalizeAdminEmail(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  const email = input.toLowerCase();
  const parts = email.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  const labels = domain.split('.');
  if (
    email.length > 254 ||
    [...input].some((character) => character.charCodeAt(0) > 127) ||
    parts.length !== 2 ||
    local.length > 64 ||
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !/[a-z]/.test(labels.at(-1) ?? '')
  ) {
    throw new ApiError(400, 'ADMIN_EMAIL_INVALID', '请输入有效的邮箱地址');
  }
  return email;
}

/** 手机号以国际区号存储；未填写区号时仅识别中国大陆的 11 位手机号。 */
export function normalizeAdminPhone(value: string | null | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;
  let phone = input.replace(/[\s()-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (/^1[3-9]\d{9}$/.test(phone)) phone = `+86${phone}`;
  if (!/^\+[1-9]\d{5,14}$/.test(phone)) {
    throw new ApiError(400, 'ADMIN_PHONE_INVALID', '请输入中国大陆手机号，或带国际区号的手机号');
  }
  return phone;
}

/** 登录账号、邮箱和手机号拥有互不重叠的形态，只查询独立后台账号表。 */
export function normalizeAdminLoginIdentifier(value: string): Prisma.AdminAccountWhereUniqueInput | null {
  try {
    const input = value.trim();
    if (input.includes('@')) {
      const email = normalizeAdminEmail(input);
      return email ? { email } : null;
    }
    if (/^[+\d\s()-]+$/.test(input)) {
      const phone = normalizeAdminPhone(input);
      return phone ? { phone } : null;
    }
    return { username: normalizeAdminUsername(input) };
  } catch (error) {
    // 登录统一返回认证失败，不能通过格式错误暴露已登记的联系方式。
    if (error instanceof ApiError) return null;
    throw error;
  }
}

/** 安全事务内检查唯一登录联系方式，已删除账号仍保留其标识。 */
export async function assertAdminContactsAvailable(
  tx: Prisma.TransactionClient,
  contacts: { email: string | null; phone: string | null },
  currentId?: string,
): Promise<void> {
  for (const key of ['email', 'phone'] as const) {
    const value = contacts[key];
    if (!value) continue;
    const account = await tx.adminAccount.findUnique({
      where: key === 'email' ? { email: value } : { phone: value },
      select: { id: true },
    });
    if (account && account.id !== currentId) {
      throw new ApiError(
        409,
        key === 'email' ? 'ADMIN_EMAIL_EXISTS' : 'ADMIN_PHONE_EXISTS',
        key === 'email' ? '此邮箱已被其他后台用户使用，请更换' : '此手机号已被其他后台用户使用，请更换',
      );
    }
  }
}
