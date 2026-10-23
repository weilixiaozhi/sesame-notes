import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { RecurringTransactionSchema } from '../../shared/contracts/accounting.js';
import {
  AnyUuidSchema,
  ANY_UUID_PATTERN,
  CurrencySchema,
  RATE_PATTERN,
  TimestampSchema,
  UuidSchema,
} from '../../shared/contracts/scalars.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { decimalToCanonical } from '../../shared/decimal.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { findIdempotentReplay, storeIdempotentResult } from '../../shared/idempotency.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { authenticate, currentSessionAccess, requireAuth, requireScopes } from '../auth/index.js';
import { createChange } from '../sync-events/index.js';
import { getLedgerReadAccess, getLedgerWriteAccess } from './domain/ledger-access.js';
import { recalculateCurrencyTransaction } from './ledger-currency-rules.js';
import { createdByMemberIdFor } from './member-refs.js';
import { mapRecurring } from './mappers.js';
import { createTransactionMutation } from './transaction-creation.js';
import {
  nextRecurringDate,
  recurringOccurrenceId,
  recurringOccurrenceInstant,
  recurringToday,
} from './recurring-schedule.js';

const GenerateInput = Type.Object(
  {
    mutation_id: UuidSchema,
    expected_sync_id: UuidSchema,
    expected_currency: CurrencySchema,
    rates: Type.Optional(
      Type.Record(CurrencySchema, Type.String({ pattern: RATE_PATTERN, maxLength: 39 }), { maxProperties: 300 }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);
type GenerateResult = {
  generated_count: number;
  skipped_count: number;
  has_more: boolean;
  rule_cursors: Array<{ id: string; last_generated_date: string | null }>;
  replayed: boolean;
};

/** 注册周期规则分页及原子补齐入口；每条发生、游标与事件使用同一同步提交事务。 */
export function registerRecurringRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  app.get(
    '/api/v1/ledgers/:ledger_id/recurring-transactions',
    {
      ...secured,
      schema: {
        tags: ['transactions'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
          sync_id: Type.Optional(UuidSchema),
        }),
        response: {
          412: Type.Ref(ErrorSchema),
          200: Type.Object({
            items: Type.Array(Type.Ref(RecurringTransactionSchema)),
            next_cursor: Type.Union([Type.String(), Type.Null()]),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '读取周期账单', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const query = request.query as { limit?: number; cursor?: string; sync_id?: string };
        return prisma.$transaction(
          async (tx) => {
            const { ledger } = await getLedgerReadAccess(tx, auth.userId, ledgerId, 'editor');
            if (query.sync_id !== undefined && query.sync_id !== ledger.syncId)
              throw new ApiError(412, 'SYNC_ID_MISMATCH', '账本同步身份已改变，请刷新');
            let cursor: string | undefined;
            if (query.cursor) {
              try {
                cursor = Buffer.from(query.cursor, 'base64url').toString();
                if (!new RegExp(ANY_UUID_PATTERN).test(cursor)) throw new Error('cursor');
              } catch {
                throw new ApiError(400, 'INVALID_CURSOR', '周期账单分页游标无效');
              }
            }
            const limit = query.limit ?? 100;
            const rows = await tx.recurringTransaction.findMany({
              where: { ledgerId, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
              orderBy: { id: 'asc' },
              take: limit + 1,
            });
            const items = rows.slice(0, limit);
            return {
              items: items.map(mapRecurring),
              next_cursor: rows.length > limit ? Buffer.from(items.at(-1)!.id).toString('base64url') : null,
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );

  app.post(
    '/api/v1/ledgers/:ledger_id/recurring-transactions/generate-due',
    {
      ...secured,
      schema: {
        tags: ['accounting'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        body: GenerateInput,
        response: {
          200: Type.Object({
            generated_count: Type.Integer({ minimum: 0 }),
            skipped_count: Type.Integer({ minimum: 0 }),
            has_more: Type.Boolean(),
            rule_cursors: Type.Array(
              Type.Object({ id: AnyUuidSchema, last_generated_date: Type.Union([TimestampSchema, Type.Null()]) }),
            ),
            replayed: Type.Boolean(),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '生成到期周期账单', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as Static<typeof GenerateInput>;
        const now = new Date();
        const key = `recurring-generate:${body.mutation_id}`;
        const hash = requestFingerprint({ ledgerId, body });
        return withSyncTransaction(prisma, async (tx) => {
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'editor');
          if (ledger.syncId !== body.expected_sync_id)
            throw new ApiError(409, 'SYNC_ID_MISMATCH', '账本同步身份已改变，请刷新');
          if (ledger.currency !== body.expected_currency)
            throw new ApiError(409, 'LEDGER_CURRENCY_CHANGED', '账本币种已改变，请刷新');
          const replay = await findIdempotentReplay<GenerateResult>(tx, auth.userId, key, hash, now);
          if (replay) return { ...replay, replayed: true };
          const rules = await tx.recurringTransaction.findMany({
            where: { ledgerId, deletedAt: null, enabled: true },
            orderBy: { id: 'asc' },
          });
          const result: GenerateResult = {
            generated_count: 0,
            skipped_count: 0,
            has_more: false,
            rule_cursors: [],
            replayed: false,
          };
          let remaining = body.limit ?? 200;
          const author = createdByMemberIdFor(ledgerId, auth.userId);
          for (const rule of rules) {
            const today = recurringToday(rule.timeZone, now);
            let date = nextRecurringDate(rule, today);
            let changed = false;
            while (date && remaining > 0) {
              const dateKey = date.toISOString().slice(0, 10);
              const id = recurringOccurrenceId(ledgerId, rule.id, dateKey);
              const existing = await tx.transaction.findUnique({ where: { id } });
              if (existing) {
                if (
                  existing.ledgerId !== ledgerId ||
                  existing.recurringId !== rule.id ||
                  existing.occurrenceDate !== dateKey
                )
                  throw new ApiError(409, 'RECURRING_OCCURRENCE_CONFLICT', '周期发生身份已被其他记录使用');
                result.skipped_count += 1;
              } else {
                const amount = decimalToCanonical(rule.amount);
                const nativeAmount = recalculateCurrencyTransaction(
                  {
                    amount,
                    nativeAmount: amount,
                    currencyCode: rule.currencyCode,
                    aaMode: null,
                    payerMemberId: author,
                    splits: [],
                  },
                  ledger.currency,
                  body.rates ?? {},
                ).nativeAmount;
                const category = rule.categoryId
                  ? await tx.category.findFirst({
                      where: { id: rule.categoryId, ownerId: ledger.ownerId, deletedAt: null },
                    })
                  : null;
                if (rule.categoryId && !category)
                  throw new ApiError(400, 'INVALID_CATEGORY', '周期账单分类已不存在，请先修改规则');
                await createTransactionMutation(tx, auth, {
                  data: {
                    id,
                    ledgerId,
                    ownerId: ledger.ownerId,
                    txType: 'expense',
                    amount,
                    nativeAmount,
                    currencyCode: rule.currencyCode,
                    happenedAt: recurringOccurrenceInstant(date, rule.timeZone),
                    note: rule.note,
                    categoryId: rule.categoryId,
                    categoryName: category?.name ?? null,
                    categoryKind: category?.kind ?? null,
                    recurringId: rule.id,
                    occurrenceDate: dateKey,
                    payerMemberId: author,
                    createdByMemberId: author,
                    lastEditedByMemberId: author,
                    updatedAt: now,
                    updatedByDeviceId: auth.deviceId,
                  },
                  splits: null,
                });
                result.generated_count += 1;
              }
              rule.lastGeneratedDate = date;
              changed = true;
              remaining -= 1;
              date = nextRecurringDate(rule, today);
            }
            if (date) result.has_more = true;
            if (changed) {
              // 生成进度只更新权威游标，规则编辑时间保持不变，避免干扰元数据的并发比较。
              const row = await tx.recurringTransaction.update({
                where: { id: rule.id },
                data: { lastGeneratedDate: rule.lastGeneratedDate, updatedAt: rule.updatedAt },
              });
              await createChange(
                tx,
                auth,
                ledgerId,
                'recurring_transaction',
                rule.id,
                'upsert',
                mapRecurring(row),
                row.updatedAt,
              );
            }
            result.rule_cursors.push({
              id: rule.id,
              last_generated_date: rule.lastGeneratedDate?.toISOString() ?? null,
            });
          }
          await storeIdempotentResult(tx, auth.userId, key, hash, result, now);
          return result;
        });
      }),
  );
}
