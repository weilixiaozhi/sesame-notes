import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { findIdempotentReplay, storeIdempotentResult } from '../../shared/idempotency.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { uuidV5 } from '../../shared/uuid.js';
import { authenticate, currentSessionAccess, requireAuth, requireScopes } from '../auth/index.js';
import { getLedgerWriteAccess } from './domain/ledger-access.js';
import { ledgerActionPreview } from './ledger-action-preview.js';
import { deleteTransactionMutation } from './transaction-mutations.js';

const ClearInput = Type.Object(
  {
    mutation_id: UuidSchema,
    expected_sync_id: UuidSchema,
    expected_fingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
);
const ClearResult = Type.Object({
  deleted_count: Type.Integer({ minimum: 0 }),
  sync_id: UuidSchema,
  replayed: Type.Boolean(),
});
type ClearRequest = Static<typeof ClearInput>;
type ClearReceipt = Static<typeof ClearResult>;

/** 复用手机端清空语义：仅软删除当前活跃交易，保留周期规则、分类、成员和同步代次。 */
export function registerLedgerClearRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.post(
    '/api/v1/ledgers/:ledger_id/clear',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['ledgers'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        body: ClearInput,
        response: { 200: ClearResult },
      },
    },
    async (request) =>
      execute(request, '清空账本交易', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as ClearRequest;
        const now = new Date();
        return withSyncTransaction(prisma, async (tx) => {
          // 等待写入锁期间可能被撤销会话，不能使用进入路由前的鉴权结果。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          if (ledger.syncId !== body.expected_sync_id)
            throw new ApiError(412, 'SYNC_ID_MISMATCH', '账本同步身份已变化，请重新载入');
          const member = await tx.ledgerMember.findUnique({
            where: { ledgerId_linkedAccountId: { ledgerId, linkedAccountId: auth.userId } },
            select: { archivedAt: true },
          });
          if (member?.archivedAt) throw new ApiError(409, 'LEDGER_ARCHIVED', '请先恢复已归档账本，再清空交易');
          const key = `ledger-clear:${ledgerId}:${body.mutation_id}`;
          const hash = requestFingerprint({ ledger_id: ledgerId, ...body });
          const replay = await findIdempotentReplay<ClearReceipt>(tx, auth.userId, key, hash, now);
          // 已完成请求优先重放；响应丢失后的重试不能删除随后新增的交易。
          if (replay) return { ...replay, replayed: true };
          const preview = await ledgerActionPreview(tx, ledger);
          if (preview.fingerprint !== body.expected_fingerprint)
            throw new ApiError(409, 'LEDGER_PREVIEW_CHANGED', '账本内容已变化，请重新核对清空范围');
          const transactions = await tx.transaction.findMany({
            where: { ledgerId, deletedAt: null },
            select: { id: true, revision: true },
            orderBy: { id: 'asc' },
          });
          for (const transaction of transactions) {
            const result = await deleteTransactionMutation(tx, auth, {
              ledgerId,
              transactionId: transaction.id,
              baseRevision: transaction.revision,
              updatedAt: now,
              mutationId: uuidV5(body.mutation_id, `ledger-clear:${ledgerId}:${transaction.id}`),
              requestHash: hash,
            });
            if (result.status !== 'applied')
              throw new ApiError(409, 'LEDGER_PREVIEW_CHANGED', '清空期间交易已变化，本次操作未写入');
          }
          const result: ClearReceipt = { deleted_count: transactions.length, sync_id: ledger.syncId, replayed: false };
          // 长效回执保证同一清空确认只执行一次，响应丢失后的重试也能返回首次结果。
          await storeIdempotentResult(tx, auth.userId, key, hash, result, now, new Date('9999-12-31T23:59:59.999Z'));
          return result;
        });
      }),
  );
}
