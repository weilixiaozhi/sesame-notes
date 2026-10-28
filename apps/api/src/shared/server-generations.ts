import type { Prisma, PrismaClient } from '@prisma/client';

// 事务客户端与常规客户端都提供 serverEpoch 委托：注册事务内也需要读取当前 generation
type GenerationSource = PrismaClient | Prisma.TransactionClient;

type ServerGenerations = {
  authGeneration: string;
  idempotencyGeneration: string;
};

/** 只读迁移建立的权威代际；缺失必须暴露，随机代际仅由显式维护流程轮换。 */
async function getServerGenerations(prisma: GenerationSource): Promise<ServerGenerations> {
  try {
    return await prisma.serverEpoch.findUniqueOrThrow({
      where: { id: 0 },
      select: { authGeneration: true, idempotencyGeneration: true },
    });
  } catch (error) {
    throw new Error('服务端 generation 读取失败', { cause: error });
  }
}

/** 读取认证代际，供访问令牌、刷新令牌与实时连接核对同一权威身份。 */
export async function currentAuthGeneration(prisma: GenerationSource): Promise<string> {
  return (await getServerGenerations(prisma)).authGeneration;
}

/** 读取幂等代际，读取失败时不能作废既有成功回执或生成新的回执。 */
export async function currentIdempotencyGeneration(prisma: GenerationSource): Promise<string> {
  return (await getServerGenerations(prisma)).idempotencyGeneration;
}
