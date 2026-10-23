import type { Prisma, PrismaClient } from '@prisma/client';
import { currentAuthGeneration } from '../../shared/server-generations.js';
import type { AccessClaims } from './security.js';

/** 用当前数据库状态验证会话，HTTP 与实时连接共用同一个撤销边界。 */
export async function currentSessionAccess(
  prisma: PrismaClient | Prisma.TransactionClient,
  claims: AccessClaims,
): Promise<boolean> {
  try {
    const [generation, device] = await Promise.all([
      currentAuthGeneration(prisma),
      prisma.device.findFirst({
        where: {
          id: claims.deviceId,
          userId: claims.userId,
          revokedAt: null,
          // 当前凭据版本必须与令牌一致，换绑或重置密码立即使旧凭据失效。
          user: { isEnabled: true, credentialVersion: claims.credentialVersion },
        },
        select: { id: true },
      }),
    ]);
    return generation === claims.authGeneration && Boolean(device);
  } catch (error) {
    throw new Error('会话安全状态检查失败', { cause: error });
  }
}
