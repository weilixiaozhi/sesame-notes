import type { LedgerMember, Prisma } from '@prisma/client';

import { ApiError } from '../../shared/errors.js';
import { registeredMemberId } from './member-id.js';

/**
 * 把 wire 输入的成员引用解析为账本级 memberId，并强制同账本 FK 约束：
 * - REGISTERED 成员允许历史状态（LEFT/REMOVED 仍可解释历史参与人）；
 * - PLACEHOLDER 默认仅 ACTIVE 可被引用；显式历史迁入或保留原引用时仅允许调用方核准的成员集合。
 * 跨账本引用（即使 memberId 合法）一律拒绝。
 */
export async function resolveMemberReference(
  db: Prisma.TransactionClient,
  ledgerId: string,
  input: { member_id?: string | null },
  historicalMemberIds?: ReadonlySet<string>,
): Promise<string | null> {
  if (!input.member_id) return null;
  // 引用事务持有共享行锁直到提交，与成员移除串行，禁止用已移除的占位成员新增交易。
  const [member] = await db.$queryRaw<Array<Pick<LedgerMember, 'id' | 'ledgerId' | 'memberType' | 'status'>>>`
    SELECT "id", "ledger_id" AS "ledgerId", "member_type" AS "memberType", "status"
    FROM "ledger_members"
    WHERE "id" = ${input.member_id}::uuid
    FOR SHARE
  `;
  if (!member || member.ledgerId !== ledgerId) {
    throw new ApiError(400, 'INVALID_AA_PARTICIPANT', 'AA 参与人必须是本账本成员');
  }
  if (member.memberType === 'PLACEHOLDER' && member.status !== 'ACTIVE' && !historicalMemberIds?.has(member.id)) {
    throw new ApiError(400, 'INVALID_AA_PARTICIPANT', 'AA 参与人必须是本账本占位成员');
  }
  return member.id;
}

/** 批量解析分摊参与人（member_id → memberId），顺序与输入一致。 空/无分摊返回 null（非指定分摊）。 */
export async function resolveSplitMembers(
  db: Prisma.TransactionClient,
  ledgerId: string,
  splits: Array<{ member_id?: string | null; amount: string }> | null | undefined,
  historicalMemberIds?: ReadonlySet<string>,
): Promise<Array<{ memberId: string; amount: string }> | null> {
  if (!splits || splits.length === 0) return null;
  const resolved: Array<{ memberId: string; amount: string }> = [];
  for (const split of splits) {
    const memberId = await resolveMemberReference(db, ledgerId, split, historicalMemberIds);
    if (!memberId) {
      throw new ApiError(400, 'INVALID_AA_PARTICIPANT', 'AA 参与人必须是本账本成员或占位成员');
    }
    resolved.push({ memberId, amount: split.amount });
  }
  return resolved;
}

/** 由认证账号推导 createdByMemberId：服务端绝不信任 payload 声明的记账人。 成员存在性由访问控制保证（owner 必有一等成员行，editor 必为 ACTIVE REGISTERED 成员）。 */
export function createdByMemberIdFor(ledgerId: string, userId: string): string {
  return registeredMemberId(ledgerId, userId);
}

/**
 * 解析交易付款人：显式引用按账本级成员解析，缺省或引用为空回落到记账人本人。
 * REST 新建/更新、批量导入与同步 push 共用同一规则，避免各入口各自兜底。
 */
export async function resolvePayerMember(
  db: Prisma.TransactionClient,
  ledgerId: string,
  userId: string,
  payerMemberId: string | null | undefined,
  historicalMemberIds?: ReadonlySet<string>,
): Promise<string> {
  if (payerMemberId === undefined || payerMemberId === null) return createdByMemberIdFor(ledgerId, userId);
  return (
    (await resolveMemberReference(db, ledgerId, { member_id: payerMemberId }, historicalMemberIds)) ??
    createdByMemberIdFor(ledgerId, userId)
  );
}
