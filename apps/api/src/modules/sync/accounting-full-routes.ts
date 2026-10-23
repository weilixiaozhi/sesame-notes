import { SNAPSHOT_TRANSACTION_TIMEOUT_MS, TRANSACTION_WAIT_MS } from '../../shared/operation-budgets.js';
import { sendSnapshot } from '../../shared/snapshot-stream.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { CategorySchema, ExchangeRateOverrideSchema } from '../../shared/contracts/accounting.js';
import { AnyUuidSchema, CursorSchema } from '../../shared/contracts/scalars.js';
import { accessibleLedgerWhere } from '../accounting/index.js';
import {
  executeSync,
  ledgerSnapshotFields,
  snapshotCatalogs,
  ledgerSerializers,
  writeLedgerSnapshot,
  fullSnapshotCursor,
} from './snapshot-support.js';
/** 注册 /api/v1/sync/accounting/full 的权限、协议与业务编排。 */
export function registerAccountingFullRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.get(
    '/api/v1/sync/accounting/full',
    {
      ...secured,
      schema: {
        tags: ['sync'],
        querystring: Type.Object({ include_recurring_state: Type.Optional(Type.Boolean()) }),
        response: {
          200: Type.Object({
            ledger_snapshots: Type.Array(Type.Object(ledgerSnapshotFields)),
            categories: Type.Array(Type.Ref(CategorySchema)),
            exchange_rate_overrides: Type.Array(Type.Ref(ExchangeRateOverrideSchema)),
            category_tombstones: Type.Array(Type.Ref(CategorySchema)),
            deleted_exchange_rate_override_ids: Type.Array(AnyUuidSchema),
            server_cursor: CursorSchema,
          }),
        },
      },
    },
    async (request, reply) =>
      executeSync(request, '读取账号记账完整快照', async () => {
        const auth = requireAuth(request);
        const { include_recurring_state: includeRecurringState } = request.query as {
          include_recurring_state?: boolean;
        };
        return sendSnapshot(reply, config.storagePath, (writer) =>
          prisma.$transaction(
            async (tx) => {
              const ledgers = await tx.ledger.findMany({
                where: accessibleLedgerWhere(auth.userId),
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              });
              const catalogs = snapshotCatalogs(tx, auth.userId);
              // 本人及已授权账本的所有者共同构成分类墓碑读取范围。
              const categoryOwnerIds = [...new Set([auth.userId, ...ledgers.map((ledger) => ledger.ownerId)])];
              const codecs = ledgerSerializers(reply);
              await writer.text('{"ledger_snapshots":[');
              for (let i = 0; i < ledgers.length; i++) {
                if (i) await writer.text(',');
                await writeLedgerSnapshot(
                  writer,
                  tx,
                  ledgers[i]!,
                  auth.userId,
                  codecs,
                  catalogs,
                  true,
                  includeRecurringState === true,
                );
              }
              await writer.text(']');
              const [categories, rates, deletedCategories, deletedRates] = await Promise.all([
                catalogs.categories(auth.userId),
                catalogs.rates(),
                Promise.all(categoryOwnerIds.map((ownerId) => catalogs.categoryTombstones(ownerId))).then((rows) =>
                  rows.flat(),
                ),
                tx.exchangeRateOverride.findMany({
                  where: { ownerId: auth.userId, deletedAt: { not: null } },
                  select: { id: true },
                }),
              ]);
              await writer.text(',"categories":');
              await writer.array(categories, codecs.category);
              await writer.text(',"exchange_rate_overrides":');
              await writer.array(rates, codecs.rate);
              await writer.text(',"category_tombstones":');
              await writer.array(deletedCategories, codecs.category);
              await writer.text(',"deleted_exchange_rate_override_ids":');
              await writer.array(deletedRates.map((row) => row.id));
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
