import type { Prisma } from '@prisma/client';
import type { SyncTransaction } from './sync-transaction.js';
import { ApiError } from './errors.js';
import { requestFingerprint } from './request-fingerprint.js';
import { checkMutationIdentity } from './mutation-reservations.js';
import { committedSyncCursor } from './sync-cutover.js';

/** 所有同步实体使用完整冻结请求及账号计算同一个幂等指纹。 */
export async function identifySyncMutation(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: { mutation_id: string },
) {
  try {
    const requestHash = requestFingerprint({ ...change, user_id: auth.userId });
    const { duplicate } = await checkMutationIdentity(tx, auth, change.mutation_id, requestHash);
    return { requestHash, duplicate };
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('同步请求身份校验失败', { cause });
  }
}

/** CAS 的创建、更新和删除判定不因实体所属页面改变。 */
export function hasSyncRevisionConflict(
  change: { action: 'upsert' | 'delete'; base_revision?: number },
  current: { revision: number; deletedAt: Date | null } | null,
): boolean {
  return current
    ? current.deletedAt !== null || current.revision !== (change.base_revision ?? 0)
    : change.action === 'delete' || (change.base_revision ?? 0) !== 0;
}

/** 条件删除与恢复使用同一完整快照边界，禁止漏掉预览后的远端新增记录。 */
export async function assertSyncSnapshot(
  tx: SyncTransaction,
  scope: Prisma.SyncChangeWhereInput,
  expected: unknown,
  retentionMinCursor: bigint,
): Promise<void> {
  try {
    if (typeof expected !== 'string' || !/^(?:0|[1-9]\d*)$/.test(expected)) {
      throw new ApiError(400, 'SYNC_FULL_REQUIRED', '操作前需完整同步并确认');
    }
    const cursor = BigInt(expected);
    // 与完整快照共用全局上界，事件清理前保存的下界和协议切点仍是合法游标。
    const latest = await committedSyncCursor(tx);
    if (
      cursor < retentionMinCursor ||
      cursor > latest ||
      (await tx.syncChange.findFirst({ where: { ...scope, changeId: { gt: cursor } }, select: { changeId: true } }))
    ) {
      throw new ApiError(409, 'SYNC_SNAPSHOT_CHANGED', '内容已变化，请刷新后重新确认');
    }
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('同步快照边界校验失败', { cause });
  }
}

export type SyncMutationEnvelope = {
  mutation_id: string;
  entity_type: string;
  entity_id: string;
  ledger_id: string | null;
  day_book_id?: string | null;
  memo_book_id?: string | null;
  fitness_space_id?: string | null;
  sync_id?: string;
  base_revision?: number;
  action: 'upsert' | 'delete';
  updated_at: string;
  deleted_at?: string;
  payload: Record<string, unknown>;
};

export type PushOutcome = {
  mutation_id: string;
  entity_id: string;
  status: 'accepted' | 'ignored' | 'conflict' | 'invalid';
  change_id: string | null;
  sync_id?: string;
  revision?: number;
  current_revision?: number;
  current_deleted?: boolean;
  current_entity?: unknown;
  category_state?: unknown;
  category_conflict?: unknown;
  category_resolution?: unknown;
  blocking_entity?: unknown;
  /** 稳定业务错误码，供客户端选择拒绝原因；不包含记录内容。 */
  code?: string;
  message?: string;
};
