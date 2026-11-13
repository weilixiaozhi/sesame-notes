import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { ANY_UUID_PATTERN, AnyUuidSchema, TimestampSchema, isStrictTimestamp } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { authenticate, currentSessionAccess, requireAuth, requireScopes } from '../auth/index.js';
import { getLedgerReadAccess } from './domain/ledger-access.js';

type HistoryScope = { ledger_id: string; transaction_id: string };
type HistoryQuery = { limit?: number; cursor?: string };
type BatchHistoryScope = { ledger_id: string; transaction_ids: string[] };
type BatchHistoryQuery = { transaction_ids: string; limit?: number; cursor?: string };
type HistoryCursor = { createdAt: Date; id: string };

const historySelect = {
  id: true,
  ledgerId: true,
  transactionId: true,
  version: true,
  operatorMemberId: true,
  operatorMember: { select: { displayName: true } },
  createdAt: true,
  changes: true,
} satisfies Prisma.TransactionEditHistorySelect;
type HistoryRow = Prisma.TransactionEditHistoryGetPayload<{ select: typeof historySelect }>;

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

/** 客户端约定逗号分隔的批量交易标识，单次最多 100 条，避免超长 URL 和单请求无界结果。 */
const MAX_BATCH_TRANSACTIONS = 100;
const BatchTransactionIdsSchema = Type.String({ minLength: 36, maxLength: 4096 });

/** 历史行统一映射为契约字段，单笔与批量读取共享同一返回形状。 */
function mapHistoryRow(row: HistoryRow) {
  return {
    id: row.id,
    transaction_id: row.transactionId,
    ledger_id: row.ledgerId,
    version: row.version,
    operator_member_id: row.operatorMemberId,
    operator_display_name: row.operatorMember?.displayName ?? null,
    created_at: row.createdAt.toISOString(),
    changes: row.changes,
  };
}

/** 将唯一的交易历史版本编码为不透明游标，归属信息阻止跨交易复用游标。 */
function encodeHistoryCursor(scope: HistoryScope, version: number): string {
  try {
    return Buffer.from(JSON.stringify({ v: 1, ...scope, before_version: version }), 'utf8').toString('base64url');
  } catch (cause) {
    throw new Error('交易历史游标生成失败', { cause });
  }
}

/** 批量历史游标摘要绑定账本与交易集合，不携带完整 UUID 列表以控制游标长度。 */
function batchScopeDigest(scope: BatchHistoryScope): string {
  return createHash('sha256')
    .update(`${scope.ledger_id}\n${scope.transaction_ids.join(',')}`)
    .digest('hex');
}

/** 批量游标使用服务端时间加历史行 id 作为稳定排序键，客户端只透传不解析。 */
function encodeBatchHistoryCursor(scope: BatchHistoryScope, cursor: HistoryCursor): string {
  try {
    return Buffer.from(
      JSON.stringify({
        v: 1,
        h: batchScopeDigest(scope),
        t: cursor.createdAt.toISOString(),
        i: cursor.id,
      }),
      'utf8',
    ).toString('base64url');
  } catch (cause) {
    throw new Error('批量交易历史游标生成失败', { cause });
  }
}

/** 校验批量游标归属、交易集合摘要和时间/行标识，任何不一致都拒绝继续分页。 */
function decodeBatchHistoryCursor(raw: string, scope: BatchHistoryScope): HistoryCursor {
  try {
    if (!/^[\w-]+$/.test(raw)) throw new Error('编码格式无效');
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw new Error('编码格式无效');
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      value.v !== 1 ||
      value.h !== batchScopeDigest(scope) ||
      typeof value.t !== 'string' ||
      !isStrictTimestamp(value.t) ||
      typeof value.i !== 'string' ||
      !new RegExp(ANY_UUID_PATTERN).test(value.i)
    ) {
      throw new Error('游标字段无效');
    }
    return { createdAt: new Date(value.t), id: value.i };
  } catch (cause) {
    throw new ApiError(400, 'INVALID_CURSOR', '历史记录游标无效，请重新加载', undefined, { cause });
  }
}

/** 批量交易标识必须是去重后的合法 UUID；排序后用于查询与游标摘要。 */
function parseBatchTransactionIds(value: string): string[] {
  try {
    const parts = value.split(',');
    if (parts.length < 1 || parts.length > MAX_BATCH_TRANSACTIONS) throw new Error('数量无效');
    const ids = new Set<string>();
    for (const part of parts) {
      if (!new RegExp(ANY_UUID_PATTERN).test(part) || ids.has(part)) throw new Error('标识无效');
      ids.add(part);
    }
    return [...ids].sort();
  } catch (cause) {
    throw new ApiError(400, 'INVALID_TRANSACTION_IDS', '交易编号列表无效', undefined, { cause });
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
              select: historySelect,
            });
            const more = rows.length > limit;
            const items = more ? rows.slice(0, limit) : rows;
            const last = items.at(-1);
            return {
              items: items.map(mapHistoryRow),
              next_cursor: more && last ? encodeHistoryCursor(scope, last.version) : null,
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );

  /** 批量读取同一账本内最多 100 笔交易的编辑历史，客户端按交易集合分页消费。 */
  app.get(
    '/api/v1/ledgers/:ledger_id/transactions/history',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['transactions'],
        operationId: 'getTransactionsEditHistory',
        description:
          '按事务编号批量读取账本内交易的服务端编辑历史，按发生时间倒序分页；changes 为当次提交的字段或动作。',
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        querystring: Type.Object({
          transaction_ids: BatchTransactionIdsSchema,
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
      execute(request, '批量读取交易编辑历史', async () => {
        const auth = requireAuth(request);
        const rawScope = request.params as { ledger_id: string };
        const ledgerId = rawScope.ledger_id.toLowerCase();
        const query = request.query as BatchHistoryQuery;
        const transactionIds = parseBatchTransactionIds(query.transaction_ids);
        const scope: BatchHistoryScope = { ledger_id: ledgerId, transaction_ids: transactionIds };
        const limit = query.limit ?? 100;
        reply.header('cache-control', 'no-store');
        return await prisma.$transaction(
          async (tx) => {
            // 会话、成员资格和历史内容在同一只读快照中判断，避免分次查询产生归属漂移。
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
            await getLedgerReadAccess(tx, auth.userId, ledgerId, 'editor');
            const before = query.cursor === undefined ? undefined : decodeBatchHistoryCursor(query.cursor, scope);
            const rows = await tx.transactionEditHistory.findMany({
              where: {
                ledgerId,
                transactionId: { in: transactionIds },
                ...(before === undefined
                  ? {}
                  : {
                      OR: [
                        { createdAt: { lt: before.createdAt } },
                        { createdAt: before.createdAt, id: { lt: before.id } },
                      ],
                    }),
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: limit + 1,
              select: historySelect,
            });
            const more = rows.length > limit;
            const items = more ? rows.slice(0, limit) : rows;
            const last = items.at(-1);
            return {
              items: items.map(mapHistoryRow),
              next_cursor:
                more && last ? encodeBatchHistoryCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
}
