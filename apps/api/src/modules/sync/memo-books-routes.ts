import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { CursorSchema } from '../../shared/contracts/scalars.js';
import { MemoBookSchema, memoBookSnapshot } from '../memos/index.js';
import { executeSync, fullSnapshotCursor } from './snapshot-support.js';
/** 注册 /api/v1/sync/memo-books 的权限、协议与业务编排。 */
export function registerMemoBooksRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/sync/memo-books',
    {
      ...secured,
      schema: {
        tags: ['sync'],
        response: {
          200: Type.Object({
            memo_books: Type.Array(
              Type.Object({ ...MemoBookSchema.properties, entry_count: Type.Integer({ minimum: 0 }) }),
            ),
            server_cursor: CursorSchema,
          }),
        },
      },
    },
    async (request) =>
      executeSync(request, '读取备忘录本目录', async () => {
        const auth = requireAuth(request);
        return prisma.$transaction(
          async (tx) => {
            const books = await tx.memoBook.findMany({
              where: { ownerId: auth.userId, deletedAt: null },
              orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
              include: { _count: { select: { entries: { where: { deletedAt: null } } } } },
            });
            return {
              memo_books: books.map((book) => ({ ...memoBookSnapshot(book), entry_count: book._count.entries })),
              server_cursor: (await fullSnapshotCursor(tx, config)).toString(),
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
}
