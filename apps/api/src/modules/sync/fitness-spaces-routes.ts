import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { CursorSchema } from '../../shared/contracts/scalars.js';
import { privateBookSnapshot } from '../private-books/index.js';
import { FitnessSpaceSchema } from '../fitness/index.js';
import { executeSync, fullSnapshotCursor } from './snapshot-support.js';
/** 注册 /api/v1/sync/fitness-spaces 的权限、协议与业务编排。 */
export function registerFitnessSpacesRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/sync/fitness-spaces',
    {
      ...secured,
      schema: {
        operationId: 'getSyncFitnessSpaces',
        tags: ['sync'],
        response: {
          200: Type.Object({
            fitness_spaces: Type.Array(
              Type.Object({ ...FitnessSpaceSchema.properties, entity_count: Type.Integer({ minimum: 0 }) }),
            ),
            server_cursor: CursorSchema,
          }),
        },
      },
    },
    async (request) =>
      executeSync(request, '读取健身空间目录', async () => {
        const auth = requireAuth(request);
        return prisma.$transaction(
          async (tx) => {
            const spaces = await tx.fitnessSpace.findMany({
              where: { ownerId: auth.userId, deletedAt: null },
              orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
              include: { _count: { select: { entities: { where: { deletedAt: null } } } } },
            });
            return {
              fitness_spaces: spaces.map((space) => ({
                ...privateBookSnapshot(space),
                entity_count: space._count.entities,
              })),
              server_cursor: (await fullSnapshotCursor(tx, config)).toString(),
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
}
