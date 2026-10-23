import { normalizeName } from '../../shared/text-validation.js';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import type { LedgerMember } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../shared/errors.js';
import { assertSyncSnapshot } from '../../shared/sync-mutation.js';
import { createChange } from '../sync-events/index.js';
import { deleteLedgerRecord, ensureOwnerMember, getLedgerWriteAccess } from '../accounting/index.js';
import type { PushChange } from './sync-schemas.js';
import { ledgerSnapshot } from './sync-snapshots.js';
import {
  type ApplyOutcome,
  isNewer,
  requiredCurrency,
  requiredInteger,
  requiredBoolean,
} from './projection-support.js';

/** 更新当前账号的个人归档版本，并仅向本人的其他设备追加事件。 */
export async function applyLedgerArchive(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
  requestHash: string,
): Promise<ApplyOutcome> {
  try {
    if (change.ledger_id !== change.entity_id || change.action !== 'upsert') {
      throw new ApiError(400, 'INVALID_LEDGER_ARCHIVE', '归档操作必须对应当前账本');
    }
    const archived = requiredBoolean(change.payload, 'archived');
    await getLedgerWriteAccess(tx, auth.userId, change.entity_id, 'editor');
    const member = await tx.ledgerMember.findUniqueOrThrow({
      where: { ledgerId_linkedAccountId: { ledgerId: change.entity_id, linkedAccountId: auth.userId } },
    });
    // 同设备的全新操作按队列顺序生效，即使秒级持久化使版本相同；重复 mutation 已在入口拦截。
    const sameDeviceVersion =
      member.archiveUpdatedAt?.getTime() === updatedAt.getTime() && member.archiveUpdatedByDeviceId === auth.deviceId;
    if (
      member.archiveUpdatedAt &&
      !sameDeviceVersion &&
      !isNewer(updatedAt, auth.deviceId, member.archiveUpdatedAt, member.archiveUpdatedByDeviceId)
    ) {
      return { status: 'ignored', current_entity: await archiveCurrentEntity(tx, member) };
    }
    const archivedAt = archived ? updatedAt : null;
    const updated = await tx.ledgerMember.update({
      where: { id: member.id },
      data: {
        archivedAt,
        archiveUpdatedAt: updatedAt,
        archiveUpdatedByDeviceId: auth.deviceId,
        // Prisma 会自动更新时间；显式保留共享版本，避免影响成员资料与撤权事件。
        updatedAt: member.updatedAt,
      },
    });
    // 用户范围事件不会被共享账本的其他成员或实时通知收件人读到。
    const changeId = await createChange(
      tx,
      auth,
      null,
      'ledger_archive',
      change.entity_id,
      'upsert',
      {
        ledger_id: change.entity_id,
        archived_at: archivedAt?.toISOString() ?? null,
      },
      updatedAt,
      null,
      change.mutation_id,
      requestHash,
    );
    return { status: 'applied', changeId, current_entity: await archiveCurrentEntity(tx, updated, changeId) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('账本个人归档更新失败', { cause: error });
  }
}

/** 在同一同步事务内返回归档状态及其事件水位，避免旧事件重放覆盖已确认状态。 */
export async function archiveCurrentEntity(tx: SyncTransaction, member: LedgerMember, changeId?: bigint) {
  try {
    // 幂等重放指向的原事件可能早于当前状态，必须读取本人的最新归档事件。
    const currentChangeId =
      changeId ??
      (
        await tx.syncChange.findFirst({
          where: {
            userId: member.linkedAccountId,
            ledgerId: null,
            entityType: 'ledger_archive',
            entityId: member.ledgerId,
          },
          orderBy: { changeId: 'desc' },
          select: { changeId: true },
        })
      )?.changeId ??
      0n;
    return {
      ledger_id: member.ledgerId,
      archived_at: member.archivedAt?.toISOString() ?? null,
      updated_at: member.archiveUpdatedAt?.toISOString() ?? null,
      device_id: member.archiveUpdatedByDeviceId,
      server_cursor: currentChangeId.toString(),
    };
  } catch (error) {
    throw new Error('归档权威状态与同步水位读取失败', { cause: error });
  }
}

/** 应用账本变更；首次离线 Push 会同时建立 Owner 成员关系（Ledger 元数据保留 LWW）。 */
export async function applyLedger(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
  retentionMinCursor: bigint,
): Promise<ApplyOutcome> {
  if (change.ledger_id !== change.entity_id)
    throw new ApiError(400, 'INVALID_LEDGER_SCOPE', '账本变更的 ledger_id 必须等于 entity_id');
  const current = await tx.ledger.findUnique({ where: { id: change.entity_id } });
  if (current && current.ownerId !== auth.userId)
    throw new ApiError(403, 'LEDGER_PERMISSION_DENIED', '只有 Owner 可以同步账本元数据');
  if (change.action === 'delete') {
    if (!current || current.deletedAt !== null) return { status: 'ignored' };
    if (change.payload.expected_full_cursor !== undefined) {
      await assertSyncSnapshot(
        tx,
        { ledgerId: change.entity_id },
        change.payload.expected_full_cursor,
        retentionMinCursor,
      );
    }
    // 删除是明确意图，不能被设备时钟落后静默忽略；事件与墓碑保持同一权威时间。
    const deletedAt = new Date(Math.max(updatedAt.getTime(), current.updatedAt.getTime()));
    const removed = await deleteLedgerRecord(tx, auth, change.entity_id, deletedAt);
    return {
      status: 'applied',
      updatedAt: removed.updatedAt,
      payload: { ...ledgerSnapshot(removed), deleted_at: removed.deletedAt!.toISOString() },
    };
  }
  if (current?.deletedAt)
    return { status: 'conflict', current_revision: 0, current_deleted: true, current_entity: null };
  if (current && !isNewer(updatedAt, auth.deviceId, current.updatedAt, current.updatedByDeviceId))
    return { status: 'ignored' };
  const payload = change.payload;
  const name = normalizeName(payload.name);
  const currency = requiredCurrency(payload, 'currency');
  const monthStartDay = requiredInteger(payload, 'month_start_day', 1, 31);
  const aaEnabled = requiredBoolean(payload, 'aa_enabled');
  const ledger = await tx.ledger.upsert({
    where: { id: change.entity_id },
    create: {
      id: change.entity_id,
      // 同步身份由服务端权威生成（客户端首次上云时尚未持有，创建后经 outcome 返回）
      syncId: randomUUID(),
      ownerId: auth.userId,
      name,
      currency,
      monthStartDay,
      aaEnabled,
      updatedAt,
      updatedByDeviceId: auth.deviceId,
    },
    update: { name, currency, monthStartDay, aaEnabled, deletedAt: null, updatedAt, updatedByDeviceId: auth.deviceId },
  });
  // 同步创建/更新的账本，Owner 必须是同事务内的一等成员行
  await ensureOwnerMember(tx, change.entity_id, auth.userId, {
    createdAt: updatedAt,
    updatedAt,
    updatedByDeviceId: auth.deviceId,
  });
  return { status: 'applied', payload: ledgerSnapshot(ledger) };
}
