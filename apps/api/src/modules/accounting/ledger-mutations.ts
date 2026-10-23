import type { SyncTransaction } from '../../shared/sync-transaction.js';
import type { Ledger } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { getLedgerWriteAccess } from './domain/ledger-access.js';

/** 账本元数据采用严格递增时间，使已读取当前版本的设备能够应用后续明确写入。 */
export function nextLedgerTimestamp(ledger: Pick<Ledger, 'updatedAt'>, requestedAt = new Date()): Date {
  return new Date(Math.max(requestedAt.getTime(), ledger.updatedAt.getTime() + 1));
}

/** 在线删除与离线删除共用授权、墓碑及未使用邀请撤销，不另建两套级联规则。 */
export async function deleteLedgerRecord(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  ledgerId: string,
  updatedAt: Date,
): Promise<Ledger> {
  try {
    await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
    const ledger = await tx.ledger.update({
      where: { id: ledgerId },
      data: { deletedAt: updatedAt, updatedAt, updatedByDeviceId: auth.deviceId },
    });
    await tx.ledgerInvite.updateMany({
      where: { ledgerId, usedAt: null, revokedAt: null },
      data: { revokedAt: updatedAt },
    });
    return ledger;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('账本删除失败', { cause });
  }
}
