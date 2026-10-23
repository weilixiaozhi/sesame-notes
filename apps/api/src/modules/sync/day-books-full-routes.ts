import { SNAPSHOT_TRANSACTION_TIMEOUT_MS, TRANSACTION_WAIT_MS } from '../../shared/operation-budgets.js';
import { sendSnapshot, snapshotRows } from '../../shared/snapshot-stream.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { ApiError } from '../../shared/errors.js';
import { AnyUuidSchema, CursorSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { privateBookSnapshot } from '../private-books/index.js';
import { DayBookSchema, DayEventSchema, dayEventSnapshot } from '../days/index.js';
import { executeSync, fullSnapshotCursor } from './snapshot-support.js';
/** 注册 /api/v1/sync/day-books/full 的权限、协议与业务编排。 */
export function registerDayBooksFullRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/sync/day-books/full',
    {
      ...secured,
      schema: {
        tags: ['sync'],
        querystring: Type.Object({ day_book_id: AnyUuidSchema, sync_id: Type.Optional(UuidSchema) }),
        response: {
          200: Type.Object({
            day_book: Type.Ref(DayBookSchema),
            day_events: Type.Array(Type.Ref(DayEventSchema)),
            server_cursor: CursorSchema,
          }),
        },
      },
    },
    async (request, reply) =>
      executeSync(request, '读取日子本完整快照', async () => {
        const auth = requireAuth(request);
        const query = request.query as { day_book_id: string; sync_id?: string };
        return sendSnapshot(reply, config.storagePath, (writer) =>
          prisma.$transaction(
            async (tx) => {
              const book = await tx.dayBook.findFirst({
                where: { id: query.day_book_id, ownerId: auth.userId, deletedAt: null },
              });
              if (!book) throw new ApiError(404, 'DAY_BOOK_NOT_FOUND', '日子本不存在或已删除');
              if (query.sync_id !== undefined && query.sync_id !== book.syncId)
                throw new ApiError(412, 'SYNC_ID_MISMATCH', '日子本同步身份已失效，请重新连接');
              await writer.text('{"day_book":');
              await writer.value(privateBookSnapshot(book), reply.compileSerializationSchema(DayBookSchema));
              await writer.text(',"day_events":');
              const serialize = reply.compileSerializationSchema(DayEventSchema);
              await writer.array(
                snapshotRows((cursor, take) =>
                  tx.dayEvent.findMany({
                    where: { dayBookId: book.id, deletedAt: null },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    take,
                    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                  }),
                ),
                (row) => serialize(dayEventSnapshot(row, book.syncId)),
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
