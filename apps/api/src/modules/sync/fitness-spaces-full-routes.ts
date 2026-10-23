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
import { fitnessPayloadSchemas, fitnessSnapshot, FitnessSpaceSchema } from '../fitness/index.js';
import { executeSync, fullSnapshotCursor } from './snapshot-support.js';
/** 注册 /api/v1/sync/fitness-spaces/full 的权限、协议与业务编排。 */
export function registerFitnessSpacesFullRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  const fitnessSnapshotFields = Object.fromEntries(
    Object.entries(fitnessPayloadSchemas).map(([type, payload]) => [
      type === 'fitness_preferences' ? type : `${type}s`,
      Type.Array(
        Type.Object({
          ...payload.properties,
          id: AnyUuidSchema,
          fitness_space_id: AnyUuidSchema,
          sync_id: UuidSchema,
          revision: Type.Integer({ minimum: 1 }),
          deleted_at: Type.Union([Type.String(), Type.Null()]),
        }),
      ),
    ]),
  );

  app.get(
    '/api/v1/sync/fitness-spaces/full',
    {
      ...secured,
      schema: {
        operationId: 'getSyncFitnessSpacesFull',
        querystring: Type.Object({ fitness_space_id: AnyUuidSchema, sync_id: Type.Optional(UuidSchema) }),
        tags: ['sync'],
        response: {
          200: Type.Object({
            fitness_space: FitnessSpaceSchema,
            ...fitnessSnapshotFields,
            server_cursor: CursorSchema,
          }),
        },
      },
    },
    async (request, reply) =>
      executeSync(request, '读取健身完整快照', async () => {
        const auth = requireAuth(request);
        return sendSnapshot(reply, config.storagePath, (writer) =>
          prisma.$transaction(
            async (tx) => {
              const query = request.query as { fitness_space_id: string; sync_id?: string };
              const space = await tx.fitnessSpace.findFirst({
                where: { id: query.fitness_space_id, ownerId: auth.userId, deletedAt: null },
              });
              if (!space) throw new ApiError(404, 'FITNESS_SPACE_NOT_FOUND', '健身空间不存在或不可访问');
              if (query.sync_id !== undefined && query.sync_id !== space.syncId)
                throw new ApiError(412, 'SYNC_ID_MISMATCH', '健身空间同步身份已变化');
              await writer.text('{"fitness_space":');
              await writer.value(privateBookSnapshot(space), reply.compileSerializationSchema(FitnessSpaceSchema));
              for (const [key, schema] of Object.entries(fitnessSnapshotFields)) {
                const type = key === 'fitness_preferences' ? key : key.slice(0, -1);
                await writer.text(`,${JSON.stringify(key)}:`);
                const serialize = reply.compileSerializationSchema(schema.items);
                await writer.array(
                  snapshotRows(
                    (cursor, take) =>
                      tx.fitnessEntity.findMany({
                        where: { fitnessSpaceId: space.id, entityType: type },
                        orderBy: { id: 'asc' },
                        take,
                        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                      }),
                    16,
                  ),
                  (row) => serialize(fitnessSnapshot(row, space)),
                );
              }
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
