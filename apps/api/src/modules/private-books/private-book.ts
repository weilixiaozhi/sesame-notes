import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { parseStrictTimestamp } from '../../shared/contracts/scalars.js';
import { assertSyncSnapshot, type PushOutcome } from '../../shared/sync-mutation.js';

import { hasVisibleText, normalizeName } from '../../shared/text-validation.js';
import type { SyncTransaction } from '../../shared/sync-transaction.js';

type PrivateBook = { id: string; name: string; syncId: string; revision: number; createdAt: Date; updatedAt: Date };

/** 私有本（日子本 / 备忘录本 / 健身空间）共用权威快照；额外字段由调用方扩展。 */
export function privateBookSnapshot(
  row: {
    id: string;
    name: string;
    syncId: string;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  },
  extra: Record<string, unknown> = {},
) {
  return {
    id: row.id,
    name: row.name,
    ...extra,
    sync_id: row.syncId,
    revision: row.revision,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

/**
 * 私有本的 revision 冲突结果：缺失与墓碑都视为云端已删除，实体存在时附带权威快照。
 * 本地未确认分支由客户端保留，服务端只回答当前版本事实。
 */
export function privateBookConflictOutcome(
  change: { mutation_id: string; entity_id: string },
  current: { revision: number; deletedAt: Date | null } | null,
  snapshot: (current: { revision: number; deletedAt: Date | null }) => unknown,
): PushOutcome {
  return {
    mutation_id: change.mutation_id,
    entity_id: change.entity_id,
    status: 'conflict',
    change_id: null,
    current_revision: current?.revision ?? 0,
    current_deleted: !current || current.deletedAt !== null,
    current_entity: current ? snapshot(current) : null,
  };
}

/**
 * 私有父本共用创建、改名、条件删除和整本恢复规则；内容清理由业务在同一事务执行。
 *
 * 客户端未携带 updated_at 时（日子本由服务端维护内容时间）落当前时间；
 * 携带时按单调不回退合并，避免设备时钟落后把已确认的内容时间改小。
 */
export async function preparePrivateBookWrite(
  tx: SyncTransaction,
  scope: Prisma.SyncChangeWhereInput,
  current: PrivateBook | null,
  change: { action: 'upsert' | 'delete'; sync_id?: string; payload: Record<string, unknown> },
  retentionMinCursor: bigint,
  extraFields: readonly string[] = [],
) {
  const restoring = change.action === 'upsert' && change.payload.restore === true;
  if (!current && change.sync_id !== undefined) throw new ApiError(412, 'SYNC_ID_MISMATCH', '本同步身份已失效');
  if (change.action === 'delete' || restoring) {
    if (!current) throw new ApiError(404, 'BOOK_NOT_FOUND', '操作前需下载原云端本');
    await assertSyncSnapshot(tx, scope, change.payload.expected_full_cursor, retentionMinCursor);
  }
  const now = new Date();
  if (change.action === 'delete') {
    return {
      restoring,
      data: {
        name: current!.name,
        createdAt: current!.createdAt,
        updatedAt: now,
        syncId: current!.syncId,
        revision: current!.revision + 1,
        deletedAt: now,
      },
    };
  }
  const { name, created_at, updated_at } = change.payload;
  if (
    typeof name !== 'string' ||
    !hasVisibleText(name) ||
    Object.keys(change.payload).some(
      (key) => !['name', 'created_at', 'updated_at', 'restore', 'expected_full_cursor', ...extraFields].includes(key),
    ) ||
    (change.payload.restore !== undefined && typeof change.payload.restore !== 'boolean') ||
    (!restoring && change.payload.expected_full_cursor !== undefined)
  )
    throw new ApiError(400, 'INVALID_BOOK', '本字段无效');
  const createdAt = parseStrictTimestamp(created_at, 'INVALID_BOOK_TIMESTAMP', '本时间无效');
  const clientUpdatedAt =
    updated_at === undefined ? null : parseStrictTimestamp(updated_at, 'INVALID_BOOK_TIMESTAMP', '本时间无效');
  if (current && !restoring && current.createdAt.getTime() !== createdAt.getTime())
    throw new ApiError(400, 'BOOK_IDENTITY_IMMUTABLE', '创建时间不可修改');
  return {
    restoring,
    data: {
      name: normalizeName(name),
      createdAt,
      updatedAt:
        clientUpdatedAt === null
          ? now
          : current && !restoring
            ? new Date(Math.max(current.updatedAt.getTime(), clientUpdatedAt.getTime()))
            : clientUpdatedAt,
      syncId: !current || restoring ? randomUUID() : current.syncId,
      revision: !current || restoring ? 1 : current.revision + 1,
      deletedAt: null,
    },
  };
}
