import { CategorySchema } from '../../shared/contracts/accounting.js';
import { CategoryConflictSchema, CategoryResolutionSchema } from '../../shared/contracts/category-conflicts.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ApiConfig } from '../../shared/api-config.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { ApiError } from '../../shared/errors.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { AnyUuidSchema, CursorSchema, UuidSchema, isStrictTimestamp } from '../../shared/contracts/scalars.js';
import { structuralSchema } from '../../shared/contracts/structural-schema.js';
import { normalizeClientTimestamp } from '../../shared/sync-timestamps.js';
import {
  SyncPushChangeSchema,
  SyncPushEnvelopeSchema,
  TransactionSyncPayloadSchema,
  type PushChange,
  type PushOutcome,
} from './sync-schemas.js';
import { applyChange } from './sync-apply.js';
import { executeSync, latestVisibleCursor } from './snapshot-support.js';

// 外壳直接派生自完整协议，保留实体判别与字段约束，载荷继续由各实体逐条校验。
const OriginalEnvelopeSchema = structuralSchema(
  Type.Object({
    ...SyncPushEnvelopeSchema.properties,
    changes: {
      ...SyncPushEnvelopeSchema.properties.changes,
      items: Type.Omit(SyncPushChangeSchema, ['payload']),
    },
  }),
);

/** 保留完整请求外壳，只移除每条变更的第一层载荷，载荷错误沿用逐条业务处理。 */
function requestEnvelope(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const { changes, ...fields } = value as Record<string, unknown>;
  return {
    ...fields,
    changes: Array.isArray(changes)
      ? changes.map((change: unknown) => {
          if (change === null || typeof change !== 'object' || Array.isArray(change)) return change;
          const { payload: _payload, ...envelope } = change as Record<string, unknown>;
          return envelope;
        })
      : changes,
  };
}

/** 注册 /api/v1/sync/push 的权限、协议与业务编排。 */
export function registerPushRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  const originalBodies = new WeakMap<FastifyRequest, unknown>();

  app.post(
    '/api/v1/sync/push',
    {
      ...secured,
      preHandler: [
        async (request) => {
          // 外壳校验仍先于鉴权，并交给公共错误边界记录身份和返回统一 400。
          if (request.validationError && !request.compileValidationSchema(SyncPushEnvelopeSchema)(request.body)) {
            throw request.validationError;
          }
          // 不依赖框架尝试联合分支时改写的结果，原始外壳必须在任何写入之前完整通过契约。
          const original = originalBodies.get(request) as { device_id: string; changes: PushChange[] };
          if (
            !Value.Check(OriginalEnvelopeSchema, requestEnvelope(original)) ||
            !original.changes.every(
              (change) =>
                isStrictTimestamp(change.updated_at) &&
                (change.deleted_at === undefined || isStrictTimestamp(change.deleted_at)),
            )
          ) {
            throw new ApiError(400, 'VALIDATION_ERROR', '同步请求外壳不符合接口要求');
          }
        },
        ...secured.preHandler,
      ],
      bodyLimit: 64 * 1024 * 1024,
      attachValidation: true,
      preValidation: async (request) => {
        // 完整冻结客户端输入，框架的类型转换不能改变业务规则和幂等指纹使用的原值。
        originalBodies.set(request, structuredClone(request.body));
      },
      schema: {
        tags: ['sync'],
        body: Type.Object({
          device_id: UuidSchema,
          changes: Type.Array(SyncPushChangeSchema, {
            minItems: 1,
            maxItems: 500,
          }),
        }),
        response: {
          412: Type.Ref(ErrorSchema),
          413: Type.Ref(ErrorSchema),
          200: Type.Object({
            outcomes: Type.Array(
              Type.Object({
                mutation_id: AnyUuidSchema,
                entity_id: AnyUuidSchema,
                // per-mutation 结果：conflict/invalid 不阻塞同批其他实体
                status: Type.Union([
                  Type.Literal('accepted'),
                  Type.Literal('ignored'),
                  Type.Literal('conflict'),
                  Type.Literal('invalid'),
                ]),
                change_id: Type.Union([CursorSchema, Type.Null()]),
                // ledger 实体的当前同步身份（首次上云创建时客户端据此建立绑定）
                sync_id: Type.Optional(UuidSchema),
                revision: Type.Optional(Type.Integer({ minimum: 1 })),
                current_revision: Type.Optional(Type.Integer({ minimum: 0 })),
                current_deleted: Type.Optional(Type.Boolean()),
                current_entity: Type.Optional(Type.Unknown()),
                category_state: Type.Optional(Type.Ref(CategorySchema)),
                category_conflict: Type.Optional(Type.Ref(CategoryConflictSchema)),
                category_resolution: Type.Optional(Type.Ref(CategoryResolutionSchema)),
                blocking_entity: Type.Optional(Type.Unknown()),
                code: Type.Optional(Type.String()),
                message: Type.Optional(Type.String()),
              }),
            ),
            server_cursor: CursorSchema,
          }),
        },
      },
    },
    async (request) =>
      executeSync(request, '推送同步变更', async () => {
        const auth = requireAuth(request);
        const body = originalBodies.get(request) as { device_id: string; changes: PushChange[] };
        if (body.device_id !== auth.deviceId)
          throw new ApiError(403, 'DEVICE_MISMATCH', '设备标识与当前登录会话不一致');
        const now = new Date();
        // per-mutation 语义：每个 mutation 独立事务串行执行，一个 conflict/invalid
        // 不阻塞同批其他实体（避免长期未决冲突饥饿整个同步队列）；
        // 身份（412）、权限（403）或 mutation ID 复用错误会中止本次请求；已提交项仍保留。
        const outcomes: PushOutcome[] = [];
        for (const change of body.changes) {
          const updatedAt = normalizeClientTimestamp(change.updated_at, now);
          try {
            if (change.entity_type === 'transaction' && change.action === 'upsert') {
              const validate = request.compileValidationSchema(TransactionSyncPayloadSchema);
              // 校验副本，业务校验继续读取原始值，避免强制转换掩盖空值等非法输入。
              if (!validate(structuredClone(change.payload))) {
                throw new ApiError(400, 'INVALID_TRANSACTION_PAYLOAD', '交易资料无效，请检查分摊成员与金额');
              }
            }
            outcomes.push(
              await withSyncTransaction(prisma, async (tx) => {
                // 每条 mutation 都重新取得写锁；上一条提交后撤销的会话不能继续推送后续项。
                if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
                return applyChange(tx, auth, change, updatedAt, BigInt(config.syncRetentionMinCursor));
              }),
            );
          } catch (error) {
            if (
              error instanceof ApiError &&
              [400, 404, 409].includes(error.statusCode) &&
              error.code !== 'MUTATION_ID_REUSED'
            ) {
              request.log.warn(
                {
                  request_id: request.id,
                  mutation_id: change.mutation_id,
                  entity_id: change.entity_id,
                  ledger_id: change.ledger_id,
                  code: error.code,
                },
                '同步变更校验失败',
              );
              outcomes.push({
                mutation_id: change.mutation_id,
                entity_id: change.entity_id,
                status: 'invalid',
                change_id: null,
                code: error.code,
                message: error.message,
              });
              continue;
            }
            throw error;
          }
        }
        const cursor = await latestVisibleCursor(prisma, auth.userId);
        return { outcomes, server_cursor: cursor.toString() };
      }),
  );
}
