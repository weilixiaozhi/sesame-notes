import { categoryVersionToken } from '../../shared/category-version.js';
import { CategoryVersionTokenSchema } from '../../shared/contracts/category-conflicts.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { findIdempotentReplay, storeIdempotentResult } from '../../shared/idempotency.js';
import {
  categoryRequestId,
  guardCategoryWrite,
  normalizeCategoryDraft,
  officialCategoryIdentity,
  nextCategoryTimestamp,
} from './category-conflict-service.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { ApiError } from '../../shared/errors.js';
import { AnyUuidSchema } from '../../shared/contracts/scalars.js';
import { CategorySchema } from '../../shared/contracts/accounting.js';
import { updateCategoryTransactionSnapshots } from './category-snapshot.js';
import { execute } from '../../shared/execute.js';
import { createChange } from '../sync-events/index.js';
import {
  categoryData,
  CategoryInput,
  validateParentCategory,
  assertCategoryCanDelete,
  type CategoryCreate,
} from './domain/categories.js';
import { assertCategoryNameIdentity } from './domain/category-identity.js';
import { getLedgerReadAccess, getLedgerWriteAccess } from './domain/ledger-access.js';
import { categoryPayload, mapCategory } from './mappers.js';

type CategoryParams = { ledger_id: string; category_id: string };

