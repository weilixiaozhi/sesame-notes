import { preparePrivateBookWrite, privateBookConflictOutcome } from '../private-books/index.js';
import { Prisma, type MemoBook, type MemoEntry } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { identifySyncMutation, hasSyncRevisionConflict } from '../../shared/sync-mutation.js';
import type { SyncTransaction } from '../../shared/sync-transaction.js';
import { createChange } from '../sync-events/index.js';
import type { SyncMutationEnvelope as PushChange, PushOutcome } from '../../shared/sync-mutation.js';
import { memoTimestamp, validateMemoEntry } from './memo-rules.js';
import { memoBookSnapshot, memoEntrySnapshot } from './memo-snapshots.js';

/** 私有父子写入、CAS 和幂等均在统一提交锁的同一事务中执行。 */
export async function applyMemoChange(
  tx: SyncTransaction,
  auth: { userId: string; deviceId: string },
  change: PushChange,
  retentionMinCursor: bigint,
): Promise<PushOutcome> {
  try {
    const bookId = change.memo_book_id;
    if (
      !bookId ||
      change.ledger_id !== null ||
      change.fitness_space_id != null ||
      change.day_book_id != null ||
      (change.entity_type === 'memo_book' && change.entity_id !== bookId)
    )
      throw new ApiError(400, 'INVALID_MEMO_SCOPE', '备忘录所属本无效');
    if (Buffer.byteLength(JSON.stringify(change), 'utf8') > 768 * 1024)
      throw new ApiError(400, 'MEMO_SYNC_BUDGET', '备忘录超过单条同步预算，请保留本机内容');
    const { requestHash, duplicate } = await identifySyncMutation(tx, auth, change);
    if (duplicate) {
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
    let book = await tx.memoBook.findUnique({ where: { id: bookId } });
    if (book && book.ownerId !== auth.userId) throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '备忘录本标识不可用');
    if (book && book.syncId !== change.sync_id) throw new ApiError(412, 'SYNC_ID_MISMATCH', '备忘录本同步身份已变化');
    const current =
      change.entity_type === 'memo_book' ? book : await tx.memoEntry.findUnique({ where: { id: change.entity_id } });
    if (current && 'memoBookId' in current && current.memoBookId !== bookId)
      throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '内容标识不可用于此本');
    if (hasSyncRevisionConflict(change, current))
      return privateBookConflictOutcome(change, current, (row) =>
        'memoBookId' in row ? memoEntrySnapshot(row as MemoEntry, book!) : memoBookSnapshot(row as MemoBook),
      );
    const now = new Date();
    let saved: MemoBook | MemoEntry;
    if (change.entity_type === 'memo_book') {
      if (
        change.action === 'upsert' &&
        (!['normal', 'credentials'].includes(change.payload.type as string) ||
          (book && book.type !== change.payload.type))
      )
        throw new ApiError(400, 'INVALID_MEMO_BOOK', '备忘录本类型不可修改');
      const { restoring, data } = await preparePrivateBookWrite(
        tx,
        { memoBookId: bookId },
        book,
        change,
        retentionMinCursor,
        ['type'],
      );
      if (restoring) await tx.memoEntry.deleteMany({ where: { memoBookId: bookId } });
      if (change.action === 'delete')
        await tx.memoEntry.updateMany({
          where: { memoBookId: bookId, deletedAt: null },
          data: { deletedAt: data.updatedAt, updatedAt: data.updatedAt, revision: { increment: 1 } },
        });
      saved = book
        ? await tx.memoBook.update({ where: { id: bookId }, data })
        : await tx.memoBook.create({
            data: { ...data, id: bookId, ownerId: auth.userId, type: change.payload.type as string },
          });
      book = saved;
    } else {
      if (!book || book.deletedAt) throw new ApiError(404, 'MEMO_BOOK_NOT_FOUND', '备忘录本不存在或已删除');
      if (change.action === 'delete')
        saved = await tx.memoEntry.update({
          where: { id: change.entity_id },
          data: { deletedAt: now, updatedAt: now, revision: { increment: 1 } },
        });
      else {
        const payload = validateMemoEntry(change.payload);
        const createdAt = memoTimestamp(payload.created_at);
        const updatedAt = memoTimestamp(payload.updated_at);
        if (payload.book_type !== book.type) throw new ApiError(400, 'MEMO_TYPE_MISMATCH', '内容类型与本子不一致');
        const existing = current as MemoEntry | null;
        if (existing && existing.createdAt.getTime() !== createdAt.getTime())
          throw new ApiError(400, 'MEMO_IDENTITY_IMMUTABLE', '创建时间不可修改');
        const data = {
          title: payload.title,
          bodyFormat: payload.body_format,
          // validateMemoEntry 已确认正文只含 JSON 值，这里只需满足 Prisma 的输入类型。
          body: payload.body === null ? Prisma.DbNull : (payload.body as Prisma.InputJsonValue),
          // 卡片顺序与正文共用同一 CAS 版本，成功后通过完整快照同步给其他设备。
          orderKey: payload.order_key === null ? null : BigInt(payload.order_key),
          updatedAt,
        };
        saved = existing
          ? await tx.memoEntry.update({
              where: { id: change.entity_id },
              data: { ...data, revision: { increment: 1 } },
            })
          : await tx.memoEntry.create({
              data: { ...data, id: change.entity_id, memoBookId: bookId, bookType: book.type, createdAt },
            });
      }
      // 子变更只触及聚合内容时间，不递增父本改名/删除使用的 CAS 版本。
      book = await tx.memoBook.update({
        where: { id: bookId },
        data: { updatedAt: new Date(Math.max(book.updatedAt.getTime(), saved.updatedAt.getTime())) },
      });
    }
    const snapshot = 'memoBookId' in saved ? memoEntrySnapshot(saved, book) : memoBookSnapshot(saved);
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
      null,
      bookId,
    );
    return {
      mutation_id: change.mutation_id,
      entity_id: change.entity_id,
      status: 'accepted',
      change_id: changeId.toString(),
      revision: saved.revision,
      sync_id: book.syncId,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Prisma 错误可能含敏感字段，只将安全分类穿过同步日志边界。
    throw new ApiError(500, 'MEMO_WRITE_FAILED', '备忘录同步写入失败');
  }
}
