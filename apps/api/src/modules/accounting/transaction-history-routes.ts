import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, TimestampSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { authenticate, currentSessionAccess, requireAuth, requireScopes } from '../auth/index.js';
import { getLedgerReadAccess } from './domain/ledger-access.js';

type HistoryScope = { ledger_id: string; transaction_id: string };
type HistoryQuery = { limit?: number; cursor?: string };

const HistoryItemSchema = Type.Object({
  id: AnyUuidSchema,
  transaction_id: AnyUuidSchema,
  ledger_id: AnyUuidSchema,
  version: Type.Integer({ minimum: 1 }),
  operator_member_id: Type.Union([AnyUuidSchema, Type.Null()]),
  operator_display_name: Type.Union([Type.String(), Type.Null()]),
  created_at: TimestampSchema,
  changes: Type.Unknown(),
});

/** 将唯一的交易历史版本编码为不透明游标，归属信息阻止跨交易复用游标。 */
function encodeHistoryCursor(scope: HistoryScope, version: number): string {
  try {
    return Buffer.from(JSON.stringify({ v: 1, ...scope, before_version: version }), 'utf8').toString('base64url');
  } catch (cause) {
    throw new Error('交易历史游标生成失败', { cause });
  }
}

/** 只接受当前资源的完整游标，损坏、未知版本或越界版本均明确拒绝。 */
function decodeHistoryCursor(cursor: string, scope: HistoryScope): number {
  try {
    if (!/^[\w-]+$/.test(cursor)) throw new Error('编码格式无效');
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error('编码格式无效');
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      value.v !== 1 ||
      value.ledger_id !== scope.ledger_id ||
      value.transaction_id !== scope.transaction_id ||
      !Number.isSafeInteger(value.before_version) ||
      (value.before_version as number) < 1 ||
      (value.before_version as number) > 2_147_483_647
    )
      throw new Error('游标字段无效');
    return value.before_version as number;
  } catch (cause) {
    throw new ApiError(400, 'INVALID_CURSOR', '历史记录游标无效，请重新加载', undefined, { cause });
  }
}

/** 按当前账本读权限分页查询真实编辑记录，记录内容保持提交时的 JSON 语义。 */
export function registerTransactionHistoryRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.get(
    '/api/v1/ledgers/:ledger_id/transactions/:transaction_id/history',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['transactions'],
        operationId: 'getTransactionEditHistory',
        description: '读取账本内交易的服务端编辑历史，按版本倒序分页；changes 为当次提交的字段或动作。',
        params: Type.Object({ ledger_id: AnyUuidSchema, transaction_id: AnyUuidSchema }),
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
          cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        }),
        response: {
          200: Type.Object({
            items: Type.Array(HistoryItemSchema),
            next_cursor: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
          }),
        },
      },
    },
    async (request, reply) =>
      execute(request, '读取交易编辑历史', async () => {
        const auth = requireAuth(request);
        const rawScope = request.params as HistoryScope;
        const scope = {
          ledger_id: rawScope.ledger_id.toLowerCase(),
          transaction_id: rawScope.transaction_id.toLowerCase(),
        };
        const query = request.query as HistoryQuery;
        const limit = query.limit ?? 50;
        reply.header('cache-control', 'no-store');
        return await prisma.$transaction(
          async (tx) => {
            // 会话、成员资格和历史内容在同一个只读快照中判断，避免分次查询产生归属漂移。
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
            await getLedgerReadAccess(tx, auth.userId, scope.ledger_id, 'editor');
            const transaction = await tx.transaction.findFirst({
              where: { id: scope.transaction_id, ledgerId: scope.ledger_id },
              select: { id: true },
            });
            if (!transaction) throw new ApiError(404, 'TRANSACTION_NOT_FOUND', '交易不存在');
            const before = query.cursor === undefined ? undefined : decodeHistoryCursor(query.cursor, scope);
            // 历史版本在同一交易内唯一且只追加；严格小于上一页末版本，新增编辑不会挤出后续页。
            const rows = await tx.transactionEditHistory.findMany({
              where: {
                ledgerId: scope.ledger_id,
                transactionId: scope.transaction_id,
                ...(before === undefined ? {} : { version: { lt: before } }),
              },
              orderBy: { version: 'desc' },
              take: limit + 1,
              select: {
                id: true,
                ledgerId: true,
                transactionId: true,
                version: true,
                operatorMemberId: true,
                operatorMember: { select: { displayName: true } },
                createdAt: true,
                changes: true,
              },
            });
            const more = rows.length > limit;
            const items = more ? rows.slice(0, limit) : rows;
            const last = items.at(-1);
            return {
              items: items.map((row) => ({
                id: row.id,
                transaction_id: row.transactionId,
                ledger_id: row.ledgerId,
                version: row.version,
                operator_member_id: row.operatorMemberId,
                operator_display_name: row.operatorMember?.displayName ?? null,
                created_at: row.createdAt.toISOString(),
                changes: row.changes,
              })),
              next_cursor: more && last ? encodeHistoryCursor(scope, last.version) : null,
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
}
