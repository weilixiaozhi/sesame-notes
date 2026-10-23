import { withSyncTransaction } from '../../shared/sync-transaction.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { ApiError } from '../../shared/errors.js';
import { AnyUuidSchema, UuidSchema, CurrencySchema } from '../../shared/contracts/scalars.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { execute } from '../../shared/execute.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { findIdempotentReplay, storeIdempotentResult } from '../../shared/idempotency.js';
import {
  CategoryInput,
  TransactionInput,
  categoryData,
  assertCategoryNameIdentity,
  categoryPayload,
  getLedgerWriteAccess,
  resolveCategory,
  resolveRecurring,
  resolvePayerMember,
  resolveSplitMembers,
  transactionData,
  createTransactionMutation,
  validateCurrencySnapshot,
  validateParentCategory,
  type CategoryCreate,
  type TransactionCreate,
} from '../accounting/index.js';
import { createChange } from '../sync-events/index.js';

const ImportGuardQuery = Type.Object({
  expected_sync_id: UuidSchema,
  expected_currency: CurrencySchema,
  require_unarchived: Type.Boolean(),
});
const ImportInput = Type.Object({
  categories: Type.Optional(Type.Array(CategoryInput, { maxItems: 100 })),
  transactions: Type.Optional(Type.Array(TransactionInput, { maxItems: 500 })),
});
const ImportResultSchema = Type.Object({
  imported_categories: Type.Integer({ minimum: 0 }),
  imported_transactions: Type.Integer({ minimum: 0 }),
});

type ImportGuard = {
  expected_sync_id: string;
  expected_currency: string;
  require_unarchived: boolean;
};
type ImportBody = {
  categories?: CategoryCreate[];
  transactions?: TransactionCreate[];
};
type ImportError = { entity: 'category' | 'transaction'; index: number; reason: string };

/** 注册批量导入接口：交易与分类整批原子写入，任一条目非法则整批回滚。 复用普通写接口的同一套校验函数（currency 快照、AA、分类归属、父子层级）， 避免导入路径与在线路径出现两套规则。 */
export function registerImportRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.post(
    '/api/v1/ledgers/:ledger_id/imports',
    {
      ...secured,
      schema: {
        tags: ['imports'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        headers: Type.Object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 8, maxLength: 128 })) }),
        body: ImportInput,
        querystring: ImportGuardQuery,
        response: {
          200: ImportResultSchema,
          201: ImportResultSchema,
          400: Type.Ref(ErrorSchema),
        },
      },
    },
    async (request, reply) =>
      execute(request, '批量导入', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as ImportBody;
        const now = new Date();
        const idempotencyKey = request.headers['idempotency-key'] as string | undefined;
        const guard = request.query as ImportGuard;
        const requestHash = hashImportRequest(ledgerId, { ...body, ...guard });
        const result = await withSyncTransaction(prisma, async (tx) => {
          // 入站鉴权不覆盖等锁期间的撤销，取锁后再次确认设备、账号和认证代次。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          // 分类属于 Owner 用户域；整批授权先于幂等处理与实体写入，纯交易仍允许 Editor 导入。
          const { ledger } = await getLedgerWriteAccess(
            tx,
            auth.userId,
            ledgerId,
            body.categories?.length ? 'owner' : 'editor',
          );
          if (idempotencyKey) {
            // 重放命中：直接返回首次成功导入的缓存计数，不重复写入实体与同步变更日志
            const replayed = await findIdempotentReplay<ImportCounts>(
              tx,
              auth.userId,
              idempotencyKey,
              requestHash,
              now,
            );
            if (replayed) return { counts: replayed, replayed: true };
          }
          if (guard.expected_sync_id !== ledger.syncId)
            throw new ApiError(409, 'IMPORT_LEDGER_CHANGED', '账本已重建，请重新预览');
          if (guard.expected_currency !== ledger.currency)
            throw new ApiError(409, 'IMPORT_CURRENCY_CHANGED', '账本币种已改变，请重新计算本币金额');
          if (guard.require_unarchived) {
            const member = await tx.ledgerMember.findUnique({
              where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: auth.userId } },
            });
            if (member?.archivedAt) throw new ApiError(409, 'IMPORT_LEDGER_ARCHIVED', '请先取消归档，再导入账本');
          }
          const errors: ImportError[] = [];
          let importedCategoryCount = 0;
          for (let i = 0; i < (body.categories ?? []).length; i++) {
            const item = body.categories![i]!;
            try {
              await validateParentCategory(tx, ledger.ownerId, item.parent_id ?? null, item.level);
              await assertCategoryNameIdentity(
                tx,
                ledger.ownerId,
                { ...item, parent_id: item.parent_id ?? null },
                { categoryId: item.id },
              );
              const category = await tx.category.create({
                data: categoryData(ledger.ownerId, auth.deviceId, item, now),
              });
              await createChange(
                tx,
                { ...auth, userId: category.ownerId },
                null,
                'category',
                category.id,
                'upsert',
                categoryPayload(category),
                now,
              );
              importedCategoryCount += 1;
            } catch (error) {
              if (!(error instanceof ApiError) || error.statusCode !== 400) throw error;
              errors.push({ entity: 'category', index: i, reason: error.message });
            }
          }
          let importedTransactionCount = 0;
          for (let i = 0; i < (body.transactions ?? []).length; i++) {
            const item = body.transactions![i]!;
            try {
              validateCurrencySnapshot(ledger.currency, item);
              const category = item.category_id ? await resolveCategory(tx, ledger.ownerId, item.category_id) : null;
              await resolveRecurring(tx, ledgerId, item.recurring_id ?? null);
              // payer/splits 解析为账本级 member 引用（同账本 FK 约束）；
              // payer 缺省 = 记账人（认证推导）
              const payerMemberId = await resolvePayerMember(tx, ledgerId, auth.userId, item.payer_member_id);
              const splitMembers = await resolveSplitMembers(tx, ledgerId, item.splits ?? null);
              await createTransactionMutation(tx, auth, {
                // payer 解析失败会抛业务错误，此处必然非空
                data: transactionData(ledgerId, ledger.ownerId, auth, item, category, now, payerMemberId!),
                splits: splitMembers,
              });
              importedTransactionCount += 1;
            } catch (error) {
              if (!(error instanceof ApiError) || error.statusCode !== 400) throw error;
              errors.push({ entity: 'transaction', index: i, reason: error.message });
            }
          }
          if (errors.length > 0) {
            throw new ApiError(400, 'IMPORT_VALIDATION_FAILED', '导入数据包含非法条目，整批已回滚', errors);
          }
          const counts: ImportCounts = {
            imported_categories: importedCategoryCount,
            imported_transactions: importedTransactionCount,
          };
          if (idempotencyKey) await storeIdempotentResult(tx, auth.userId, idempotencyKey, requestHash, counts, now);
          return { counts, replayed: false };
        });
        await reply.status(result.replayed ? 200 : 201).send(result.counts);
      }),
  );
}

/** 导入成功响应的计数载荷，幂等重放时原样返回。 */
type ImportCounts = { imported_categories: number; imported_transactions: number };

/** 对账本与规范 JSON 请求计算稳定哈希，用于判断幂等键是否被错误复用。 */
function hashImportRequest(ledgerId: string, body: ImportBody & ImportGuard): string {
  return requestFingerprint({ ledger_id: ledgerId, payload: body });
}
