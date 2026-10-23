import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { ApiError } from '../../shared/errors.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { CursorSchema, parseDatabaseCursor } from '../../shared/contracts/scalars.js';
import { visibleSyncChangeWhere } from './sync-version.js';
import { SyncChangeEnvelopeSchema } from './sync-schemas.js';
import { executeSync } from './snapshot-support.js';
import { requireSyncCutover } from '../../shared/sync-cutover.js';
/** 注册 /api/v1/sync/pull 的权限、协议与业务编排。 */
export function registerPullRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/sync/pull',
    {
      ...secured,
      schema: {
        tags: ['sync'],
        querystring: Type.Object({
          since: Type.Optional(CursorSchema),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
        }),
        response: {
          410: Type.Ref(ErrorSchema),
          200: Type.Object({
            changes: Type.Array(SyncChangeEnvelopeSchema),
            server_cursor: CursorSchema,
            has_more: Type.Boolean(),
          }),
        },
      },
    },
    async (request) =>
      executeSync(request, '拉取同步变更', async () => {
        const auth = requireAuth(request);
        const query = request.query as { since?: string; limit?: number };
        const since = parseDatabaseCursor(query.since ?? '0');
        // 切点前事件仅保留为历史和收据，当前协议通过完整快照重建各域水位。
        const cutoverCursor = await requireSyncCutover(prisma);
        if (since < cutoverCursor || since < BigInt(config.syncRetentionMinCursor)) {
          throw new ApiError(410, 'SYNC_CURSOR_EXPIRED', '同步游标已过期，请执行全量同步');
        }
        const limit = query.limit ?? 500;
        const rows = await prisma.syncChange.findMany({
          where: {
            changeId: { gt: since },
            ...visibleSyncChangeWhere(auth.userId),
          },
          orderBy: { changeId: 'asc' },
          take: limit + 1,
        });
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const serverCursor = page.at(-1)?.changeId ?? since;
        return {
          changes: page.map((row) => ({
            change_id: row.changeId.toString(),
            ledger_id: row.ledgerId,
            day_book_id: row.dayBookId,
            memo_book_id: row.memoBookId,
            fitness_space_id: row.fitnessSpaceId,
            entity_type: row.entityType,
            entity_id: row.entityId,
            action: row.action,
            mutation_id: row.mutationId,
            // 当前事件已由领域写入产生权威载荷，不用当前实体状态改写历史事实。
            payload: row.payload,
            updated_at: row.updatedAt.toISOString(),
            device_id: row.deviceId,
          })),
          server_cursor: serverCursor.toString(),
          has_more: hasMore,
        };
      }),
  );
}
