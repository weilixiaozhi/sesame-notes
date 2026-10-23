import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../shared/errors.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { createChange, removeAccountChanges } from '../sync-events/index.js';
import { appendMemberChange } from '../sharing/index.js';

/**
 * 在同步提交锁内清理账号；仍承担活跃共享账本所有权时拒绝删除。
 * 他人账本中的成员主键与历史引用保持不变，只解除账号关联并撤销成员资格。
 */
export async function deleteAccount(
  prisma: PrismaClient,
  userId: string,
): Promise<{ deleted: boolean; detachedMembers: number }> {
  try {
    return await withSyncTransaction(prisma, async (tx) => {
      // 账号行锁与登录/设备的外键写入互斥，整个删除过程只向外暴露最终提交状态。
      const users = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      if (!users.length) return { deleted: false, detachedMembers: 0 };
      const blocking = await tx.ledger.findFirst({
        where: {
          ownerId: userId,
          deletedAt: null,
          members: { some: { linkedAccountId: { not: userId }, status: 'ACTIVE' } },
        },
        select: { id: true },
      });
      if (blocking) throw new ApiError(409, 'ACCOUNT_OWNS_SHARED_LEDGER', '请先处理仍有协作者的共享账本，再注销账号');
      const ledgers = await tx.ledger.findMany({
        where: { ownerId: userId },
        select: {
          id: true,
          deletedAt: true,
          members: { where: { linkedAccountId: { not: userId } }, select: { linkedAccountId: true } },
        },
      });
      const ledgerIds = ledgers.map((ledger) => ledger.id);
      const device = await tx.device.findFirst({ where: { userId }, select: { id: true } });
      const actor = { userId, deviceId: device?.id ?? randomUUID() };
      // 私有事件的非空账号约束及账本事件的scope约束要求先清理事件，再删除外键目标。
      await removeAccountChanges(tx, userId, ledgerIds);
      await tx.ledger.deleteMany({ where: { ownerId: userId } });
      // 已软删除共享本仍需给离线协作者留下独立墓碑，不能依赖被清理的账本外键。
      for (const ledger of ledgers) {
        for (const member of ledger.members) {
          if (!member.linkedAccountId) continue;
          const deletedAt = ledger.deletedAt ?? new Date();
          await createChange(
            tx,
            actor,
            null,
            'ledger',
            ledger.id,
            'delete',
            // 账号删除会解除事件外键，归属必须作为墓碑的持久事实保留在载荷中。
            { owner_id: userId, deleted_at: deletedAt.toISOString() },
            deletedAt,
            member.linkedAccountId,
          );
        }
      }
      const members = await tx.ledgerMember.findMany({ where: { linkedAccountId: userId }, orderBy: { id: 'asc' } });
      for (const member of members) {
        const detached = await tx.ledgerMember.update({
          where: { id: member.id },
          data: {
            memberType: 'PLACEHOLDER',
            linkedAccountId: null,
            status: 'REMOVED',
            archivedAt: null,
            archiveUpdatedAt: null,
            archiveUpdatedByDeviceId: null,
            updatedAt: new Date(),
            updatedByDeviceId: null,
          },
        });
        // 共享历史的其他成员通过正常pull得知身份解绑，不依赖已删除账号继续上线。
        await appendMemberChange(tx, actor, detached);
      }
      await tx.user.delete({ where: { id: userId } });
      return { deleted: true, detachedMembers: members.length };
    });
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('账号删除事务失败，所有改动已回滚', { cause });
  }
}
