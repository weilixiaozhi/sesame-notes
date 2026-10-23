import type { Prisma } from '@prisma/client';

/** 构造同步事件可见范围；分类属于 Owner，但共享成员仍需要收到其展示数据更新。 */
export function visibleSyncChangeWhere(userId: string): Prisma.SyncChangeWhereInput {
  return {
    OR: [
      { recipientUserId: userId },
      { userId, ledgerId: null },
      { ledger: { OR: [{ ownerId: userId }, { members: { some: { linkedAccountId: userId, status: 'ACTIVE' } } }] } },
      { ledgerId: null, entityType: 'category', user: sharedCategoryOwnerWhere(userId) },
    ],
  };
}

/** 有效共享账本中的注册成员可读取分类，已删除账本不授予跨账号读取权限。 */
function sharedCategoryOwnerWhere(userId: string): Prisma.UserWhereInput {
  return {
    ownedLedgers: {
      some: {
        deletedAt: null,
        members: { some: { linkedAccountId: userId, memberType: 'REGISTERED', status: 'ACTIVE' } },
      },
    },
  };
}
