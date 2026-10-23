import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { AmountSchema, AnyUuidSchema, CurrencySchema } from '../../shared/contracts/scalars.js';
import { decimalToCanonical } from '../../shared/decimal.js';
import { dateRange } from '../../shared/date-range.js';
import { execute } from '../../shared/execute.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { getLedgerReadAccess } from './domain/ledger-access.js';
import { TransactionQuerySchema, transactionQueryWhere, type TransactionQuery } from './transaction-query.js';

/** 在数据库中聚合完整筛选范围，统一以账本本币统计，原币分别展示且不跨币相加。 */
export function registerTransactionStatsRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.get(
    '/api/v1/ledgers/:ledger_id/transaction-stats',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['transactions'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        querystring: TransactionQuerySchema,
        response: {
          200: Type.Object({
            ledger_currency: CurrencySchema,
            expense_total: AmountSchema,
            transaction_count: Type.Integer({ minimum: 0 }),
            by_currency: Type.Array(
              Type.Object({
                currency_code: CurrencySchema,
                amount_total: AmountSchema,
                native_total: AmountSchema,
                transaction_count: Type.Integer({ minimum: 0 }),
              }),
            ),
            by_day: Type.Array(
              Type.Object({
                date: Type.String(),
                native_total: AmountSchema,
                transaction_count: Type.Integer({ minimum: 0 }),
              }),
            ),
            by_category: Type.Array(
              Type.Object({
                category_id: Type.Union([AnyUuidSchema, Type.Null()]),
                category_name: Type.Union([Type.String(), Type.Null()]),
                native_total: AmountSchema,
                transaction_count: Type.Integer({ minimum: 0 }),
              }),
            ),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '读取交易统计', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const query = request.query as TransactionQuery;
        const { start, end, timeZone } = dateRange(query);
        const where: Prisma.TransactionWhereInput = {
          ledgerId,
          deletedAt: null,
          txType: 'expense',
          ...transactionQueryWhere(query),
        };
        return prisma.$transaction(
          async (tx) => {
            const { ledger } = await getLedgerReadAccess(tx, auth.userId, ledgerId, 'editor');
            const [total, currencies, categories] = await Promise.all([
              tx.transaction.aggregate({ where, _sum: { nativeAmount: true }, _count: { _all: true } }),
              tx.transaction.groupBy({
                by: ['currencyCode'],
                where,
                _sum: { amount: true, nativeAmount: true },
                _count: { _all: true },
                orderBy: { currencyCode: 'asc' },
              }),
              tx.transaction.groupBy({
                by: ['categoryId', 'categoryName'],
                where,
                _sum: { nativeAmount: true },
                _count: { _all: true },
              }),
            ]);
            const days = await tx.$queryRaw<
              Array<{ date: string; native_total: Prisma.Decimal; transaction_count: bigint }>
            >(Prisma.sql`
              SELECT to_char(happened_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS date, SUM(native_amount) AS native_total, COUNT(*) AS transaction_count
              FROM transactions WHERE ledger_id=${ledgerId}::uuid AND deleted_at IS NULL AND tx_type='expense'
              ${start ? Prisma.sql`AND happened_at>=${start}` : Prisma.empty}
              ${end ? Prisma.sql`AND happened_at<${end}` : Prisma.empty}
              ${query.currency_code ? Prisma.sql`AND currency_code=${query.currency_code}` : Prisma.empty}
              ${query.category_id ? (query.category_id === 'uncategorized' ? Prisma.sql`AND category_id IS NULL` : Prisma.sql`AND category_id=${query.category_id}::uuid`) : Prisma.empty}
              ${query.payer_member_id ? Prisma.sql`AND payer_member_id=${query.payer_member_id}::uuid` : Prisma.empty}
              ${query.aa_mode === 0 ? Prisma.sql`AND (aa_mode IS NULL OR aa_mode=0)` : query.aa_mode !== undefined ? Prisma.sql`AND aa_mode=${query.aa_mode}` : Prisma.empty}
              GROUP BY date ORDER BY date`);
            categories.sort(
              (left, right) =>
                new Prisma.Decimal(right._sum.nativeAmount ?? 0).comparedTo(left._sum.nativeAmount ?? 0) ||
                (left.categoryId ?? '').localeCompare(right.categoryId ?? ''),
            );
            return {
              ledger_currency: ledger.currency,
              by_day: days.map((row) => ({
                date: row.date,
                native_total: decimalToCanonical(row.native_total),
                transaction_count: Number(row.transaction_count),
              })),
              expense_total: decimalToCanonical(total._sum.nativeAmount ?? 0),
              transaction_count: total._count._all,
              by_currency: currencies.map((row) => ({
                currency_code: row.currencyCode,
                amount_total: decimalToCanonical(row._sum.amount ?? 0),
                native_total: decimalToCanonical(row._sum.nativeAmount ?? 0),
                transaction_count: row._count._all,
              })),
              by_category: categories.map((row) => ({
                category_id: row.categoryId,
                category_name: row.categoryName,
                native_total: decimalToCanonical(row._sum.nativeAmount ?? 0),
                transaction_count: row._count._all,
              })),
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
}
