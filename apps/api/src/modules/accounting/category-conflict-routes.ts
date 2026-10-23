import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { AnyUuidSchema } from '../../shared/contracts/scalars.js';
import {
  CategoryConflictSchema,
  CategoryResolutionSchema,
  CategoryVersionTokenSchema,
} from '../../shared/contracts/category-conflicts.js';
import { categoryState, categoryVersionToken } from '../../shared/category-version.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { findMutationReservation, reserveMutation } from '../../shared/mutation-reservations.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { execute } from '../../shared/execute.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { createChange } from '../sync-events/index.js';
import { mapCategoryConflict, nextCategoryTimestamp, normalizeCategoryDraft } from './category-conflict-service.js';
import { validateParentCategory, assertCategoryCanDelete } from './domain/categories.js';
import { assertCategoryNameIdentity } from './domain/category-identity.js';
import { updateCategoryTransactionSnapshots } from './category-snapshot.js';

const ResolveInput = Type.Object(
  {
    mutation_id: AnyUuidSchema,
    expected_candidate_version: Type.Integer({ minimum: 1 }),
    expected_cloud_token: CategoryVersionTokenSchema,
    choice: Type.Union([Type.Literal('cloud'), Type.Literal('local')]),
    restore_deleted: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

/** 候选只向所属账号开放；共享账本编辑者不能读取所有者的私人冲突。 */
export function registerCategoryConflictRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  app.get(
    '/api/v1/category-conflicts',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        querystring: Type.Object({
          status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('resolved'), Type.Literal('all')])),
          cursor: Type.Optional(AnyUuidSchema),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        }),
        response: {
          200: Type.Object({
            items: Type.Array(Type.Ref(CategoryConflictSchema)),
            next_cursor: Type.Union([AnyUuidSchema, Type.Null()]),
            has_more: Type.Boolean(),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '读取分类待确认候选', async () => {
        const auth = requireAuth(request);
        const query = request.query as { status?: 'pending' | 'resolved' | 'all'; cursor?: string; limit?: number };
        return prisma.$transaction(
          async (tx) => {
            const anchor = query.cursor
              ? await tx.categoryConflict.findFirst({ where: { id: query.cursor, ownerId: auth.userId } })
              : null;
            if (query.cursor && !anchor) throw new ApiError(400, 'INVALID_CURSOR', '候选分页游标无效');
            const limit = query.limit ?? 50;
            const rows = await tx.categoryConflict.findMany({
              where: {
                ownerId: auth.userId,
                ...(query.status === 'all' ? {} : { status: query.status ?? 'pending' }),
                ...(anchor
                  ? {
                      OR: [
                        { createdAt: { lt: anchor.createdAt } },
                        { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                      ],
                    }
                  : {}),
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: limit + 1,
              include: { category: true },
            });
            const hasMore = rows.length > limit;
            const page = rows.slice(0, limit);
            return {
              items: page.map((row) => mapCategoryConflict(row, row.category)),
              has_more: hasMore,
              next_cursor: hasMore ? page.at(-1)!.id : null,
            };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
  app.post(
    '/api/v1/category-conflicts/:conflict_id/resolve',
    {
      ...secured,
      schema: {
        tags: ['categories'],
        params: Type.Object({ conflict_id: AnyUuidSchema }),
        body: ResolveInput,
        response: { 200: Type.Ref(CategoryResolutionSchema), 409: Type.Ref(ErrorSchema) },
      },
    },
    async (request) =>
      execute(request, '确认分类候选', async () => {
        const auth = requireAuth(request);
        const { conflict_id: id } = request.params as { conflict_id: string };
        const body = request.body as Static<typeof ResolveInput>;
        const hash = requestFingerprint({ operation: 'category-resolve', owner_id: auth.userId, id, body });
        return withSyncTransaction(prisma, async (tx) => {
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const candidate = await tx.categoryConflict.findFirst({
            where: { id, ownerId: auth.userId },
            include: { category: true },
          });
          if (!candidate) throw new ApiError(404, 'CATEGORY_CONFLICT_NOT_FOUND', '分类候选不存在');
          const previous = await tx.categoryConflict.findFirst({
            where: { ownerId: auth.userId, resolutionMutationId: body.mutation_id },
          });
          if (previous) {
            if (previous.id !== id || previous.resolutionHash !== hash)
              throw new ApiError(409, 'MUTATION_ID_REUSED', '确认请求标识已经用于不同选择');
            return previous.resolutionResult;
          }
          const reservedSource = await findMutationReservation(tx, auth, body.mutation_id, 'device');
          const existingEvent = await tx.syncChange.findUnique({
            where: {
              deviceId_mutationId: { deviceId: auth.deviceId, mutationId: body.mutation_id },
            },
            select: { changeId: true },
          });
          const reservedCommand = await findMutationReservation(tx, auth, body.mutation_id, 'account');
          if (reservedSource || existingEvent || reservedCommand)
            throw new ApiError(409, 'MUTATION_ID_REUSED', '确认请求必须使用未用于同步来源的新标识');
          if (candidate.status !== 'pending')
            throw new ApiError(409, 'CATEGORY_CONFLICT_RESOLVED', '该候选已经被其他确认处理，请刷新');
          if (candidate.candidateVersion !== body.expected_candidate_version)
            throw new ApiError(409, 'CATEGORY_CANDIDATE_CHANGED', '候选版本已经变化，请刷新');
          if (categoryVersionToken(candidate.category) !== body.expected_cloud_token)
            throw new ApiError(409, 'CATEGORY_VERSION_CHANGED', '云端分类已经变化，请重新核对双方内容');
          if (candidate.action !== 'upsert' && candidate.action !== 'delete') throw new Error('分类候选操作类型损坏');
          await reserveMutation(tx, auth, body.mutation_id, hash, 'account');
          let current = candidate.category;
          if (body.choice === 'local') {
            const now = nextCategoryTimestamp(current);
            if (candidate.action === 'upsert') {
              if (current.deletedAt && body.restore_deleted !== true)
                throw new ApiError(409, 'CATEGORY_RESTORE_CONFIRMATION_REQUIRED', '云端分类已删除，需要明确确认恢复');
              if (!current.deletedAt && body.restore_deleted)
                throw new ApiError(409, 'CATEGORY_VERSION_CHANGED', '该分类当前未删除，请刷新确认');
              const draft = normalizeCategoryDraft(candidate.localPayload as Record<string, unknown>, current.id);
              await validateParentCategory(tx, auth.userId, draft.parent_id, draft.level, current.id);
              await assertCategoryNameIdentity(tx, auth.userId, draft, { categoryId: current.id, current });
              current = await tx.category.update({
                where: { id_ownerId: { id: current.id, ownerId: auth.userId } },
                data: {
                  name: draft.name,
                  kind: draft.kind,
                  level: draft.level,
                  sortOrder: draft.sort_order,
                  icon: draft.icon,
                  parentId: draft.parent_id,
                  deletedAt: null,
                  updatedAt: now,
                  updatedByDeviceId: auth.deviceId,
                },
              });
              await updateCategoryTransactionSnapshots(tx, auth, current, now);
            } else {
              if (body.restore_deleted)
                throw new ApiError(400, 'INVALID_CATEGORY_RESOLUTION', '删除候选不能同时恢复分类');
              await assertCategoryCanDelete(tx, auth.userId, current.id);
              current = await tx.category.update({
                where: { id_ownerId: { id: current.id, ownerId: auth.userId } },
                data: { deletedAt: now, updatedAt: now, updatedByDeviceId: auth.deviceId },
              });
              await updateCategoryTransactionSnapshots(tx, auth, { ...current, name: null, kind: null }, now);
            }
            await createChange(
              tx,
              auth,
              null,
              'category',
              current.id,
              candidate.action,
              categoryState(current),
              now,
              null,
              body.mutation_id,
              hash,
            );
          } else if (body.restore_deleted)
            throw new ApiError(400, 'INVALID_CATEGORY_RESOLUTION', '保留云端不能请求恢复');
          const result = {
            conflict_id: id,
            candidate_version: candidate.candidateVersion + 1,
            source_device_id: candidate.sourceDeviceId,
            source_mutation_id: candidate.sourceMutationId,
            resolution: body.choice,
            category_state: categoryState(current),
          };
          await tx.categoryConflict.update({
            where: { id },
            data: {
              candidateVersion: candidate.candidateVersion + 1,
              status: 'resolved',
              resolution: body.choice,
              resolutionMutationId: body.mutation_id,
              resolutionHash: hash,
              resolutionResult: result as Prisma.InputJsonValue,
              resolvedAt: new Date(),
            },
          });
          return result;
        });
      }),
  );
}
