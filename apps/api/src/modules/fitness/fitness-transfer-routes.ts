import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { Value } from '@sinclair/typebox/value';
import { Type, type Static } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { requestFingerprint } from '../../shared/request-fingerprint.js';
import { findIdempotentReplay, storeIdempotentResult } from '../../shared/idempotency.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { uuidV5 } from '../../shared/uuid.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { fitnessPayloadSchemas, type FitnessPreferencesPayload } from './fitness-schemas.js';
import { structuralSchema } from '../../shared/contracts/structural-schema.js';
import { applyFitnessChange } from './fitness-sync.js';
import { prepareFitnessImport, type TransferRecord } from './fitness-transfer-rules.js';
import { officialExerciseIds } from './official-fitness.js';

const recordSchema = Type.Union(
  Object.entries(fitnessPayloadSchemas).map(([entityType, payload]) =>
    Type.Object({ id: AnyUuidSchema, entity_type: Type.Literal(entityType), payload }, { additionalProperties: false }),
  ),
);
const InputSchema = Type.Object(
  {
    sync_id: UuidSchema,
    export_id: UuidSchema,
    replace_preferences: Type.Optional(Type.Boolean()),
    records: Type.Array(recordSchema),
  },
  { additionalProperties: false },
);
const CheckInputSchema = structuralSchema(InputSchema);
type Input = Static<typeof InputSchema>;
type Receipt = { target_id: string };

