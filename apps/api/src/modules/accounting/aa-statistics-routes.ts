import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, CurrencySchema } from '../../shared/contracts/scalars.js';
import { decimalToCanonical } from '../../shared/decimal.js';
import { execute } from '../../shared/execute.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { getLedgerReadAccess } from './domain/ledger-access.js';
import { aaStatistics } from './aa-statistics.js';

/** 根据整个账本的实际付款和分摊规则计算 AA 结算。 */
export function registerAaStatisticsRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const money = Type.String({ pattern: '^-?\\d+(?:\\.\\d+)?$' });
  const count = Type.Integer({ minimum: 0 });
  app.get(
    '/api/v1/ledgers/:ledger_id/aa-stats',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['transactions'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        response: {
          200: Type.Object({
            ledger_currency: CurrencySchema,
            aa_enabled: Type.Boolean(),
            transaction_count: count,
            excluded_count: count,
            skipped_count: count,
            participants: Type.Array(
              Type.Object({
                member_id: AnyUuidSchema,
                display_name: Type.String(),
                is_self: Type.Boolean(),
                total_paid: money,
                total_should_pay: money,
                net: money,
                non_split_paid: money,
              }),
            ),
            transfers: Type.Array(
              Type.Object({
                from_member_id: AnyUuidSchema,
                to_member_id: AnyUuidSchema,
                amount: money,
                exact_amount: money,
              }),
            ),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '读取完整 AA 结算', async () => {
        const { userId } = requireAuth(request);
        const { ledger_id: id } = request.params as { ledger_id: string };
        return prisma.$transaction(
          async (tx) => {
            const { ledger } = await getLedgerReadAccess(tx, userId, id, 'editor');
            if (!ledger.aaEnabled)
              return { ledger_currency: ledger.currency, aa_enabled: false, ...aaStatistics([], [], userId) };
            const members = await tx.ledgerMember.findMany({
              where: { ledgerId: id },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            });
            const rows = await tx.transaction.findMany({
              where: { ledgerId: id, deletedAt: null },
              include: { splits: true },
              orderBy: [{ happenedAt: 'desc' }, { id: 'desc' }],
            });
            return {
              ledger_currency: ledger.currency,
              aa_enabled: true,
              ...aaStatistics(
                members,
                rows.map((row) => ({
                  ...row,
                  nativeAmount: decimalToCanonical(row.nativeAmount),
                  splits: row.splits.map((split) => ({
                    memberId: split.memberId,
                    amount: decimalToCanonical(split.amount),
                  })),
                })),
                userId,
              ),
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
}
