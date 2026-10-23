import type { Prisma, PrismaClient } from '@prisma/client';

// 事务客户端与常规客户端都提供 serverEpoch 委托：注册事务内也需要读取当前 generation
type GenerationSource = PrismaClient | Prisma.TransactionClient;

type ServerGenerations = {
  authGeneration: string;
  idempotencyGeneration: string;
};

/** 读取当前 generation；单例行缺失时幂等创建。 */
async function getServerGenerations(prisma: GenerationSource): Promise<ServerGenerations> {
  try {
    const row = await prisma.serverEpoch.upsert({
      where: { id: 0 },
      create: { id: 0 },
      update: {},
    });
    return {
      authGeneration: row.authGeneration,
      idempotencyGeneration: row.idempotencyGeneration,
    };
  } catch (error) {
    throw new Error('服务端 generation 读取失败', { cause: error });
  }
}

export async function currentAuthGeneration(prisma: GenerationSource): Promise<string> {
  return (await getServerGenerations(prisma)).authGeneration;
}

export async function currentIdempotencyGeneration(prisma: GenerationSource): Promise<string> {
  return (await getServerGenerations(prisma)).idempotencyGeneration;
}
