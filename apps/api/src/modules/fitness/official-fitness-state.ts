import type { Prisma } from '@prisma/client';

/** 正文、分类字典与缓存版本在同一事务更新，失败时共同回滚。 */
export async function advanceOfficialContentVersion(tx: Prisma.TransactionClient): Promise<void> {
  try {
    await tx.officialFitnessState.upsert({
      where: { id: 1 },
      create: { id: 1, contentVersion: 2 },
      update: { contentVersion: { increment: 1 } },
    });
  } catch (cause) {
    throw new Error('官方健身目录版本更新失败', { cause });
  }
}
