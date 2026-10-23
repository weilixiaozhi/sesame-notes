import { categoryState } from '../../shared/category-version.js';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { identifySyncMutation } from '../../shared/sync-mutation.js';
import { createChange } from '../sync-events/index.js';
import { getLedgerWriteAccess, mapTransaction } from '../accounting/index.js';
import type { PushChange, PushOutcome } from './sync-schemas.js';
import { applyDayChange } from '../days/index.js';
import { applyMemoChange } from '../memos/index.js';
import { applyFitnessSpaceChange, applyFitnessChange, fitnessPayloadSchemas } from '../fitness/index.js';
import { type ApplyOutcome, currentLedgerSyncId } from './projection-support.js';
import { applyLedgerArchive, archiveCurrentEntity, applyLedger } from './ledger-projection.js';

import { applyTransaction } from './transaction-projection.js';
import { applyMember } from './member-projection.js';
import { applyCategory, applyRecurring, applyRateOverride } from './catalog-projection.js';

/** 应用一个实体变更；每个 mutation 独立事务（per-mutation 语义：一个 conflict/invalid 不阻塞同批其他实体），幂等与 revision 冲突按既定规则处理。 */
export async function applyChange(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
  retentionMinCursor = 0n,
): Promise<PushOutcome> {
  try {
    if (change.entity_type === 'fitness_space')
      return await applyFitnessSpaceChange(tx, auth, change, retentionMinCursor);
    if (Object.hasOwn(fitnessPayloadSchemas, change.entity_type)) return await applyFitnessChange(tx, auth, change);
    if (change.entity_type === 'memo_book' || change.entity_type === 'memo_entry')
      return await applyMemoChange(tx, auth, change, retentionMinCursor);
    if (change.fitness_space_id != null) throw new ApiError(400, 'INVALID_FITNESS_SCOPE', '非健身变更不能携带空间归属');
    if (change.memo_book_id != null) throw new ApiError(400, 'INVALID_MEMO_SCOPE', '非备忘录变更不能携带备忘录归属');
    if (change.entity_type === 'day_book' || change.entity_type === 'day_event')
      return await applyDayChange(tx, auth, change, retentionMinCursor);
    // 账本状态与同步身份只向当前有权限的调用者公开，幂等重放也必须通过资源授权。
    await authorizeLedgerChange(tx, auth.userId, change);
    // 在投影与同步身份校验前检查幂等：已应用的 mutation 返回首次事件的 change_id 和 revision。
    // 部分实体另外返回当前快照，供客户端区分原始回执与后续云端状态。
    const { requestHash, duplicate } = await identifySyncMutation(tx, auth, change);
    if (duplicate) {
      const original = duplicate.payload as { revision?: number; sync_id?: string };
      const revision = original.revision;
      // 幂等回放保留首次事件中的同步身份，恢复后的当前绑定不能重写原回执。
      const syncId = original.sync_id;
      const archiveMember =
        change.entity_type === 'ledger_archive'
          ? await tx.ledgerMember.findFirst({
              where: {
                ledgerId: change.entity_id,
                linkedAccountId: auth.userId,
                memberType: 'REGISTERED',
                status: 'ACTIVE',
                ledger: { deletedAt: null },
              },
            })
          : null;
      // 重放返回的是当前云态；保持 ignored，不能冒充首次执行快照给后继编辑补基线。
      const category =
        change.entity_type === 'category'
          ? await tx.category.findFirst({ where: { id: change.entity_id, ownerId: auth.userId } })
          : null;
      const occurrence =
        change.entity_type === 'transaction' && change.payload.occurrence_date != null
          ? await tx.transaction.findUnique({ where: { id: change.entity_id }, include: { splits: true } })
          : null;
      return {
        category_state: category ? categoryState(category) : undefined,
        mutation_id: change.mutation_id,
        entity_id: change.entity_id,
        status: 'ignored',
        change_id: duplicate.changeId.toString(),
        revision,
        current_revision: occurrence?.revision,
        current_deleted: occurrence ? occurrence.deletedAt !== null : undefined,
        sync_id: syncId,
        current_entity: occurrence
          ? occurrence.deletedAt
            ? null
            : mapTransaction(occurrence)
          : archiveMember
            ? await archiveCurrentEntity(tx, archiveMember)
            : undefined,
      };
    }
    // 同步身份校验：幂等检查之后、投影之前（已送达的重复请求不重复判定）
    await assertSyncIdMatches(tx, change);
    const result = await applyProjection(tx, auth, change, updatedAt, requestHash, retentionMinCursor);
    updatedAt = result.updatedAt ?? updatedAt;
    if (result.status !== 'applied') {
      return {
        mutation_id: change.mutation_id,
        entity_id: change.entity_id,
        status: result.status,
        change_id: null,
        current_revision: result.current_revision,
        current_deleted: result.current_deleted,
        current_entity: result.current_entity,
        category_state: result.category_state,
        category_conflict: result.category_conflict,
        category_resolution: result.category_resolution,
      };
    }
    if (result.noChange)
      return {
        mutation_id: change.mutation_id,
        entity_id: change.entity_id,
        status: 'accepted',
        change_id: null,
        current_entity: result.current_entity,
        category_state: result.category_state,
        category_resolution: result.category_resolution,
      };
    let changeId = result.changeId;
    if (changeId === undefined) {
      // 交易的创建、更新和删除均由领域操作原子写入事件，缺失事件属于实现错误。
      if (change.entity_type === 'transaction') throw new Error('交易操作未返回同步事件身份');
      // 投影提供的快照包含数据库权威身份、规范内容与版本时间，接收端可直接落库。
      const payload: Prisma.InputJsonValue =
        result.payload === undefined ? (change.payload as Prisma.InputJsonValue) : result.payload;
      changeId = await createChange(
        tx,
        auth,
        change.ledger_id,
        change.entity_type,
        change.entity_id,
        change.action,
        payload,
        updatedAt,
        null,
        change.mutation_id,
        requestHash,
      );
    }
    // ledger 实体返回当前 sync_id：首次上云创建账本时客户端据此建立本地绑定
    let syncId: string | undefined;
    if (change.entity_type === 'ledger') {
      syncId = await currentLedgerSyncId(tx, change.entity_id);
    }
    // 首次 accepted 且 change_id 非空时，category_state 必须是本 mutation 的事务执行快照。
    return {
      mutation_id: change.mutation_id,
      entity_id: change.entity_id,
      status: 'accepted',
      change_id: changeId.toString(),
      sync_id: syncId,
      revision: result.revision,
      category_state: result.category_state,
      current_entity: result.current_entity,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error(`同步实体 ${change.entity_id} 无法应用`, { cause: error });
  }
}

/** 已存在的有效账本先锁定并授权；首次创建和已删除账本交由投影处理其状态语义。 */
async function authorizeLedgerChange(tx: SyncTransaction, userId: string, change: PushChange): Promise<void> {
  try {
    if (!change.ledger_id) return;
    const ledger = await tx.ledger.findUnique({ where: { id: change.ledger_id }, select: { deletedAt: true } });
    if (!ledger || ledger.deletedAt !== null) return;
    await getLedgerWriteAccess(tx, userId, change.ledger_id, change.entity_type === 'ledger' ? 'owner' : 'editor');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('同步账本权限检查失败', { cause: error });
  }
}

/**
 * 校验账本级变更携带的 sync_id 与云端当前时间线一致。
 *
 * sync_id 标识同步时间线；不一致时返回 412，由客户端进入 STALE_BINDING 处理。
 * user 级实体（category/rate）无账本边界，不校验；
 * 服务端账本尚不存在（首次上云创建）或已 tombstone 时也不校验（走创建/现状语义）。
 */
async function assertSyncIdMatches(tx: Prisma.TransactionClient, change: PushChange): Promise<void> {
  if (!change.ledger_id) return;
  const ledger = await tx.ledger.findUnique({
    where: { id: change.ledger_id },
    select: { syncId: true, deletedAt: true },
  });
  if (!ledger || ledger.deletedAt !== null) return;
  if (change.sync_id !== ledger.syncId) {
    throw new ApiError(412, 'SYNC_ID_MISMATCH', '同步身份与云端当前时间线不一致，禁止覆盖', {
      client_sync_id: change.sync_id ?? null,
      current_sync_id: ledger.syncId,
    });
  }
}

/**
 * 按实体类型更新当前投影。
 * - transaction：revision 状态机（详见 applyTransaction）；
 * - 官方分类：云基线与候选确认；自定义分类、汇率、周期规则、账本和成员元数据：LWW。
 */
async function applyProjection(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  updatedAt: Date,
  requestHash: string,
  retentionMinCursor: bigint,
): Promise<ApplyOutcome> {
  switch (change.entity_type) {
    case 'day_book':
    case 'day_event':
    case 'memo_book':
    case 'memo_entry':
    case 'fitness_space':
    case 'fitness_template':
    case 'fitness_plan':
    case 'fitness_workout':
    case 'fitness_preferences':
      throw new Error('日子实体必须通过独立 CAS 写边界');
    case 'ledger':
      return applyLedger(tx, auth, change, updatedAt, retentionMinCursor);
    case 'ledger_archive':
      return applyLedgerArchive(tx, auth, change, updatedAt, requestHash);
    case 'transaction':
      return applyTransaction(tx, auth, change, updatedAt, requestHash);
    case 'category':
      return applyCategory(tx, auth, change, updatedAt, requestHash);
    case 'recurring_transaction':
      return applyRecurring(tx, auth, change, updatedAt, requestHash);
    case 'exchange_rate_override':
      return applyRateOverride(tx, auth, change, updatedAt);
    case 'member':
      return applyMember(tx, auth, change, updatedAt);
  }
}
