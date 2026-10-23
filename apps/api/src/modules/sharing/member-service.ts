import { type SyncTransaction, withSyncTransaction } from '../../shared/sync-transaction.js';

import type { LedgerMember, Prisma, PrismaClient } from '@prisma/client';

import { ApiError } from '../../shared/errors.js';
import { createChange } from '../sync-events/index.js';
import { getLedgerWriteAccess } from '../accounting/index.js';
import { currentSessionAccess, type AccessClaims } from '../auth/index.js';

type ChangeActor = { userId: string; deviceId: string };

/** 成员主动退出账本，并在同一事务写入其设备仍可读取的最终状态事件。 */
export async function leaveLedgerMember(prisma: PrismaClient, ledgerId: string, auth: AccessClaims): Promise<void> {
  try {
    await withSyncTransaction(prisma, async (tx) => {
      await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'editor');
      // 当前成员资格已由访问入口锁定，使用锁等待结束后的会话状态决定是否允许退出。
      if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
      const member = await tx.ledgerMember.findFirst({
        where: {
          ledgerId,
          linkedAccountId: auth.userId,
          memberType: 'REGISTERED',
          status: 'ACTIVE',
          ledger: { deletedAt: null },
        },
      });
      if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', '成员不存在');
      if (member.role === 'owner') throw new ApiError(409, 'OWNER_CANNOT_LEAVE', 'Owner 删除账本前不能退出');
      const now = new Date();
      const transitioned = await tx.ledgerMember.updateMany({
        where: { id: member.id, status: 'ACTIVE' },
        data: { status: 'LEFT', updatedAt: now, updatedByDeviceId: auth.deviceId },
      });
      if (!transitioned.count) throw new ApiError(404, 'MEMBER_NOT_FOUND', '成员不存在');
      const left = await tx.ledgerMember.findUniqueOrThrow({ where: { id: member.id } });
      await appendMemberChange(tx, auth, left);
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('成员退出失败', { cause: error });
  }
}

/** 移除成员（REMOVED 生命周期）的单一实现：Owner 不可移除； 同事务作废该账本全部未消费邀请（邀请作废规则）。 */
export async function removeLedgerMember(
  prisma: PrismaClient,
  ledgerId: string,
  memberId: string,
  auth: AccessClaims,
): Promise<void> {
  try {
    await withSyncTransaction(prisma, async (tx) => {
      // 授权与状态写必须共享同一事务，避免权限检查后 actor 被撤权仍继续移除成员。
      await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
      // 所有者授权锁住账本，目标成员的生命周期在同一锁顺序下读取和更新。
      await tx.$queryRaw`
        SELECT "id" FROM "ledger_members"
        WHERE "id" = ${memberId}::uuid AND "ledger_id" = ${ledgerId}::uuid
        FOR UPDATE
      `;
      if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
      const member = await tx.ledgerMember.findUnique({ where: { id: memberId } });
      // 已 REMOVED 的成员重复移除视为无生效变更（404）
      if (!member || member.ledgerId !== ledgerId || member.status === 'REMOVED')
        throw new ApiError(404, 'MEMBER_NOT_FOUND', '成员不存在');
      if (member.role === 'owner') throw new ApiError(409, 'OWNER_CANNOT_BE_REMOVED', 'Owner 不能移除自己');
      const now = new Date();
      const transitioned = await tx.ledgerMember.updateMany({
        where: { id: memberId, ledgerId, status: { in: ['ACTIVE', 'LEFT'] } },
        data: { status: 'REMOVED', updatedAt: now, updatedByDeviceId: auth.deviceId },
      });
      if (!transitioned.count) throw new ApiError(404, 'MEMBER_NOT_FOUND', '成员不存在');
      const removed = await tx.ledgerMember.findUniqueOrThrow({ where: { id: memberId } });
      await tx.ledgerInvite.updateMany({
        where: { ledgerId, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      await appendMemberChange(tx, auth, removed);
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('成员移除失败', { cause: error });
  }
}

/** 追加权威成员快照；绑定账号作为定向接收者，保证撤权后仍能拉到最终状态。 */
export async function appendMemberChange(tx: SyncTransaction, auth: ChangeActor, member: LedgerMember): Promise<void> {
  try {
    await createChange(
      tx,
      auth,
      member.ledgerId,
      'member',
      member.id,
      'upsert',
      memberPayload(member),
      member.updatedAt,
      member.linkedAccountId,
    );
  } catch (error) {
    throw new Error('成员同步事件写入失败', { cause: error });
  }
}

/** 构造成员同步快照，生命周期状态与版本时间来自同一数据库行。 */
function memberPayload(member: LedgerMember): Prisma.InputJsonValue {
  return {
    id: member.id,
    ledger_id: member.ledgerId,
    display_name: member.displayName,
    member_type: member.memberType,
    linked_account_id: member.linkedAccountId,
    role: member.role,
    status: member.status,
    updated_at: member.updatedAt.toISOString(),
  };
}
