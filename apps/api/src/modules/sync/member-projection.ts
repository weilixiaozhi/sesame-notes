import { normalizeName } from '../../shared/text-validation.js';
import type { LedgerMember, Prisma } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { getLedgerWriteAccess } from '../accounting/index.js';
import type { PushChange } from './sync-schemas.js';
import { type ApplyOutcome, isNewer, requireLedgerId } from './projection-support.js';
import { memberSnapshot } from './sync-snapshots.js';

/**
 * 应用账本级占位成员资料（PLACEHOLDER），LWW 由 updatedAt/deviceId 裁决、mutation 幂等去重。
 *
 * - upsert：display_name 落账本成员快照，member_type/status 由成员生命周期决定；
 *   已有的 REGISTERED 成员不允许经同步改名（资料收敛走账号 profile）。
 * - delete：仍被交易引用的成员拒绝删除（保留历史身份），仅置 REMOVED。
 */
export async function applyMember(
  tx: Prisma.TransactionClient,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
): Promise<ApplyOutcome> {
  const ledgerId = requireLedgerId(change);
  const access = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'editor');
  // 生命周期检查与写入持有同一排他行锁；成员移除提交后，离线 upsert
  // 必须重新读取 REMOVED，而不能用锁等待前的旧快照复活成员。
  const [current] = await tx.$queryRaw<
    Array<Pick<LedgerMember, 'id' | 'ledgerId' | 'updatedAt' | 'updatedByDeviceId' | 'memberType' | 'status'>>
  >`
    SELECT "id", "ledger_id" AS "ledgerId", "updated_at" AS "updatedAt",
           "updated_by_device_id" AS "updatedByDeviceId", "member_type" AS "memberType", "status"
    FROM "ledger_members"
    WHERE "id" = ${change.entity_id}::uuid
    FOR UPDATE
  `;
  if (current && current.ledgerId !== ledgerId)
    throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '成员 UUID 已属于其他账本');
  const initialStatus = change.payload.initial_status;
  if (initialStatus !== undefined) {
    // 所有者可明确迁入新的历史占位身份；该标记不授予既有成员状态修改或账号权限。
    if (
      access.role !== 'owner' ||
      (change.base_revision !== undefined && change.base_revision !== 0) ||
      current ||
      change.action !== 'upsert' ||
      (initialStatus !== 'ACTIVE' && initialStatus !== 'LEFT' && initialStatus !== 'REMOVED')
    )
      throw new ApiError(400, 'INVALID_MEMBER_INITIAL_STATE', '只有账本所有者可为全新占位成员导入历史状态');
  }
  if (current && !isNewer(updatedAt, auth.deviceId, current.updatedAt, current.updatedByDeviceId))
    return { status: 'ignored' };

  if (change.action === 'delete') {
    if (!current) return { status: 'ignored' };
    if (current.memberType !== 'PLACEHOLDER')
      throw new ApiError(400, 'INVALID_MEMBER_DELETE', '注册成员不能经同步删除');
    const [payerRef, splitRef] = await Promise.all([
      tx.transaction.findFirst({ where: { ledgerId, deletedAt: null, payerMemberId: current.id } }),
      tx.transactionSplit.findFirst({ where: { memberId: current.id } }),
    ]);
    if (payerRef || splitRef) throw new ApiError(409, 'MEMBER_IN_USE', '该成员仍被交易引用，无法删除');
    const removed = await tx.ledgerMember.update({
      where: { id: current.id },
      data: { status: 'REMOVED', updatedAt, updatedByDeviceId: auth.deviceId },
    });
    return { status: 'applied', payload: memberSnapshot(removed) };
  }

  const displayName = normalizeName(change.payload.display_name);
  if (current && current.memberType !== 'PLACEHOLDER')
    throw new ApiError(400, 'INVALID_MEMBER_TARGET', '注册成员资料由账号收敛，不能经同步修改');
  if (current?.status === 'REMOVED')
    throw new ApiError(400, 'INVALID_MEMBER_TARGET', '已移除的占位成员不能重新激活，请创建新成员');
  const member = await tx.ledgerMember.upsert({
    where: { id: change.entity_id },
    create: {
      id: change.entity_id,
      ledgerId,
      displayName,
      memberType: 'PLACEHOLDER',
      linkedAccountId: null,
      role: 'editor',
      status: initialStatus ?? 'ACTIVE',
      updatedAt,
      updatedByDeviceId: auth.deviceId,
    },
    update: { displayName, updatedAt, updatedByDeviceId: auth.deviceId },
  });
  return { status: 'applied', payload: memberSnapshot(member) };
}
