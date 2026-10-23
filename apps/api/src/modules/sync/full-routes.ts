import { SNAPSHOT_TRANSACTION_TIMEOUT_MS, TRANSACTION_WAIT_MS } from '../../shared/operation-budgets.js';
import { sendSnapshot } from '../../shared/snapshot-stream.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { ApiError } from '../../shared/errors.js';
import { AnyUuidSchema, CursorSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { getLedgerReadAccess } from '../accounting/index.js';
import {
  executeSync,
  ledgerSnapshotFields,
  snapshotCatalogs,
  ledgerSerializers,
  writeLedgerSnapshot,
  fullSnapshotCursor,
} from './snapshot-support.js';
/** 注册 /api/v1/sync/full 的权限、协议与业务编排。 */
export function registerFullRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/sync/full',
    {
      ...secured,
      schema: {
        tags: ['sync'],
        querystring: Type.Object({
          ledger_id: AnyUuidSchema,
          // 客户端当前绑定的同步身份：缺省=首次绑定（返回当前值）；不匹配=412 禁止静默覆盖
          sync_id: Type.Optional(UuidSchema),
          include_recurring_state: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({
            ...ledgerSnapshotFields,
            server_cursor: CursorSchema,
          }),
        },
      },
    },
    async (request, reply) =>
      executeSync(request, '构建全量同步快照', async () => {
        const auth = requireAuth(request);
        const {
          ledger_id: ledgerId,
          sync_id: clientSyncId,
          include_recurring_state: includeRecurringState,
        } = request.query as {
          ledger_id: string;
          sync_id?: string;
          include_recurring_state?: boolean;
        };
        return sendSnapshot(reply, config.storagePath, (writer) =>
          prisma.$transaction(
            async (tx) => {
              const member = await getLedgerReadAccess(tx, auth.userId, ledgerId, 'editor');
              // 同步身份校验：客户端声明的 sync_id 与云端当前时间线不一致时，快照属于
              // 另一条历史分支，直接返回会静默丢弃本地分支 → 412 由客户端进入 STALE_BINDING 决策
              if (clientSyncId !== undefined && clientSyncId !== member.ledger.syncId) {
                throw new ApiError(412, 'SYNC_ID_MISMATCH', '同步身份与云端当前时间线不一致，禁止静默覆盖', {
                  client_sync_id: clientSyncId,
                  current_sync_id: member.ledger.syncId,
                });
              }
              await writeLedgerSnapshot(
                writer,
                tx,
                member.ledger,
                auth.userId,
                ledgerSerializers(reply),
                snapshotCatalogs(tx, auth.userId),
                false,
                includeRecurringState === true,
              );
              await writer.text(',"server_cursor":');
              await writer.value((await fullSnapshotCursor(tx, config)).toString());
              await writer.text('}');
            },
            // PostgreSQL 默认 READ COMMITTED 会逐语句换快照，无法保证实体集合与游标一致。
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
