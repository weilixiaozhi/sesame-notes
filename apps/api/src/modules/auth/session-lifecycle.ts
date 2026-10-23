import type { Prisma } from '@prisma/client';

/** 先锁定账号行再读写会话，使签发、轮换、明确撤销与账号删除按同一顺序串行提交。 */
export async function lockAccountSessions(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  try {
    // 会话操作彼此互斥，但允许其他业务持有账号外键的 KEY SHARE 锁，避免与代际读取形成反向等待。
    await tx.$queryRaw`
      SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE
    `;
  } catch (cause) {
    throw new Error('账号会话锁定失败', { cause });
  }
}

/** 在账号锁内明确终止指定范围的刷新令牌；包含轮换旧令牌，截止有效期使新登录不能重新激活宽限。 */
export async function terminateRefreshTokens(
  tx: Prisma.TransactionClient,
  userId: string,
  scope: Pick<Prisma.RefreshTokenWhereInput, 'deviceId' | 'tokenHash'> = {},
): Promise<void> {
  try {
    const now = new Date();
    await tx.refreshToken.updateMany({
      where: { ...scope, userId },
      data: { revokedAt: now, expiresAt: now },
    });
  } catch (cause) {
    throw new Error('刷新令牌终止失败', { cause });
  }
}
