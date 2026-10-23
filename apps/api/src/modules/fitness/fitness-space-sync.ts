import type { FitnessSpace } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import {
  identifySyncMutation,
  hasSyncRevisionConflict,
  type SyncMutationEnvelope,
  type PushOutcome,
} from '../../shared/sync-mutation.js';
import { preparePrivateBookWrite, privateBookConflictOutcome, privateBookSnapshot } from '../private-books/index.js';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createChange } from '../sync-events/index.js';

/** 健身空间接入私有父本条件写入；实体等待父本确认后使用同一绑定。 */
export async function applyFitnessSpaceChange(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: SyncMutationEnvelope,
  retentionMinCursor: bigint,
): Promise<PushOutcome> {
  const id = change.fitness_space_id;
  if (
    !id ||
    id !== change.entity_id ||
    change.ledger_id !== null ||
    change.day_book_id != null ||
    change.memo_book_id != null
  )
    throw new ApiError(400, 'INVALID_FITNESS_SCOPE', '健身空间归属无效');
  const identity = { mutation_id: change.mutation_id, entity_id: id };
  const { requestHash, duplicate } = await identifySyncMutation(tx, auth, change);
  if (duplicate) {
    const original = duplicate.payload as { revision: number; sync_id: string };
    return {
      ...identity,
      status: 'ignored',
      change_id: duplicate.changeId.toString(),
      revision: original.revision,
      sync_id: original.sync_id,
    };
  }
  const current = await tx.fitnessSpace.findUnique({ where: { id } });
  if (current && current.ownerId !== auth.userId)
    throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '健身空间标识不可用');
  if (current && current.syncId !== change.sync_id)
    throw new ApiError(412, 'SYNC_ID_MISMATCH', '健身空间同步身份已变化');
  if (hasSyncRevisionConflict(change, current))
    return privateBookConflictOutcome(change, current, (row) => privateBookSnapshot(row as FitnessSpace));
  const { restoring, data } = await preparePrivateBookWrite(
    tx,
    { fitnessSpaceId: id },
    current,
    change,
    retentionMinCursor,
  );
  if (restoring) await tx.fitnessEntity.deleteMany({ where: { fitnessSpaceId: id } });
  if (change.action === 'delete')
    await tx.fitnessEntity.updateMany({
      where: { fitnessSpaceId: id, deletedAt: null },
      data: { deletedAt: data.updatedAt, updatedAt: data.updatedAt, revision: { increment: 1 } },
    });
  const saved = current
    ? await tx.fitnessSpace.update({ where: { id }, data })
    : await tx.fitnessSpace.create({ data: { ...data, id, ownerId: auth.userId } });
  const changeId = await createChange(
    tx,
    auth,
    null,
    'fitness_space',
    id,
    change.action,
    privateBookSnapshot(saved),
    new Date(),
    null,
    change.mutation_id,
    requestHash,
    null,
    null,
    id,
  );
  return {
    ...identity,
    status: 'accepted',
    change_id: changeId.toString(),
    revision: saved.revision,
    sync_id: saved.syncId,
  };
}
