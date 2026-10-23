import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import { recordSyncChangeId } from '../../shared/realtime-context.js';

/** 在调用方事务中追加同步事件，并记录事件 ID 供响应结束后发布重新 pull 提示。 */
export async function createChange(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  ledgerId: string | null,
  entityType: string,
  entityId: string,
  action: 'upsert' | 'delete',
  payload: Prisma.InputJsonValue,
  updatedAt: Date,
  recipientUserId: string | null = null,
  mutationId: string = randomUUID(),
  requestHash: string | null = null,
  dayBookId: string | null = null,
  memoBookId: string | null = null,
  fitnessSpaceId: string | null = null,
): Promise<bigint> {
  try {
    // 未提供 mutation_id 时生成随机 ID；同步交易 mutation core 传入客户端 ID 参与去重。
    const event = await tx.syncChange.create({
      data: {
        userId: auth.userId,
        ledgerId,
        dayBookId,
        memoBookId,
        fitnessSpaceId,
        scope: ledgerId ? 'ledger' : 'user',
        entityType,
        entityId,
        action,
        mutationId,
        requestHash,
        payload,
        updatedAt,
        deviceId: auth.deviceId,
        recipientUserId,
      },
    });
    recordSyncChangeId(event.changeId);
    return event.changeId;
  } catch (error) {
    throw new Error('同步事件写入失败', { cause: error });
  }
}

/** 删除账号私有时间线及将被物理删除的自有账本日志，保留其他账本的共享历史。 */
export async function removeAccountChanges(
  tx: SyncTransaction,
  userId: string,
  ownedLedgerIds: string[],
): Promise<void> {
  try {
    // 删除可移除全局最大事件；先保存同一提交锁下的水位，事务失败时下界与删除一起回滚。
    const preserved = await tx.$executeRaw`
      UPDATE server_epochs
      SET sync_cursor_floor = GREATEST(
        sync_cursor_floor,
        COALESCE(sync_cutover_cursor, 0),
        COALESCE((SELECT MAX(change_id) FROM sync_changes), 0)
      )
      WHERE id = 0
    `;
    if (preserved !== 1) throw new Error('同步水位单例缺失，无法安全清理账号事件');
    await tx.syncChange.deleteMany({
      where: {
        OR: [
          { userId, ledgerId: null },
          { ledgerId: { in: ownedLedgerIds } },
          { entityType: { in: ['ledger', 'ledger_archive'] }, entityId: { in: ownedLedgerIds } },
        ],
      },
    });
  } catch (cause) {
    throw new Error('账号私有同步历史清理失败', { cause });
  }
}

/** 大批量原子导入复用事件唯一入口，分批写入并登记最大游标作为实时提示。 */
export async function createChanges(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  ledgerId: string | null,
  changes: Array<{
    entityType: string;
    entityId: string;
    action: 'upsert' | 'delete';
    payload: Prisma.InputJsonValue;
    updatedAt: Date;
  }>,
): Promise<void> {
  for (let offset = 0; offset < changes.length; offset += 250) {
    const rows = await tx.syncChange.createManyAndReturn({
      data: changes.slice(offset, offset + 250).map((change) => ({
        userId: auth.userId,
        deviceId: auth.deviceId,
        ledgerId,
        scope: ledgerId ? 'ledger' : 'user',
        entityType: change.entityType,
        entityId: change.entityId,
        action: change.action,
        mutationId: randomUUID(),
        payload: change.payload,
        updatedAt: change.updatedAt,
      })),
      select: { changeId: true },
    });
    if (rows.length)
      recordSyncChangeId(rows.reduce((maximum, row) => (row.changeId > maximum ? row.changeId : maximum), 0n));
  }
}
