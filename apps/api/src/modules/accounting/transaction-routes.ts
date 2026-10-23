import { withSyncTransaction } from '../../shared/sync-transaction.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { findIdempotentReplay, storeIdempotentResult } from '../../shared/idempotency.js';
import { ApiError } from '../../shared/errors.js';
import { AnyUuidSchema } from '../../shared/contracts/scalars.js';
import { TransactionSchema, formatAaMode, parseAaMode } from '../../shared/contracts/accounting.js';
import { decimalToCanonical } from '../../shared/decimal.js';
import { execute } from '../../shared/execute.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { getLedgerReadAccess, getLedgerWriteAccess } from './domain/ledger-access.js';
import {
  resolveCategory,
  resolveRecurring,
  transactionData,
  TransactionInput,
  validateCurrencySnapshot,
  validateTransactionSource,
  type TransactionCreate,
} from './domain/transactions.js';
import { mapTransaction } from './mappers.js';
import { createTransactionMutation } from './transaction-creation.js';
import { resolvePayerMember, resolveSplitMembers } from './member-refs.js';
import {
  deleteTransactionMutation,
  updateTransactionMutation,
  type TransactionMutationResult,
} from './transaction-mutations.js';
import { decodeTransactionCursor, encodeTransactionCursor, type TransactionCursor } from '../../shared/pagination.js';

import { TransactionQuerySchema, transactionQueryWhere, type TransactionQuery } from './transaction-query.js';

const BaseRevisionSchema = Type.Integer({ minimum: 0 });

const TransactionPatchInput = Type.Object({
  ...Type.Partial(Type.Omit(TransactionInput, ['id', 'base_revision'])).properties,
  base_revision: BaseRevisionSchema,
});

type TransactionParams = { ledger_id: string; transaction_id: string };
type TransactionPatch = Partial<TransactionCreate> & { base_revision: number };