/** 全量导出和原子导入四类健身记录；逐来源长效回执支持同一文件分批选择导入。 */
export function registerFitnessTransferRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  app.get(
    '/api/v1/fitness-spaces/:fitness_space_id/export',
    {
      ...secured,
      schema: {
        tags: ['fitness'],
        params: Type.Object({ fitness_space_id: AnyUuidSchema }),
        querystring: Type.Object({ sync_id: Type.Optional(UuidSchema) }),
        response: { 200: Type.Object({ records: Type.Array(recordSchema) }) },
      },
    },
    async (request) =>
      execute(request, '导出完整健身数据', async () => {
        const auth = requireAuth(request);
        const { fitness_space_id: id } = request.params as { fitness_space_id: string };
        const query = request.query as { sync_id?: string };
        return prisma.$transaction(
          async (tx) => {
            const space = await tx.fitnessSpace.findFirst({ where: { id, ownerId: auth.userId, deletedAt: null } });
            if (!space) throw new ApiError(404, 'FITNESS_SPACE_NOT_FOUND', '健身本不存在或无权访问');
            if (query.sync_id && query.sync_id !== space.syncId)
              throw new ApiError(412, 'SYNC_ID_MISMATCH', '健身本已重建，请重新载入');
            const rows = await tx.fitnessEntity.findMany({
              where: { fitnessSpaceId: id, deletedAt: null },
              orderBy: { id: 'asc' },
            });
            return { records: rows.map((row) => ({ id: row.id, entity_type: row.entityType, payload: row.payload })) };
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
  app.post(
    '/api/v1/fitness-spaces/:fitness_space_id/import',
    {
      ...secured,
      bodyLimit: 64 * 1024 * 1024,
      // 默认 AJV removeAdditional 会在联合分支试探时删除另一实体的字段，使用只读结构校验。
      validatorCompiler: ({ httpPart }) => {
        if (httpPart === 'body')
          return (data) =>
            Value.Check(CheckInputSchema, data)
              ? { value: data }
              : { error: new ApiError(400, 'FITNESS_IMPORT_FORMAT', '导入正文不符合完整契约') };
        if (httpPart === 'params')
          return (data) =>
            Value.Check(Type.Object({ fitness_space_id: AnyUuidSchema }, { additionalProperties: false }), data)
              ? { value: data }
              : { error: new ApiError(400, 'FITNESS_IMPORT_PARAMS', '健身本参数无效') };
        throw new Error('健身导入路由尚未实现此请求部分的验证，拒绝注册');
      },
      schema: {
        tags: ['fitness'],
        params: Type.Object({ fitness_space_id: AnyUuidSchema }),
        body: InputSchema,
        response: {
          200: Type.Object({
            imported: Type.Integer({ minimum: 0 }),
            skipped: Type.Integer({ minimum: 0 }),
            ids: Type.Record(AnyUuidSchema, AnyUuidSchema),
            replayed: Type.Boolean(),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '原子导入健身数据', async () => {
        const auth = requireAuth(request);
        const { fitness_space_id: id } = request.params as { fitness_space_id: string };
        const body = request.body as Input;
        const records = body.records as TransferRecord[];
        const now = new Date();
        return withSyncTransaction(prisma, async (tx) => {
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const space = await tx.fitnessSpace.findFirst({ where: { id, ownerId: auth.userId, deletedAt: null } });
          if (!space) throw new ApiError(404, 'FITNESS_SPACE_NOT_FOUND', '健身本不存在或无权访问');
          if (space.syncId !== body.sync_id) throw new ApiError(412, 'SYNC_ID_MISMATCH', '健身本已重建，请重新载入');
          const previous = await tx.fitnessEntity.findUnique({ where: { id } });
          const prefs = previous && !previous.deletedAt ? (previous.payload as FitnessPreferencesPayload) : null;
          const prepared = prepareFitnessImport(records, id, body.export_id, prefs, await officialExerciseIds(tx));
          const pending = new Map<string, { key: string; hash: string; source: TransferRecord }>();
          let skipped = 0;
          for (const source of records) {
            const key = `fitness-import:${id}:${uuidV5(body.export_id, `${source.entity_type}:${source.id}`)}`;
            const hash = requestFingerprint({ sync_id: body.sync_id, source });
            const replay = await findIdempotentReplay<Receipt>(tx, auth.userId, key, hash, now);
            if (replay) {
              skipped++;
              continue;
            }
            pending.set(prepared.ids[source.id]!, { key, hash, source });
          }
          if (previous && pending.has(id) && !body.replace_preferences)
            throw new ApiError(409, 'FITNESS_PREFERENCES_CONFIRMATION_REQUIRED', '导入将替换训练偏好，请明确确认');
          if (previous?.deletedAt && pending.has(id))
            throw new ApiError(409, 'FITNESS_PREFERENCES_DELETED', '此健身本偏好已删除，不能通过导入复活');
          let imported = 0;
          for (const record of prepared.records) {
            const receipt = pending.get(record.id);
            if (!receipt) continue;
            const existing = await tx.fitnessEntity.findUnique({ where: { id: record.id } });
            if (existing && record.entity_type !== 'fitness_preferences')
              throw new ApiError(
                409,
                'FITNESS_IMPORT_ID_COLLISION',
                '导入目标记录已存在但没有匹配回执，未覆盖现有数据',
              );
            const payload = { ...record.payload };
            if (existing) {
              payload.created_at = existing.createdAt.toISOString();
              payload.updated_at = new Date(Math.max(now.getTime(), existing.updatedAt.getTime() + 1)).toISOString();
            }
            const result = await applyFitnessChange(tx, auth, {
              mutation_id: uuidV5(prepared.namespace, `${record.entity_type}:${receipt.source.id}:import`),
              entity_type: record.entity_type,
              entity_id: record.id,
              ledger_id: null,
              fitness_space_id: id,
              sync_id: space.syncId,
              base_revision: existing?.revision ?? 0,
              action: 'upsert',
              updated_at: now.toISOString(),
              payload,
            });
            if (result.status === 'conflict')
              throw new ApiError(409, 'FITNESS_IMPORT_CONFLICT', '导入与现有训练冲突，整份选择均未写入');
            await storeIdempotentResult(
              tx,
              auth.userId,
              receipt.key,
              receipt.hash,
              { target_id: record.id },
              now,
              new Date('9999-12-31T23:59:59.999Z'),
            );
            imported++;
          }
          return { imported, skipped, ids: prepared.ids, replayed: imported === 0 && skipped > 0 };
        });
      }),
  );
}
