import type { Prisma } from '@prisma/client';

import { registeredMemberId } from './member-id.js';

/** 在创建账本的同一事务内确保 Owner 拥有 ACTIVE 的 owner 成员行。 授权仍以 Ledger.ownerId 为权威；成员行负责保存账本级展示快照，并让交易、 分摊与编辑历史统一引用 member_id。 */
export async function ensureOwnerMember(
  tx: Prisma.TransactionClient,
  ledgerId: string,
  ownerId: string,
  timestamps: { createdAt: Date; updatedAt: Date; updatedByDeviceId: string | null },
): Promise<void> {
  try {
    const user = await tx.user.findUnique({
      where: { id: ownerId },
      select: { profile: { select: { displayName: true } } },
    });
    await tx.ledgerMember.upsert({
      where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: ownerId } },
      create: {
        id: registeredMemberId(ledgerId, ownerId),
        ledgerId,
        // 成员快照按 Unicode 码点限制长度，表情等代理对必须完整保留。
        displayName: Array.from(user?.profile?.displayName ?? 'Owner')
          .slice(0, 64)
          .join(''),
        memberType: 'REGISTERED',
        linkedAccountId: ownerId,
        role: 'owner',
        status: 'ACTIVE',
        createdAt: timestamps.createdAt,
        updatedAt: timestamps.updatedAt,
        updatedByDeviceId: timestamps.updatedByDeviceId,
      },
      update: {
        role: 'owner',
        updatedAt: timestamps.updatedAt,
        updatedByDeviceId: timestamps.updatedByDeviceId,
      },
    });
  } catch (error) {
    throw new Error('Owner 成员行创建失败', { cause: error });
  }
}
