import { SNAPSHOT_TRANSACTION_TIMEOUT_MS, TRANSACTION_WAIT_MS } from '../../shared/operation-budgets.js';
import { sendSnapshot, snapshotRows } from '../../shared/snapshot-stream.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { ApiError } from '../../shared/errors.js';
import { AnyUuidSchema, CursorSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { MemoBookSchema, MemoEntrySchema, memoBookSnapshot, memoEntrySnapshot } from '../memos/index.js';
import { executeSync, fullSnapshotCursor } from './snapshot-support.js';
/** 注册 /api/v1/sync/memo-books/full 的权限、协议与业务编排。 */
export function registerMemoBooksFullRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/sync/memo-books/full',
    {
      ...secured,
      schema: {
        tags: ['sync'],
        querystring: Type.Object({ memo_book_id: AnyUuidSchema, sync_id: Type.Optional(UuidSchema) }),
        response: {
          200: Type.Object({
            memo_book: Type.Ref(MemoBookSchema),
            memo_entries: Type.Array(Type.Ref(MemoEntrySchema)),
            server_cursor: CursorSchema,
          }),
        },
      },
    },
    async (request, reply) =>
      executeSync(request, '读取备忘录本完整快照', async () => {
        const auth = requireAuth(request);
        const query = request.query as { memo_book_id: string; sync_id?: string };
        return sendSnapshot(reply, config.storagePath, (writer) =>
          prisma.$transaction(
            async (tx) => {
              const book = await tx.memoBook.findFirst({
                where: { id: query.memo_book_id, ownerId: auth.userId, deletedAt: null },
              });
              if (!book) throw new ApiError(404, 'MEMO_BOOK_NOT_FOUND', '备忘录本不存在或已删除');
              if (query.sync_id !== undefined && query.sync_id !== book.syncId)
                throw new ApiError(412, 'SYNC_ID_MISMATCH', '备忘录本同步身份已变化');
              await writer.text('{"memo_book":');
              await writer.value(memoBookSnapshot(book), reply.compileSerializationSchema(MemoBookSchema));
              await writer.text(',"memo_entries":');
              const serialize = reply.compileSerializationSchema(MemoEntrySchema);
              await writer.array(
                snapshotRows(
                  (cursor, take) =>
                    tx.memoEntry.findMany({
                      where: { memoBookId: book.id, deletedAt: null },
                      orderBy:
                        book.type === 'credentials'
                          ? [{ orderKey: 'asc' }, { id: 'asc' }]
                          : [{ createdAt: 'desc' }, { id: 'asc' }],
                      take,
                      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                    }),
                  16,
                ),
                (row) => serialize(memoEntrySnapshot(row, book)),
              );
              await writer.text(',"server_cursor":');
              await writer.value((await fullSnapshotCursor(tx, config)).toString());
              await writer.text('}');
            },
            {
              isolationLevel: 'RepeatableRead',
              maxWait: TRANSACTION_WAIT_MS,
              timeout: SNAPSHOT_TRANSACTION_TIMEOUT_MS,
            },
          ),
        );
      }),
  );
}
