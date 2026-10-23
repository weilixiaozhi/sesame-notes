import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { CursorSchema } from '../../shared/contracts/scalars.js';
import { privateBookSnapshot } from '../private-books/index.js';
import { DayBookSchema } from '../days/index.js';
import { executeSync, fullSnapshotCursor } from './snapshot-support.js';
/** 注册 /api/v1/sync/day-books 的权限、协议与业务编排。 */
export function registerDayBooksRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/sync/day-books',
    {
      ...secured,
      schema: {
        tags: ['sync'],
        response: { 200: Type.Object({ day_books: Type.Array(Type.Ref(DayBookSchema)), server_cursor: CursorSchema }) },
      },
    },
    async (request) =>
      executeSync(request, '读取日子本目录', async () => {
        const auth = requireAuth(request);
        return prisma.$transaction(
          async (tx) => {
            const books = await tx.dayBook.findMany({
              where: { ownerId: auth.userId, deletedAt: null },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            });
            return {
              day_books: books.map((book) => privateBookSnapshot(book)),
              server_cursor: (await fullSnapshotCursor(tx, config)).toString(),
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
}
