import type { MemoBook, MemoEntry } from '@prisma/client';

import { privateBookSnapshot } from '../private-books/index.js';

/** 备忘录本在公共私有本快照上追加本类型。 */
export const memoBookSnapshot = (book: MemoBook) => privateBookSnapshot(book, { type: book.type });

/** 将正文、内容时间与父本时间线转换为增量和完整快照共用的协议字段。 */
export function memoEntrySnapshot(entry: MemoEntry, book: MemoBook) {
  try {
    if (typeof entry.title !== 'string') throw new Error('备忘录标题存储格式无效');
    return {
      id: entry.id,
      memo_book_id: entry.memoBookId,
      book_type: entry.bookType,
      title: entry.title,
      body_format: entry.bodyFormat,
      body: entry.body,
      order_key: entry.orderKey?.toString() ?? null,
      sync_id: book.syncId,
      revision: entry.revision,
      created_at: entry.createdAt.toISOString(),
      updated_at: entry.updatedAt.toISOString(),
      deleted_at: entry.deletedAt?.toISOString() ?? null,
      book_updated_at: book.updatedAt.toISOString(),
    };
  } catch (cause) {
    throw new Error('备忘录快照读取失败', { cause });
  }
}
