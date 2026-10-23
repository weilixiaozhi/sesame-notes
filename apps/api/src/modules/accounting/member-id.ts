import { uuidV5 } from '../../shared/uuid.js';

/** 派生注册成员 ID；账号统一小写，避免同一账号因大小写不同产生多个身份。 */
export function registeredMemberId(ledgerId: string, userId: string): string {
  return uuidV5(ledgerId, `user:${userId.toLowerCase()}`);
}
