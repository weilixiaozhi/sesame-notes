import type { Ledger, Prisma, PrismaClient } from '@prisma/client';

import { ApiError } from '../../../shared/errors.js';
import type { LedgerRole } from '../mappers.js';

/**
 * 可访问账本的统一过滤条件：Owner，或 ACTIVE 且 REGISTERED 的本人成员行。
 * 目录查询与资源授权共用同一表达式，避免两处条件各自漂移。
 */
export function accessibleLedgerWhere(userId: string): Prisma.LedgerWhereInput {
  return {
    deletedAt: null,
    OR: [
      { ownerId: userId },
      { members: { some: { linkedAccountId: userId, status: 'ACTIVE', memberType: 'REGISTERED' } } },
    ],
  };
}

/** 由账本归属与本人成员行推导角色；两者都不匹配时视为不可访问。 */
export function ledgerRoleOf(
  ledger: { ownerId: string },
  userId: string,
  member: { role: LedgerRole } | undefined,
): LedgerRole {
  if (ledger.ownerId === userId) return 'owner';
  if (!member) throw new ApiError(404, 'LEDGER_NOT_FOUND', '账本不存在');
  return member.role;
}

/** 在当前查询快照内验证账本资格；普通查询和只读事务均不获取业务行锁。 */
export async function getLedgerReadAccess(
  prisma: PrismaClient | Prisma.TransactionClient,
  userId: string,
  ledgerId: string,
  minimumRole: LedgerRole,
): Promise<{ ledger: Ledger; role: LedgerRole }> {
  try {
    // 权限查询必须 memberType==REGISTERED AND linkedAccountId==auth AND status==ACTIVE
    // （PLACEHOLDER 无账号且无权限，防御性过滤避免误入授权路径）
    const row = await prisma.ledger.findFirst({
      where: { id: ledgerId, ...accessibleLedgerWhere(userId) },
      include: { members: { where: { linkedAccountId: userId, status: 'ACTIVE', memberType: 'REGISTERED' }, take: 1 } },
    });
    if (!row) throw new ApiError(404, 'LEDGER_NOT_FOUND', '账本不存在');
    // 成员仅用于本次授权；返回稳定的 Ledger 字段，避免关联查询形态改变预览指纹或领域快照。
    const { members, ...ledger } = row;
    const role = ledger.ownerId === userId ? 'owner' : (members[0]?.role as LedgerRole | undefined);
    if (!role) throw new ApiError(404, 'LEDGER_NOT_FOUND', '账本不存在');
    const ranks: Record<LedgerRole, number> = { editor: 0, owner: 1 };
    if (ranks[role] < ranks[minimumRole]) throw new ApiError(403, 'LEDGER_PERMISSION_DENIED', '你没有执行此操作的权限');
    return { ledger, role };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('账本权限检查失败', { cause: error });
  }
}

/** 在写事务内按账本、成员顺序获取行锁，并使用等锁后的成员状态验证写权限。 */
export async function getLedgerWriteAccess(
  tx: Prisma.TransactionClient,
  userId: string,
  ledgerId: string,
  minimumRole: LedgerRole,
): Promise<{ ledger: Ledger; role: LedgerRole }> {
  try {
    // 账本写入与撤权持有相同的行锁顺序，成员失效后不能按锁前权限完成写入。
    const [lockedLedger] = await tx.$queryRaw<Array<Pick<Ledger, 'id' | 'ownerId'>>>`
    SELECT "id", "owner_id" AS "ownerId"
    FROM "ledgers"
    WHERE "id" = ${ledgerId}::uuid AND "deleted_at" IS NULL
    FOR UPDATE
  `;
    if (!lockedLedger) throw new ApiError(404, 'LEDGER_NOT_FOUND', '账本不存在');

    let role: LedgerRole;
    if (lockedLedger.ownerId === userId) {
      role = 'owner';
    } else {
      const [member] = await tx.$queryRaw<Array<{ role: LedgerRole }>>`
      SELECT "role"
      FROM "ledger_members"
      WHERE "ledger_id" = ${ledgerId}::uuid
        AND "linked_account_id" = ${userId}::uuid
        AND "member_type" = 'REGISTERED'
        AND "status" = 'ACTIVE'
      FOR UPDATE
    `;
      if (!member) throw new ApiError(404, 'LEDGER_NOT_FOUND', '账本不存在');
      role = member.role;
    }
    const ranks: Record<LedgerRole, number> = { editor: 0, owner: 1 };
    if (ranks[role] < ranks[minimumRole]) throw new ApiError(403, 'LEDGER_PERMISSION_DENIED', '你没有执行此操作的权限');

    const ledger = await tx.ledger.findUnique({ where: { id: ledgerId } });
    if (!ledger || ledger.deletedAt) throw new ApiError(404, 'LEDGER_NOT_FOUND', '账本不存在');
    return { ledger, role };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('账本写权限锁定失败', { cause: error });
  }
}
