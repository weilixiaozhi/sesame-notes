import type { Prisma } from '@prisma/client';

/** 正文、分类字典与缓存版本在同一事务更新，失败时共同回滚。 */
export async function advanceOfficialContentVersion(tx: Prisma.TransactionClient): Promise<void> {
  try {
    // 单例由数据库迁移建立；正文提交只能推进现有版本，不能重置已经发布的版本序列。
    await tx.officialFitnessState.update({
      where: { id: 1 },
      data: { contentVersion: { increment: 1 } },
    });
  } catch (cause) {
    throw new Error('官方健身目录版本更新失败', { cause });
  }
}
