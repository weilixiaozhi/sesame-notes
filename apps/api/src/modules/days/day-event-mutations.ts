import type { DayBook, DayEvent, Prisma } from '@prisma/client';

import { ApiError } from '../../shared/errors.js';
import { identifySyncMutation, hasSyncRevisionConflict } from '../../shared/sync-mutation.js';
import { preparePrivateBookWrite, privateBookConflictOutcome, privateBookSnapshot } from '../private-books/index.js';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createChange } from '../sync-events/index.js';
import { dayEventSnapshot } from './day-event-snapshots.js';
import { validateDayEvent } from './day-event-rules.js';
import type { DayDate } from './day-event-schemas.js';
import type { SyncMutationEnvelope as PushChange, PushOutcome } from '../../shared/sync-mutation.js';

/** 将完整日期端点转换为数据库展开列，空端点同时清空全部字段。 */
function dateColumns(prefix: 'event' | 'start' | 'end', date: DayDate | null) {
  return {
    [`${prefix}CalendarType`]: date?.calendar_type ?? null,
    [`${prefix}OriginalYear`]: date?.original_year ?? null,
    [`${prefix}OriginalMonth`]: date?.original_month ?? null,
    [`${prefix}OriginalDay`]: date?.original_day ?? null,
    [`${prefix}IsLeapMonth`]: date?.is_leap_month ?? null,
    [`${prefix}SolarDate`]: date ? new Date(`${date.solar_date}T00:00:00.000Z`) : null,
  };
}

/** 同一个同步事务中处理私有日子父子归属、CAS、冻结指纹及事件写入。 */
export async function applyDayChange(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  retentionMinCursor: bigint,
): Promise<PushOutcome> {
  try {
    const bookId = change.day_book_id;
    if (
      !bookId ||
      change.ledger_id !== null ||
      change.fitness_space_id != null ||
      change.memo_book_id != null ||
      (change.entity_type === 'day_book' && change.entity_id !== bookId)
    )
      throw new ApiError(400, 'INVALID_DAY_SCOPE', '日子所属本无效');
    const { requestHash, duplicate } = await identifySyncMutation(tx, auth, change);
    if (duplicate) {
      // 首次权威快照就是重放结果；后续改名、绑定或墓碑不影响已提交请求。
      const original = duplicate.payload as { revision: number; sync_id: string };
      return {
        mutation_id: change.mutation_id,
        entity_id: change.entity_id,
        status: 'ignored',
        change_id: duplicate.changeId.toString(),
        revision: original.revision,
        sync_id: original.sync_id,
      };
    }
    const book = await tx.dayBook.findUnique({ where: { id: bookId } });
    if (book && book.ownerId !== auth.userId) throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '日子本标识不可用');
    if (book && change.sync_id !== book.syncId)
      throw new ApiError(412, 'SYNC_ID_MISMATCH', '日子本同步身份已失效，请重新连接');
    const now = new Date();
    let snapshot: Prisma.InputJsonValue;
    let revision: number;
    let syncId: string;
    if (change.entity_type === 'day_book') {
      if (hasSyncRevisionConflict(change, book))
        return privateBookConflictOutcome(change, book, (current) => privateBookSnapshot(current as DayBook));
      const { restoring, data } = await preparePrivateBookWrite(
        tx,
        { dayBookId: bookId },
        book,
        change,
        retentionMinCursor,
      );
      // 整本恢复以备份为权威，旧记录在同一事务内清空后重建。
      if (restoring) await tx.dayEvent.deleteMany({ where: { dayBookId: bookId } });
      if (change.action === 'delete')
        await tx.dayEvent.updateMany({
          where: { dayBookId: bookId, deletedAt: null },
          data: {
            deletedAt: data.updatedAt,
            updatedAt: data.updatedAt,
            revision: { increment: 1 },
            updatedByDeviceId: auth.deviceId,
          },
        });
      const saved = book
        ? await tx.dayBook.update({ where: { id: bookId }, data })
        : await tx.dayBook.create({ data: { ...data, id: bookId, ownerId: auth.userId } });
      snapshot = privateBookSnapshot(saved);
      revision = saved.revision;
      syncId = saved.syncId;
    } else {
      if (!book || book.deletedAt) throw new ApiError(404, 'DAY_BOOK_NOT_FOUND', '日子本不存在或已删除');
      const current = await tx.dayEvent.findUnique({ where: { id: change.entity_id } });
      if (current && current.dayBookId !== bookId)
        throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '日子记录标识不可用于此本');
      if (hasSyncRevisionConflict(change, current))
        return privateBookConflictOutcome(change, current, (row) => dayEventSnapshot(row as DayEvent, book.syncId));
      let saved: DayEvent;
      if (change.action === 'delete') {
        saved = await tx.dayEvent.update({
          where: { id: change.entity_id },
          data: { deletedAt: now, updatedAt: now, revision: { increment: 1 }, updatedByDeviceId: auth.deviceId },
        });
      } else {
        const definition = validateDayEvent(change.payload);
        const data = {
          name: definition.name,
          category: definition.category,
          countdownMode: definition.countdown_mode,
          intervalDays: definition.interval_days,
          repeatType: definition.repeat_type,
          statisticType: definition.statistic_type,
          ...dateColumns('event', definition.event),
          ...dateColumns('start', definition.start),
          ...dateColumns('end', definition.end),
          updatedAt: now,
          updatedByDeviceId: auth.deviceId,
        };
        saved = current
          ? await tx.dayEvent.update({ where: { id: change.entity_id }, data: { ...data, revision: { increment: 1 } } })
          : await tx.dayEvent.create({
              data: {
                ...data,
                id: change.entity_id,
                dayBookId: bookId,
                // 创建审计时间参与跨设备稳定排序，使用已验证的原始时间。
                createdAt: new Date(definition.created_at),
              },
            });
      }
      snapshot = dayEventSnapshot(saved, book.syncId);
      revision = saved.revision;
      syncId = book.syncId;
    }
    const changeId = await createChange(
      tx,
      auth,
      null,
      change.entity_type,
      change.entity_id,
      change.action,
      snapshot,
      now,
      null,
      change.mutation_id,
      requestHash,
      bookId,
    );
    return {
      mutation_id: change.mutation_id,
      entity_id: change.entity_id,
      status: 'accepted',
      change_id: changeId.toString(),
      revision,
      sync_id: syncId,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('日子同步写入失败', { cause: error });
  }
}
