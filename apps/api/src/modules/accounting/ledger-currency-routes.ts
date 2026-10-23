import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { LedgerSchema } from '../../shared/contracts/accounting.js';
import { AnyUuidSchema, CurrencySchema, RATE_PATTERN } from '../../shared/contracts/scalars.js';
import { decimalToCanonical } from '../../shared/decimal.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { findIdempotentReplay, storeIdempotentResult } from '../../shared/idempotency.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { createChange } from '../sync-events/index.js';
import { getLedgerWriteAccess } from './domain/ledger-access.js';
import { ledgerPayload, mapLedger } from './mappers.js';
import { recalculateCurrencyTransaction } from './ledger-currency-rules.js';
import { updateTransactionMutation } from './transaction-mutations.js';
import { nextLedgerTimestamp } from './ledger-mutations.js';

const InputSchema = Type.Object({
  currency: CurrencySchema,
  expected_currency: CurrencySchema,
  rates: Type.Record(CurrencySchema, Type.String({ pattern: RATE_PATTERN, maxLength: 39 }), { maxProperties: 300 }),
});
type CurrencyChangeResult = { ledger: ReturnType<typeof mapLedger>; updated_transactions: number };

/** 原子更换账本本币并重算交易和 AA 快照；幂等重试不重复换算或增加修订号。 */
export function registerLedgerCurrencyRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.post(
    '/api/v1/ledgers/:ledger_id/change-currency',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['ledgers'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }) }),
        body: InputSchema,
        response: {
          200: Type.Object({ ledger: Type.Ref(LedgerSchema), updated_transactions: Type.Integer({ minimum: 0 }) }),
        },
      },
    },
    async (request) =>
      execute(request, '更换账本币种', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as Static<typeof InputSchema>;
        const key = request.headers['idempotency-key'] as string;
        const hash = requestFingerprint({ operation: 'change-ledger-currency', ledgerId, body });
        const now = new Date();
        return withSyncTransaction(prisma, async (tx) => {
          // 取锁后重新确认会话，阻止排队请求使用已撤销设备或已停用账号继续写入。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          const replay = await findIdempotentReplay<CurrencyChangeResult>(tx, auth.userId, key, hash, now);
          if (replay) return replay;
          if (ledger.currency !== body.expected_currency)
            throw new ApiError(409, 'LEDGER_CURRENCY_CHANGED', '账本币种已被其他设备修改，请刷新后重试');
          // 元数据事件和交易重算使用锁后生成的同一时间，防止设备将明确换币误判为较旧更新。
          const updatedAt = nextLedgerTimestamp(ledger);
          const rows = await tx.transaction.findMany({
            where: { ledgerId, deletedAt: null },
            include: { splits: true },
            orderBy: { id: 'asc' },
          });
          const updates =
            ledger.currency === body.currency
              ? []
              : rows.map((row) => ({
                  row,
                  next: recalculateCurrencyTransaction(
                    {
                      amount: decimalToCanonical(row.amount),
                      nativeAmount: decimalToCanonical(row.nativeAmount),
                      currencyCode: row.currencyCode,
                      aaMode: row.aaMode as 0 | 1 | 2 | null,
                      payerMemberId: row.payerMemberId,
                      splits: row.splits.map((split) => ({
                        memberId: split.memberId,
                        amount: decimalToCanonical(split.amount),
                      })),
                    },
                    body.currency,
                    body.rates,
                  ),
                }));
          const updated =
            ledger.currency === body.currency
              ? ledger
              : await tx.ledger.update({
                  where: { id: ledgerId },
                  data: { currency: body.currency, updatedAt, updatedByDeviceId: auth.deviceId },
                });
          if (ledger.currency !== body.currency)
            await createChange(tx, auth, ledgerId, 'ledger', ledgerId, 'upsert', ledgerPayload(updated), updatedAt);
          let updatedTransactions = 0;
          for (const { row, next } of updates) {
            if (next.nativeAmount === decimalToCanonical(row.nativeAmount)) continue;
            const result = await updateTransactionMutation(tx, auth, {
              ledgerId,
              transactionId: row.id,
              baseRevision: row.revision,
              fields: { nativeAmount: next.nativeAmount },
              splits: next.splits,
              historyChanges: {
                operation: 'change-ledger-currency',
                previous_currency: ledger.currency,
                currency: body.currency,
                native_amount: next.nativeAmount,
              },
              updatedAt,
            });
            if (result.status !== 'applied')
              throw new ApiError(409, 'TRANSACTION_CONFLICT', '交易在换算期间发生变化，请刷新后重试');
            updatedTransactions += 1;
          }
          const count = await tx.ledgerMember.count({ where: { ledgerId, status: 'ACTIVE' } });
          const member = await tx.ledgerMember.findUnique({
            where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: auth.userId } },
          });
          const result: CurrencyChangeResult = {
            ledger: mapLedger(updated, 'owner', count, member),
            updated_transactions: updatedTransactions,
          };
          await storeIdempotentResult(tx, auth.userId, key, hash, result, now);
          return result;
        });
      }),
  );
}
