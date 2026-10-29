import {
  guardCategoryWrite,
  nextCategoryTimestamp,
  normalizeCategoryDraft,
  officialCategoryIdentity,
} from './category-conflict-service.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, TimestampSchema } from '../../shared/contracts/scalars.js';
import { CategorySchema } from '../../shared/contracts/accounting.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { findIdempotentReplay, storeIdempotentResult } from '../../shared/idempotency.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { createChange } from '../sync-events/index.js';
import { getLedgerReadAccess, getLedgerWriteAccess } from './domain/ledger-access.js';
import { CategoryInput, categoryData, validateParentCategory } from './domain/categories.js';
import { ensureDefaultCategories } from './default-categories.js';
import { categoryPayload, ledgerPayload, mapCategory } from './mappers.js';
import { deleteTransactionMutation, updateTransactionMutation } from './transaction-mutations.js';
import { updateCategoryTransactionSnapshots } from './category-snapshot.js';

const ids = Type.Array(AnyUuidSchema, { minItems: 1, maxItems: 500, uniqueItems: true });
const PreviewInput = Type.Object({ category_ids: ids });
const RemoveInput = Type.Object({
  category_ids: ids,
  mode: Type.Union([Type.Literal('migrate'), Type.Literal('delete'), Type.Literal('promote')]),
  target_category_id: Type.Optional(AnyUuidSchema),
  expected_target_updated_at: Type.Optional(TimestampSchema),
  preview_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
});
const ReorderInput = Type.Object({
  items: Type.Array(
    Type.Object({
      id: AnyUuidSchema,
      sort_order: Type.Integer({ minimum: -2147483648, maximum: 2147483647 }),
      expected_updated_at: TimestampSchema,
    }),
    { minItems: 1, maxItems: 500 },
  ),
});
const count = Type.Integer({ minimum: 0 });
const BatchInput = Type.Union([
  Type.Object(
    {
      items: Type.Array(CategoryInput, { minItems: 1, maxItems: 500 }),
      initialize_defaults: Type.Optional(Type.Literal(false)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { items: Type.Array(CategoryInput, { maxItems: 0 }), initialize_defaults: Type.Literal(true) },
    { additionalProperties: false },
  ),
]);
const ResultSchema = Type.Object({
  removed_categories: count,
  promoted_categories: count,
  affected_transactions: count,
  affected_recurring_rules: count,
});
type RemovalResult = Static<typeof ResultSchema>;

/** 同一快照列出分类树及所有关联版本，确认后任何并行修改都会使预览失效。 */
async function removalScope(tx: Prisma.TransactionClient, ownerId: string, categoryIds: string[]) {
  const roots = await tx.category.findMany({
    where: { ownerId, id: { in: categoryIds }, deletedAt: null },
    orderBy: { id: 'asc' },
  });
  if (roots.length !== categoryIds.length)
    throw new ApiError(404, 'CATEGORY_NOT_FOUND', '选中的分类已不存在或无权访问');
  const categories = await tx.category.findMany({
    where: { ownerId, deletedAt: null, OR: [{ id: { in: categoryIds } }, { parentId: { in: categoryIds } }] },
    orderBy: { id: 'asc' },
  });
  const categoryIdsWithChildren = categories.map((row) => row.id);
  const transactions = await tx.transaction.findMany({
    where: { ownerId, categoryId: { in: categoryIdsWithChildren }, deletedAt: null, ledger: { deletedAt: null } },
    select: { id: true, ledgerId: true, categoryId: true, revision: true, updatedAt: true },
    orderBy: { id: 'asc' },
  });
  const rules = await tx.recurringTransaction.findMany({
    where: { categoryId: { in: categoryIdsWithChildren }, deletedAt: null, ledger: { ownerId, deletedAt: null } },
    orderBy: { id: 'asc' },
  });
  const token = requestFingerprint({
    roots: [...categoryIds].sort(),
    categories: categories.map((row) => ({ id: row.id, parent: row.parentId, updated: row.updatedAt.toISOString() })),
    transactions: transactions.map(({ id, ledgerId, categoryId, revision }) => ({
      id,
      ledgerId,
      categoryId,
      revision,
    })),
    rules: rules.map((row) => ({ id: row.id, category: row.categoryId, updated: row.updatedAt.toISOString() })),
  });
  return { roots, categories, transactions, rules, token };
}

/** 分类属于所有者账号；排序和跨账本分类迁移均以原子同步事务执行。 */
export function registerCategoryActionRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  const params = Type.Object({ ledger_id: AnyUuidSchema });
  app.post(
    '/api/v1/ledgers/:ledger_id/categories/add-batch',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params,
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }) }),
        body: BatchInput,
        response: { 200: Type.Array(Type.Ref(CategorySchema)), 409: Type.Ref(ErrorSchema) },
      },
    },
    async (request) =>
      execute(request, '添加分类模板', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as Static<typeof BatchInput>;
        if (body.initialize_defaults ? body.items.length > 0 : body.items.length === 0)
          throw new ApiError(400, 'CATEGORY_BATCH_INVALID', '初始化默认分类需提交空列表，普通添加需至少一个分类');
        const key = request.headers['idempotency-key'] as string;
        const hash = requestFingerprint({ operation: 'category-add-batch', ledgerId, body });
        const now = new Date();
        const result = await withSyncTransaction(prisma, async (tx) => {
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          const replay = await findIdempotentReplay<Array<ReturnType<typeof mapCategory>> | { conflict_ids: string[] }>(
            tx,
            auth.userId,
            key,
            hash,
            now,
          );
          if (replay) return replay;
          if (body.initialize_defaults) {
            await ensureDefaultCategories(tx, auth);
            const rows = await tx.category.findMany({
              where: { ownerId: ledger.ownerId, deletedAt: null },
              orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
            });
            const initialized = rows.map(mapCategory);
            await storeIdempotentResult(tx, auth.userId, key, hash, initialized, now);
            return initialized;
          }
          const itemIds = body.items.flatMap((item) => (item.id ? [item.id.toLowerCase()] : []));
          if (new Set(itemIds).size !== itemIds.length)
            throw new ApiError(400, 'DUPLICATE_CATEGORY', '模板请求包含重复分类身份');
          // 先做完整标量校验，再保存候选；存在候选时整个请求不创建任何可见分类。
          const drafts = body.items.map((item) => ({
            item,
            draft: normalizeCategoryDraft({ ...item }, item.id ?? ''),
          }));
          const conflicts: string[] = [];
          const retained = new Map<string, ReturnType<typeof mapCategory>>();
          for (const { item, draft } of drafts) {
            if (!item.id || !officialCategoryIdentity(item.id)) continue;
            const current = await tx.category.findFirst({ where: { id: item.id, ownerId: ledger.ownerId } });
            if (!current) continue;
            // 命令已有稳定幂等键，每个固定身份从同一命令确定性派生来源 mutation。
            const seed = requestFingerprint({ operation: 'category-template-candidate', key, id: current.id });
            const mutationId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
            const guard = await guardCategoryWrite(
              tx,
              auth,
              { mutation_id: mutationId, entity_id: current.id, action: 'upsert', payload: draft },
              current,
              draft,
              requestFingerprint({ command: hash, category_id: current.id }),
              now,
            );
            if (guard.kind === 'conflict') conflicts.push(guard.candidate.id);
            else if (guard.kind === 'accepted') retained.set(current.id, guard.state);
          }
          if (conflicts.length) {
            const pending = { conflict_ids: conflicts };
            await storeIdempotentResult(tx, auth.userId, key, hash, pending, now);
            return pending;
          }
          const created = [];
          for (const { item } of drafts) {
            if (item.id && retained.has(item.id.toLowerCase())) {
              created.push(retained.get(item.id.toLowerCase())!);
              continue;
            }
            await validateParentCategory(tx, ledger.ownerId, item.parent_id ?? null, item.level, item.id);
            const existing = item.id
              ? await tx.category.findFirst({ where: { ownerId: ledger.ownerId, id: item.id } })
              : null;
            if (existing) throw new ApiError(409, 'CATEGORY_ALREADY_EXISTS', '分类身份已存在，请刷新后重试');
            const row = await tx.category.create({ data: categoryData(ledger.ownerId, auth.deviceId, item, now) });
            await createChange(tx, auth, null, 'category', row.id, 'upsert', categoryPayload(row), now);
            created.push(mapCategory(row));
          }
          await storeIdempotentResult(tx, auth.userId, key, hash, created, now);
          return created;
        });
        // 候选事务已经提交；不能在事务内抛错，否则会把待确认意图一起回滚。
        if (!Array.isArray(result))
          throw new ApiError(
            409,
            'CATEGORY_CONFIRMATION_REQUIRED',
            '官方分类与云端不一致，请先处理待确认候选再重新提交模板',
            result,
          );
        return result;
      }),
  );
  app.post(
    '/api/v1/ledgers/:ledger_id/categories/reorder',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params,
        body: ReorderInput,
        response: { 200: Type.Array(Type.Ref(CategorySchema)) },
      },
    },
    async (request) =>
      execute(request, '调整分类排序', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const { items } = request.body as Static<typeof ReorderInput>;
        if (new Set(items.map((item) => item.id)).size !== items.length)
          throw new ApiError(400, 'DUPLICATE_CATEGORY', '排序列表包含重复分类');
        return withSyncTransaction(prisma, async (tx) => {
          // 等待同步提交锁期间可能撤销设备或停用账号，必须按锁后的状态重新鉴权。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          const rows = await tx.category.findMany({
            where: { ownerId: ledger.ownerId, id: { in: items.map((item) => item.id) }, deletedAt: null },
          });
          if (rows.length !== items.length) throw new ApiError(404, 'CATEGORY_NOT_FOUND', '分类已不存在，请刷新后重试');
          for (const item of items) {
            const row = rows.find((row) => row.id === item.id)!;
            // 相同目标排序允许响应丢失后的重试；不得用旧快照覆盖别端新排序。
            if (row.updatedAt.toISOString() !== item.expected_updated_at && row.sortOrder !== item.sort_order)
              throw new ApiError(409, 'CATEGORY_CHANGED', '分类已被其他设备修改，请刷新后重新排序');
          }
          const now = new Date();
          const result = [];
          for (const item of items) {
            const previous = rows.find((row) => row.id === item.id)!;
            if (previous.sortOrder === item.sort_order) {
              result.push(mapCategory(previous));
              continue;
            }
            const updatedAt = nextCategoryTimestamp(previous, now);
            const updated = await tx.category.update({
              where: { id_ownerId: { id: item.id, ownerId: ledger.ownerId } },
              data: { sortOrder: item.sort_order, updatedAt, updatedByDeviceId: auth.deviceId },
            });
            await createChange(tx, auth, null, 'category', updated.id, 'upsert', categoryPayload(updated), updatedAt);
            result.push(mapCategory(updated));
          }
          return result;
        });
      }),
  );
  app.post(
    '/api/v1/ledgers/:ledger_id/categories/removal-preview',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params,
        body: PreviewInput,
        response: {
          200: Type.Object({
            preview_token: Type.String(),
            categories: Type.Array(Type.Ref(CategorySchema)),
            transaction_count: count,
            recurring_count: count,
          }),
        },
      },
    },
    async (request) =>
      execute(request, '预览分类处理范围', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as Static<typeof PreviewInput>;
        return prisma.$transaction(
          async (tx) => {
            const { ledger } = await getLedgerReadAccess(tx, auth.userId, ledgerId, 'owner');
            const scope = await removalScope(tx, ledger.ownerId, body.category_ids);
            return {
              preview_token: scope.token,
              categories: scope.categories.map(mapCategory),
              transaction_count: scope.transactions.length,
              recurring_count: scope.rules.length,
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
  app.post(
    '/api/v1/ledgers/:ledger_id/categories/remove',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params,
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }) }),
        body: RemoveInput,
        response: { 200: ResultSchema },
      },
    },
    async (request) =>
      execute(request, '处理分类及关联记录', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as Static<typeof RemoveInput>;
        const key = request.headers['idempotency-key'] as string;
        const hash = requestFingerprint({ operation: 'category-remove', ledgerId, body });
        const now = new Date();
        return withSyncTransaction(prisma, async (tx) => {
          // 等待同步提交锁期间可能撤销设备或停用账号，必须按锁后的状态重新鉴权。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          const replay = await findIdempotentReplay<RemovalResult>(tx, auth.userId, key, hash, now);
          if (replay) return replay;
          const scope = await removalScope(tx, ledger.ownerId, body.category_ids);
          if (scope.token !== body.preview_token)
            throw new ApiError(409, 'CATEGORY_SCOPE_CHANGED', '分类或关联数据已变化，请重新预览并确认');
          if (body.mode === 'promote' && scope.roots.some((row) => row.level !== 1))
            throw new ApiError(400, 'CATEGORY_PROMOTE_INVALID', '只有一级分类可以提升子分类');
          const removed = new Set((body.mode === 'promote' ? scope.roots : scope.categories).map((row) => row.id));
          const target =
            body.mode === 'migrate' && body.target_category_id
              ? await tx.category.findFirst({
                  where: { id: body.target_category_id, ownerId: ledger.ownerId, deletedAt: null },
                })
              : null;
          if (
            body.mode === 'migrate' &&
            (!target || removed.has(target.id) || (target.parentId && removed.has(target.parentId)))
          )
            throw new ApiError(400, 'CATEGORY_TARGET_INVALID', '迁移目标必须是保留的有效分类');
          if (
            body.mode === 'migrate' &&
            (!body.expected_target_updated_at || target!.updatedAt.toISOString() !== body.expected_target_updated_at)
          )
            throw new ApiError(409, 'CATEGORY_TARGET_CHANGED', '迁移目标已变化，请重新核对目标分类并确认');
          const transactions = scope.transactions.filter((row) => row.categoryId && removed.has(row.categoryId));
          const rules = scope.rules.filter((row) => row.categoryId && removed.has(row.categoryId));
          const affectedReferences = { ownerId: ledger.ownerId, categoryId: { in: [...removed] } };
          // 全量失效事件也必须晚于账本版本，包含只留下历史交易或周期墓碑的账本。
          const affectedLedgers = await tx.ledger.findMany({
            where: {
              ownerId: ledger.ownerId,
              deletedAt: null,
              OR: [
                { transactions: { some: affectedReferences } },
                { recurringTransactions: { some: affectedReferences } },
              ],
            },
          });
          // 同步接受有限的客户端超前时间；整批写入和事件统一推进，避免手机LWW漏掉排序、提升或墓碑。
          const updatedAt = new Date(
            [...scope.categories, ...transactions, ...rules, ...affectedLedgers].reduce(
              (latest, row) => Math.max(latest, row.updatedAt.getTime() + 1),
              Date.now(),
            ),
          );
          const promoted = body.mode === 'promote' ? scope.categories.filter((row) => !removed.has(row.id)) : [];
          if (promoted.length) {
            const retained = await tx.category.findMany({
              where: { ownerId: ledger.ownerId, deletedAt: null, level: 1, id: { notIn: [...removed] } },
            });
            let order = Math.max(-1, ...retained.map((row) => row.sortOrder));
            if (order + promoted.length > 2147483647)
              throw new ApiError(400, 'CATEGORY_SORT_OVERFLOW', '请先调整分类排序后再提升');
            for (const row of promoted) {
              const updated = await tx.category.update({
                where: { id_ownerId: { id: row.id, ownerId: ledger.ownerId } },
                data: {
                  level: 1,
                  parentId: null,
                  sortOrder: ++order,
                  updatedAt,
                  updatedByDeviceId: auth.deviceId,
                },
              });
              await createChange(tx, auth, null, 'category', row.id, 'upsert', categoryPayload(updated), updatedAt);
            }
          }
          for (const row of transactions) {
            const result =
              body.mode === 'delete' || body.mode === 'promote'
                ? await deleteTransactionMutation(tx, auth, {
                    ledgerId: row.ledgerId,
                    transactionId: row.id,
                    baseRevision: row.revision,
                    updatedAt,
                  })
                : await updateTransactionMutation(tx, auth, {
                    ledgerId: row.ledgerId,
                    transactionId: row.id,
                    baseRevision: row.revision,
                    fields: {
                      categoryId: target!.id,
                      categoryName: target!.name,
                      categoryKind: target!.kind,
                    },
                    historyChanges: { action: 'category-migration', category_id: target!.id },
                    updatedAt,
                  });
            if (result.status !== 'applied')
              throw new ApiError(409, 'CATEGORY_TRANSACTION_CONFLICT', '关联交易发生变化，整批未执行');
          }
          for (const row of rules)
            await tx.recurringTransaction.update({
              where: { id: row.id },
              data: {
                categoryId: null,
                updatedAt,
                updatedByDeviceId: auth.deviceId,
              },
            });
          if (rules.length) {
            const ruleLedgerIds = new Set(rules.map((row) => row.ledgerId));
            for (const changedLedger of affectedLedgers.filter((row) => ruleLedgerIds.has(row.id)))
              await createChange(
                tx,
                auth,
                changedLedger.id,
                'ledger',
                changedLedger.id,
                'upsert',
                { ...ledgerPayload(changedLedger), requires_full: true },
                updatedAt,
              );
          }
          for (const id of removed) {
            await updateCategoryTransactionSnapshots(
              tx,
              auth,
              { id, ownerId: ledger.ownerId, name: null, kind: null },
              updatedAt,
            );
            const deleted = await tx.category.update({
              where: { id_ownerId: { id, ownerId: ledger.ownerId } },
              data: { deletedAt: updatedAt, updatedAt, updatedByDeviceId: auth.deviceId },
            });
            await createChange(tx, auth, null, 'category', id, 'delete', categoryPayload(deleted), updatedAt);
          }
          const result: RemovalResult = {
            removed_categories: removed.size,
            promoted_categories: promoted.length,
            affected_transactions: transactions.length,
            affected_recurring_rules: rules.length,
          };
          await storeIdempotentResult(tx, auth.userId, key, hash, result, now);
          return result;
        });
      }),
  );
}