/** 注册用户级分类接口；共享账本始终读取 Owner 的分类集合。 */
export function registerCategoryRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  app.get(
    '/api/v1/ledgers/:ledger_id/categories',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        response: { 200: Type.Array(Type.Ref(CategorySchema)) },
      },
    },
    async (request) =>
      execute(request, '读取分类', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const { ledger } = await getLedgerReadAccess(prisma, auth.userId, ledgerId, 'editor');
        const categories = await prisma.category.findMany({
          where: { ownerId: ledger.ownerId, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        });
        return categories.map(mapCategory);
      }),
  );

  app.post(
    '/api/v1/ledgers/:ledger_id/categories',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        body: CategoryInput,
        response: { 201: Type.Ref(CategorySchema) },
      },
    },
    async (request, reply) =>
      execute(request, '创建分类', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as CategoryCreate;
        const now = new Date();
        const category = await withSyncTransaction(prisma, async (tx) => {
          // 写锁等待期间的会话撤销必须先于业务校验、幂等回执和任何领域写入生效。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          await validateParentCategory(tx, ledger.ownerId, body.parent_id ?? null, body.level, body.id);
          await assertCategoryNameIdentity(
            tx,
            ledger.ownerId,
            { ...body, parent_id: body.parent_id ?? null },
            { categoryId: body.id },
          );
          const created = await tx.category.create({ data: categoryData(ledger.ownerId, auth.deviceId, body, now) });
          await createChange(tx, auth, null, 'category', created.id, 'upsert', categoryPayload(created), now);
          return created;
        });
        await reply.status(201).send(mapCategory(category));
      }),
  );

  app.patch(
    '/api/v1/ledgers/:ledger_id/categories/:category_id',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params: Type.Object({ ledger_id: AnyUuidSchema, category_id: AnyUuidSchema }),
        querystring: Type.Object({ expected_version_token: Type.Optional(CategoryVersionTokenSchema) }),
        headers: Type.Object({ 'idempotency-key': Type.Optional(AnyUuidSchema) }),
        body: Type.Partial(Type.Omit(CategoryInput, ['id'])),
        response: { 200: Type.Ref(CategorySchema), 409: Type.Ref(ErrorSchema) },
      },
    },
    async (request) =>
      execute(request, '更新分类', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId, category_id: categoryId } = request.params as CategoryParams;
        const body = request.body as Partial<CategoryCreate>;
        const { expected_version_token: expected } = request.query as { expected_version_token?: string };
        const rawKey = request.headers['idempotency-key'];
        const mutationId = rawKey === undefined ? undefined : categoryRequestId(rawKey);
        const key = mutationId ? `category-rest:${mutationId}` : null;
        const hash = requestFingerprint({ operation: 'category-patch', ledgerId, categoryId, body, expected });
        const result = await withSyncTransaction(prisma, async (tx) => {
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          const replay = key
            ? await findIdempotentReplay<CategoryRestResult>(tx, auth.userId, key, hash, new Date())
            : null;
          if (replay) return replay;
          const current = await tx.category.findFirst({ where: { id: categoryId, ownerId: ledger.ownerId } });
          if (!current) throw new ApiError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
          const official = officialCategoryIdentity(categoryId);
          if (official && (!mutationId || expected === undefined))
            throw new ApiError(400, 'CATEGORY_BASE_REQUIRED', '默认分类编辑需要当前云端版本和请求标识，请刷新');
          if (!official && current.deletedAt) throw new ApiError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
          if (!official && expected !== undefined && expected !== categoryVersionToken(current))
            throw new ApiError(409, 'CATEGORY_VERSION_CHANGED', '分类已变化，请刷新后重新确认');
          const draft = normalizeCategoryDraft(
            {
              name: current.name,
              kind: current.kind,
              level: current.level,
              sort_order: current.sortOrder,
              icon: current.icon,
              parent_id: current.parentId,
              ...body,
            },
            categoryId,
          );
          let now = nextCategoryTimestamp(current);
          let result: CategoryRestResult | undefined;
          if (official && mutationId) {
            const guard = await guardCategoryWrite(
              tx,
              auth,
              {
                mutation_id: mutationId,
                entity_id: categoryId,
                action: 'upsert',
                payload: { ...draft, base_token: expected },
              },
              current,
              draft,
              hash,
              now,
            );
            if (guard.kind === 'conflict') result = { kind: 'conflict', conflict_ids: [guard.candidate.id] };
            else if (guard.kind === 'accepted') result = { kind: 'updated', category: guard.state };
            else now = guard.updatedAt;
          }
          if (!result) {
            await validateParentCategory(tx, ledger.ownerId, draft.parent_id, draft.level, categoryId);
            await assertCategoryNameIdentity(tx, ledger.ownerId, draft, { categoryId, current });
            const updated = await tx.category.update({
              where: { id_ownerId: { id: categoryId, ownerId: ledger.ownerId } },
              data: {
                name: draft.name,
                kind: draft.kind,
                level: draft.level,
                sortOrder: draft.sort_order,
                icon: draft.icon,
                parentId: draft.parent_id,
                updatedAt: now,
                updatedByDeviceId: auth.deviceId,
              },
            });
            await updateCategoryTransactionSnapshots(tx, auth, updated, now);
            await createChange(tx, auth, null, 'category', updated.id, 'upsert', categoryPayload(updated), now);
            result = { kind: 'updated', category: mapCategory(updated) };
          }
          if (key) await storeIdempotentResult(tx, auth.userId, key, hash, result, new Date());
          return result;
        });
        if (result.kind === 'conflict')
          throw new ApiError(409, 'CATEGORY_CONFIRMATION_REQUIRED', '默认分类与云端不一致，请处理待确认候选', {
            conflict_ids: result.conflict_ids,
          });
        if (result.kind !== 'updated') throw new Error('分类更新回执类型不一致');
        return result.category;
      }),
  );
  app.delete(
    '/api/v1/ledgers/:ledger_id/categories/:category_id',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params: Type.Object({ ledger_id: AnyUuidSchema, category_id: AnyUuidSchema }),
        querystring: Type.Object({ expected_version_token: Type.Optional(CategoryVersionTokenSchema) }),
        headers: Type.Object({ 'idempotency-key': Type.Optional(AnyUuidSchema) }),
        response: { 204: Type.Null(), 409: Type.Ref(ErrorSchema) },
      },
    },
    async (request, reply) =>
      execute(request, '删除分类', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId, category_id: categoryId } = request.params as CategoryParams;
        const { expected_version_token: expected } = request.query as { expected_version_token?: string };
        const rawKey = request.headers['idempotency-key'];
        const mutationId = rawKey === undefined ? undefined : categoryRequestId(rawKey);
        const key = mutationId ? `category-rest:${mutationId}` : null;
        const hash = requestFingerprint({ operation: 'category-delete', ledgerId, categoryId, expected });
        const result = await withSyncTransaction(prisma, async (tx) => {
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const { ledger } = await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          const replay = key
            ? await findIdempotentReplay<CategoryRestResult>(tx, auth.userId, key, hash, new Date())
            : null;
          if (replay) return replay;
          const current = await tx.category.findFirst({ where: { id: categoryId, ownerId: ledger.ownerId } });
          if (!current) throw new ApiError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
          const official = officialCategoryIdentity(categoryId);
          if (official && (!mutationId || expected === undefined))
            throw new ApiError(400, 'CATEGORY_BASE_REQUIRED', '默认分类删除需要当前云端版本和请求标识，请刷新');
          if (!official && expected !== undefined && expected !== categoryVersionToken(current))
            throw new ApiError(409, 'CATEGORY_VERSION_CHANGED', '分类已变化，请刷新后重新确认');
          // 墓碑版本必须晚于已有分类，快时钟设备才能接受这次删除。
          let now = nextCategoryTimestamp(current);
          let result: CategoryRestResult | undefined;
          if (official && mutationId) {
            const guard = await guardCategoryWrite(
              tx,
              auth,
              { mutation_id: mutationId, entity_id: categoryId, action: 'delete', payload: { base_token: expected } },
              current,
              null,
              hash,
              now,
            );
            if (guard.kind === 'conflict') result = { kind: 'conflict', conflict_ids: [guard.candidate.id] };
            else if (guard.kind === 'accepted') result = { kind: 'deleted' };
            else now = guard.updatedAt;
          }
          if (!result) {
            if (current.deletedAt) throw new ApiError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
            await assertCategoryCanDelete(tx, ledger.ownerId, current.id);
            const deleted = await tx.category.update({
              where: { id_ownerId: { id: categoryId, ownerId: ledger.ownerId } },
              data: { deletedAt: now, updatedAt: now, updatedByDeviceId: auth.deviceId },
            });
            await updateCategoryTransactionSnapshots(tx, auth, { ...deleted, name: null, kind: null }, now);
            await createChange(tx, auth, null, 'category', categoryId, 'delete', categoryPayload(deleted), now);
            result = { kind: 'deleted' };
          }
          if (key) await storeIdempotentResult(tx, auth.userId, key, hash, result, new Date());
          return result;
        });
        if (result.kind === 'conflict')
          throw new ApiError(409, 'CATEGORY_CONFIRMATION_REQUIRED', '默认分类与云端不一致，请处理待确认候选', {
            conflict_ids: result.conflict_ids,
          });
        await reply.status(204).send();
      }),
  );
}

type CategoryRestResult =
  | { kind: 'updated'; category: ReturnType<typeof mapCategory> }
  | { kind: 'deleted' }
  | { kind: 'conflict'; conflict_ids: string[] };
