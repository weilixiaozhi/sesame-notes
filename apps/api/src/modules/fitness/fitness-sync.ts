import {
  type SyncMutationEnvelope,
  identifySyncMutation,
  hasSyncRevisionConflict,
} from '../../shared/sync-mutation.js';
import type { FitnessEntity, FitnessSpace, Prisma } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { isStrictTimestamp } from '../../shared/contracts/scalars.js';

import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createChange } from '../sync-events/index.js';
import { uuidV5 } from '../../shared/uuid.js';
import { fitnessPayloadSchemas, type FitnessEntityType } from './fitness-schemas.js';
import { validateFitnessPayload, validateFitnessTransition } from './fitness-rules.js';
import { officialExerciseIds } from './official-fitness.js';

export function fitnessSnapshot(row: FitnessEntity, space: FitnessSpace) {
  return {
    ...(row.payload as Prisma.JsonObject),
    id: row.id,
    fitness_space_id: space.id,
    sync_id: space.syncId,
    revision: row.revision,
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}

/** 复用受控同步事务与事件日志，四种实体不依赖计划或模板的上传顺序。 */
export async function applyFitnessChange(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: SyncMutationEnvelope,
) {
  if (
    !change.fitness_space_id ||
    !Object.hasOwn(fitnessPayloadSchemas, change.entity_type) ||
    change.ledger_id !== null ||
    change.day_book_id != null ||
    change.memo_book_id != null
  )
    throw new ApiError(400, 'INVALID_FITNESS_SCOPE', '健身数据必须属于当前账号可访问的空间');
  const type = change.entity_type as FitnessEntityType;
  if (change.base_revision !== undefined && (!Number.isSafeInteger(change.base_revision) || change.base_revision < 0))
    throw new ApiError(400, 'INVALID_FITNESS_REVISION', '健身同步版本必须是非负整数');
  if (
    Object.keys(change).some(
      (key) =>
        ![
          'mutation_id',
          'entity_type',
          'entity_id',
          'ledger_id',
          'day_book_id',
          'memo_book_id',
          'fitness_space_id',
          'sync_id',
          'base_revision',
          'action',
          'updated_at',
          'payload',
          'deleted_at',
        ].includes(key),
    )
  )
    throw new ApiError(400, 'INVALID_FITNESS_PAYLOAD', '健身请求包含未知字段');
  const { requestHash, duplicate } = await identifySyncMutation(tx, auth, change);
  const identity = { mutation_id: change.mutation_id, entity_id: change.entity_id };
  if (duplicate) {
    const original = duplicate.payload as { revision: number; sync_id: string };
    return {
      ...identity,
      status: 'ignored' as const,
      change_id: duplicate.changeId.toString(),
      revision: original.revision,
      sync_id: original.sync_id,
    };
  }
  const space = await tx.fitnessSpace.findUnique({ where: { id: change.fitness_space_id } });
  if (!space || space.ownerId !== auth.userId || space.deletedAt)
    throw new ApiError(404, 'FITNESS_SPACE_NOT_FOUND', '健身空间不存在或不可访问');
  if (space.syncId !== change.sync_id) throw new ApiError(412, 'SYNC_ID_MISMATCH', '健身空间同步身份已变化');
  const current = await tx.fitnessEntity.findUnique({ where: { id: change.entity_id } });
  if (current && (current.fitnessSpaceId !== space.id || current.entityType !== type))
    throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '健身记录标识不可用于当前账号或类型');
  const conflict = (message?: string) => ({
    ...identity,
    status: 'conflict' as const,
    change_id: null,
    current_revision: current?.revision ?? 0,
    current_deleted: !current || current.deletedAt !== null,
    current_entity: current ? fitnessSnapshot(current, space) : null,
    ...(message ? { message } : {}),
  });
  if (current?.deletedAt && change.action === 'delete' && Object.keys(change.payload).length === 0) {
    // 重复删除已经删除的记录属于一致结果，不制造待处理冲突。
    const changeId = await createChange(
      tx,
      auth,
      null,
      type,
      current.id,
      'delete',
      fitnessSnapshot(current, space),
      new Date(),
      null,
      change.mutation_id,
      requestHash,
      null,
      null,
      space.id,
    );
    return {
      ...identity,
      status: 'ignored' as const,
      change_id: changeId.toString(),
      revision: current.revision,
      sync_id: space.syncId,
    };
  }
  if (hasSyncRevisionConflict(change, current)) return conflict();
  const now = new Date();
  let initialDeletedAt: Date | null = null;
  if (change.deleted_at !== undefined) {
    initialDeletedAt = new Date(change.deleted_at);
    if (current || change.action !== 'upsert' || !isStrictTimestamp(change.deleted_at))
      throw new ApiError(400, 'INVALID_FITNESS_TOMBSTONE', '首次墓碑必须携带有效时间及完整载荷');
  }
  let saved: FitnessEntity;
  if (change.action === 'delete') {
    if (Object.keys(change.payload).length) throw new ApiError(400, 'INVALID_FITNESS_PAYLOAD', '删除载荷必须为空');
    saved = await tx.fitnessEntity.update({
      where: { id: current!.id },
      data: { deletedAt: now, updatedAt: now, revision: { increment: 1 } },
    });
  } else {
    validateFitnessPayload(type, change.payload, await officialExerciseIds(tx));
    if (current) validateFitnessTransition(type, current.payload as Record<string, unknown>, change.payload);
    if (type === 'fitness_preferences' && change.entity_id !== space.id)
      throw new ApiError(400, 'INVALID_FITNESS_PREFERENCES_ID', '健身偏好标识必须为所属空间标识');
    const references = new Set<string>();
    function collect(value: unknown): void {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'source_plan_id' || key === 'source_template_id') && typeof child === 'string')
          references.add(child);
        else collect(child);
      }
    }
    collect(change.payload);
    if (
      references.size &&
      (await tx.fitnessEntity.findFirst({ where: { id: { in: [...references] }, fitnessSpaceId: { not: space.id } } }))
    )
      throw new ApiError(400, 'FITNESS_CROSS_SPACE_REFERENCE', '训练来源必须属于同一空间');
    const status = type === 'fitness_workout' ? (change.payload.status as string) : null;
    const occurrenceKey = type === 'fitness_workout' ? (change.payload.occurrence_key as string | null) : null;
    if (occurrenceKey) {
      const planId = change.payload.source_plan_id as string;
      const parts = occurrenceKey.split(':');
      if (
        parts.length !== 4 ||
        parts[0] !== planId ||
        !/^(?:0|[1-9]\d*)$/.test(parts[1]!) ||
        !/^(?:0|[1-9]\d*)$/.test(parts[2]!) ||
        !/^[0-9a-f-]{36}$/.test(parts[3]!) ||
        uuidV5(planId, occurrenceKey) !== change.entity_id
      )
        throw new ApiError(400, 'INVALID_FITNESS_OCCURRENCE', '计划训练必须使用稳定的安排身份');
    }
    if (status === 'in_progress' && initialDeletedAt === null) {
      const blocking = await tx.fitnessEntity.findFirst({
        where: { fitnessSpaceId: space.id, status: 'in_progress', deletedAt: null, id: { not: change.entity_id } },
      });
      if (blocking)
        return {
          ...conflict('已有进行中训练，请保留本地分支并处理冲突'),
          blocking_entity: fitnessSnapshot(blocking, space),
        };
    }
    if (
      occurrenceKey &&
      (await tx.fitnessEntity.findFirst({
        where: { fitnessSpaceId: space.id, occurrenceKey, id: { not: change.entity_id } },
        select: { id: true },
      }))
    )
      return conflict('该计划安排已经生成或删除，不可重复创建');
    const data = {
      payload: change.payload as Prisma.InputJsonObject,
      status,
      occurrenceKey,
      updatedAt: new Date(change.payload.updated_at as string),
    };
    saved = current
      ? await tx.fitnessEntity.update({ where: { id: current.id }, data: { ...data, revision: { increment: 1 } } })
      : await tx.fitnessEntity.create({
          data: {
            ...data,
            id: change.entity_id,
            fitnessSpaceId: space.id,
            entityType: type,
            createdAt: new Date(change.payload.created_at as string),
            deletedAt: initialDeletedAt,
          },
        });
  }
  await tx.fitnessSpace.update({
    where: { id: space.id },
    data: {
      updatedAt: new Date(Math.max(space.updatedAt.getTime(), saved.updatedAt.getTime())),
    },
  });
  const changeId = await createChange(
    tx,
    auth,
    null,
    type,
    saved.id,
    saved.deletedAt ? 'delete' : 'upsert',
    fitnessSnapshot(saved, space),
    now,
    null,
    change.mutation_id,
    requestHash,
    null,
    null,
    space.id,
  );
  return {
    ...identity,
    status: 'accepted' as const,
    change_id: changeId.toString(),
    revision: saved.revision,
    sync_id: space.syncId,
  };
}