/** 注册账本级交易接口，所有写操作与同步事件在同一事务提交。 */
export function registerTransactionRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  app.get(
    '/api/v1/ledgers/:ledger_id/transactions',
    {
      ...secured,
      schema: {
        tags: ['transactions'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        querystring: Type.Object({
          ...TransactionQuerySchema.properties,
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          // 不透明游标：客户端只透传 next_cursor，不感知排序键细节
          cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        }),
        response: {
          200: Type.Object({
            items: Type.Array(Type.Ref(TransactionSchema)),
            next_cursor: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '读取交易', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        await getLedgerReadAccess(prisma, auth.userId, ledgerId, 'editor');
        const query = request.query as TransactionQuery & { limit?: number; cursor?: string };
        const limit = query.limit ?? 100;
        let cursor: TransactionCursor | null = null;
        if (query.cursor !== undefined) {
          try {
            cursor = decodeTransactionCursor(query.cursor);
          } catch {
            // 游标是版本化载荷，解码失败直接按无效输入拒绝；静默跳过会造成客户端漏同步
            throw new ApiError(400, 'INVALID_CURSOR', '游标无效或已损坏');
          }
        }
        // 复合键分页：先按 happenedAt 严格小于，再按同一时间戳内 id 小于，
        // 与 orderBy 顺序一致，保证同时间戳交易不重不漏
        const rows = await prisma.transaction.findMany({
          where: {
            ledgerId,
            deletedAt: null,
            ...transactionQueryWhere(query),
            ...(cursor
              ? {
                  OR: [
                    { happenedAt: { lt: cursor.happenedAt } },
                    { happenedAt: cursor.happenedAt, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ happenedAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          include: { splits: true },
        });
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1);
        return {
          items: items.map(mapTransaction),
          next_cursor: hasMore && last ? encodeTransactionCursor({ happenedAt: last.happenedAt, id: last.id }) : null,
        };
      }),
  );

  app.post(
    '/api/v1/ledgers/:ledger_id/transactions',
    {
      ...secured,
      schema: {
        tags: ['transactions'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        headers: Type.Object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 8, maxLength: 128 })) }),
        body: TransactionInput,
        response: { 200: Type.Ref(TransactionSchema), 201: Type.Ref(TransactionSchema) },
      },
    },
    async (request, reply) =>
      execute(request, '创建交易', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as TransactionCreate;
        const now = new Date();
        const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
        const requestHash = hashIdempotentRequest(ledgerId, body);
        const result = await withSyncTransaction(prisma, async (tx) => {
          // 写锁等待期间的会话撤销必须先于业务校验、幂等回执和任何领域写入生效。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'editor');
          if (idempotencyKey) {
            // 当前账本授权仍是重放前提；命中后返回首次成功结果，不重新解释后来变化的业务状态。
            const replayed = await findIdempotentReplay<ReturnType<typeof mapTransaction>>(
              tx,
              auth.userId,
              idempotencyKey,
              requestHash,
              now,
            );
            if (replayed) return { transaction: replayed, replayed: true };
          }
          validateCurrencySnapshot(ledger.currency, body);
          const category = await resolveCategory(tx, ledger.ownerId, body.category_id ?? null);
          await resolveRecurring(tx, ledgerId, body.recurring_id ?? null);
          // payer/splits 输入解析为账本级成员引用（同账本 FK 约束）；
          // payer 缺省 = 记账人（认证推导，不信任 payload）
          const payerMemberId = await resolvePayerMember(tx, ledgerId, auth.userId, body.payer_member_id);
          const splitMembers = await resolveSplitMembers(tx, ledgerId, body.splits ?? null);
          const created = await createTransactionMutation(tx, auth, {
            // payer 解析失败会抛业务错误，此处必然非空
            data: transactionData(ledgerId, ledger.ownerId, auth, body, category, now, payerMemberId!),
            splits: splitMembers,
          });
          const response = mapTransaction(created.transaction);
          if (idempotencyKey) await storeIdempotentResult(tx, auth.userId, idempotencyKey, requestHash, response, now);
          return { transaction: response, replayed: false };
        });
        await reply.status(result.replayed ? 200 : 201).send(result.transaction);
      }),
  );

  app.patch(
    '/api/v1/ledgers/:ledger_id/transactions/:transaction_id',
    {
      ...secured,
      schema: {
        tags: ['transactions'],
        params: Type.Object({ ledger_id: AnyUuidSchema, transaction_id: AnyUuidSchema }),
        body: TransactionPatchInput,
        response: { 200: Type.Ref(TransactionSchema) },
      },
    },
    async (request) =>
      execute(request, '更新交易', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId, transaction_id: transactionId } = request.params as TransactionParams;
        const body = request.body as TransactionPatch;
        const now = new Date();
        const result = await withSyncTransaction(prisma, async (tx) => {
          // 写锁等待期间的会话撤销必须先于业务校验、幂等回执和任何领域写入生效。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'editor');
          const current = await tx.transaction.findFirst({
            where: { id: transactionId, ledgerId, deletedAt: null },
            include: { splits: true },
          });
          if (!current) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '交易不存在');
          validateTransactionSource(current, body);
          const merged = mergeTransaction(current, body);
          // 校验最终完整状态：未提供的分摊沿用现有行，并与更新后的金额、模式共同校验。
          validateCurrencySnapshot(ledger.currency, merged);
          const category = await resolveCategory(tx, ledger.ownerId, merged.category_id);
          await resolveRecurring(tx, ledgerId, merged.recurring_id, current.recurringId);
          // payer 仅在显式提供时更新（缺省保持现状，避免清空）
          const payerMemberId =
            body.payer_member_id !== undefined
              ? await resolvePayerMember(
                  tx,
                  ledgerId,
                  auth.userId,
                  body.payer_member_id,
                  new Set(current.payerMemberId ? [current.payerMemberId] : []),
                )
              : current.payerMemberId;
          const splitMembers =
            body.splits !== undefined
              ? await resolveSplitMembers(
                  tx,
                  ledgerId,
                  body.splits ?? null,
                  new Set(current.splits.map((split) => split.memberId)),
                )
              : undefined;
          return await updateTransactionMutation(tx, auth, {
            ledgerId,
            transactionId,
            baseRevision: body.base_revision,
            fields: {
              txType: merged.tx_type,
              amount: merged.amount,
              happenedAt: new Date(merged.happened_at),
              note: merged.note,
              categoryId: merged.category_id,
              categoryName: category?.name ?? null,
              categoryKind: category?.kind ?? null,
              currencyCode: merged.currency_code,
              nativeAmount: merged.native_amount,
              recurringId: merged.recurring_id,
              payerMemberId,
              aaMode: parseAaMode(merged.aa_mode),
            },
            splits: splitMembers,
            historyChanges: body as Prisma.InputJsonValue,
            updatedAt: now,
          });
        });
        if (result.status !== 'applied') throwRestTransactionMutationFailure(result);
        return mapTransaction(result.transaction);
      }),
  );

  app.delete(
    '/api/v1/ledgers/:ledger_id/transactions/:transaction_id',
    {
      ...secured,
      schema: {
        tags: ['transactions'],
        params: Type.Object({ ledger_id: AnyUuidSchema, transaction_id: AnyUuidSchema }),
        body: Type.Object({ base_revision: BaseRevisionSchema }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) =>
      execute(request, '删除交易', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId, transaction_id: transactionId } = request.params as TransactionParams;
        const { base_revision: baseRevision } = request.body as { base_revision: number };
        const now = new Date();
        const result = await withSyncTransaction(prisma, async (tx) => {
          // 写锁等待期间的会话撤销必须先于业务校验、幂等回执和任何领域写入生效。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'editor');
          return deleteTransactionMutation(tx, auth, { ledgerId, transactionId, baseRevision, updatedAt: now });
        });
        if (result.status !== 'applied') throwRestTransactionMutationFailure(result);
        await reply.status(204).send();
      }),
  );
}

/** 把部分更新与当前交易及分摊行合并为完整输入，缺失字段保留现状，显式 null 保持清空语义。 */
function mergeTransaction(
  current: Prisma.TransactionGetPayload<{ include: { splits: true } }>,
  patch: Partial<TransactionCreate>,
): Required<Omit<TransactionCreate, 'id' | 'base_revision' | 'payer_member_id'>> {
  return {
    tx_type: patch.tx_type ?? current.txType,
    amount: patch.amount ?? decimalToCanonical(current.amount),
    happened_at: patch.happened_at ?? current.happenedAt.toISOString(),
    note: patch.note === undefined ? current.note : patch.note,
    category_id: patch.category_id === undefined ? current.categoryId : patch.category_id,
    currency_code: patch.currency_code ?? current.currencyCode,
    native_amount: patch.native_amount ?? decimalToCanonical(current.nativeAmount),
    recurring_id: patch.recurring_id === undefined ? current.recurringId : (patch.recurring_id?.toLowerCase() ?? null),
    occurrence_date: current.occurrenceDate,
    // 数据库中的模式与分摊转为输入契约形态，与创建和导入共用同一套完整校验。
    aa_mode: patch.aa_mode === undefined ? formatAaMode(current.aaMode) : patch.aa_mode,
    splits:
      patch.splits === undefined
        ? current.splits.map((split) => ({ member_id: split.memberId, amount: decimalToCanonical(split.amount) }))
        : patch.splits,
  };
}

/** 把 mutation core 的状态映射为 REST 错误，不泄露其他账本实体是否存在。 */
function throwRestTransactionMutationFailure(result: Exclude<TransactionMutationResult, { status: 'applied' }>): never {
  if (result.status === 'not_found' || result.status === 'deleted' || result.status === 'scope_conflict') {
    throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '交易不存在');
  }
  throw new ApiError(409, 'SYNC_CONFLICT', '交易已被他人修改，请基于最新版本重试', {
    current_revision: result.current?.revision ?? 0,
    current_deleted: result.current?.deletedAt != null,
  });
}

/** 对账本与规范 JSON 请求计算稳定哈希，用于判断幂等键是否被错误复用。 */
function hashIdempotentRequest(ledgerId: string, body: TransactionCreate): string {
  return requestFingerprint({ ledger_id: ledgerId, payload: body });
}
