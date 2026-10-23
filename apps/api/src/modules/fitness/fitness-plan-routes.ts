import type { FastifyInstance } from 'fastify';
import type { PrismaClient, Prisma } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { hasSyncRevisionConflict, identifySyncMutation } from '../../shared/sync-mutation.js';
import { uuidV5 } from '../../shared/uuid.js';
import { authenticate, requireAuth, requireScopes, currentSessionAccess } from '../auth/index.js';
import { createChange } from '../sync-events/index.js';
import { fitnessPayloadSchemas, type FitnessPlanPayload, type FitnessPreferencesPayload } from './fitness-schemas.js';
import { applyFitnessChange, fitnessSnapshot } from './fitness-sync.js';
import { validateFitnessPayload, validateFitnessTransition } from './fitness-rules.js';
import { addPlanDays, generatePlanCycles, preparePlanSave } from './fitness-plan-generation.js';
import { officialExerciseIds } from './official-fitness.js';

const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const CommandSchema = Type.Object(
  {
    mutation_id: UuidSchema,
    sync_id: UuidSchema,
    base_revision: Type.Integer({ minimum: 0, maximum: 2147483647 }),
    today: date,
    action: Type.Union([Type.Literal('save'), Type.Literal('generate')]),
    plan: Type.Optional(fitnessPayloadSchemas.fitness_plan),
    restart_date: Type.Optional(date),
    template_copies: Type.Optional(
      Type.Array(
        Type.Object(
          { id: AnyUuidSchema, payload: fitnessPayloadSchemas.fitness_template },
          { additionalProperties: false },
        ),
        { maxItems: 100 },
      ),
    ),
  },
  { additionalProperties: false },
);
type Command = Static<typeof CommandSchema>;
type Template = Static<typeof fitnessPayloadSchemas.fitness_template>;
const PlanSnapshotSchema = Type.Object({
  ...fitnessPayloadSchemas.fitness_plan.properties,
  id: AnyUuidSchema,
  fitness_space_id: AnyUuidSchema,
  sync_id: UuidSchema,
  revision: Type.Integer({ minimum: 1 }),
  deleted_at: Type.Union([Type.String(), Type.Null()]),
});

/** 在线计划编排、生成训练与同步事件共享单一事务，避免浏览器断线留下半个周期。 */
export function registerFitnessPlanRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.post(
    '/api/v1/fitness-spaces/:fitness_space_id/plans/:plan_id/command',
    {
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')],
      schema: {
        tags: ['fitness'],
        params: Type.Object({ fitness_space_id: AnyUuidSchema, plan_id: AnyUuidSchema }),
        body: CommandSchema,
        response: {
          200: Type.Object({
            plan: PlanSnapshotSchema,
            generated_count: Type.Integer(),
            removed_count: Type.Integer(),
            has_more: Type.Boolean(),
            replayed: Type.Boolean(),
          }),
        },
      },
    },
    async (request) =>
      execute(request, '保存训练计划', async () => {
        const auth = requireAuth(request);
        const { fitness_space_id: spaceId, plan_id: planId } = request.params as {
          fitness_space_id: string;
          plan_id: string;
        };
        const body = request.body as Command;
        addPlanDays(body.today, 0);
        if (body.action === 'save' && !body.plan)
          throw new ApiError(400, 'FITNESS_PLAN_REQUIRED', '保存时需要完整计划');
        if (body.action === 'generate' && (body.plan || body.restart_date || body.template_copies))
          throw new ApiError(400, 'FITNESS_PLAN_COMMAND', '补齐周期不能同时修改计划');
        return withSyncTransaction(prisma, async (tx) => {
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '请重新登录');
          const space = await tx.fitnessSpace.findFirst({
            where: { id: spaceId, ownerId: auth.userId, deletedAt: null },
          });
          if (!space) throw new ApiError(404, 'FITNESS_SPACE_NOT_FOUND', '健身空间不存在或不可访问');
          if (space.syncId !== body.sync_id)
            throw new ApiError(412, 'SYNC_ID_MISMATCH', '健身空间身份已变化，请刷新后重试');
          const commandIdentity = { ...body, fitness_space_id: spaceId, plan_id: planId, command: 'fitness-plan' };
          const identity = await identifySyncMutation(tx, auth, commandIdentity);
          if (identity.duplicate)
            return {
              plan: identity.duplicate.payload,
              generated_count: 0,
              removed_count: 0,
              has_more: false,
              replayed: true,
            };
          const row = await tx.fitnessEntity.findUnique({ where: { id: planId } });
          if (row && (row.entityType !== 'fitness_plan' || row.fitnessSpaceId !== space.id))
            throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '计划标识不能用于此空间');
          if (hasSyncRevisionConflict({ action: 'upsert', base_revision: body.base_revision }, row))
            throw new ApiError(409, 'FITNESS_PLAN_CHANGED', '计划已在其他设备修改，请重新加载后再编辑');
          if (!row && body.action === 'generate') throw new ApiError(404, 'FITNESS_PLAN_NOT_FOUND', '计划不存在');
          const previous = row ? (row.payload as FitnessPlanPayload) : null;
          const now = new Date().toISOString();
          const officialIds = await officialExerciseIds(tx);
          const prepared =
            body.action === 'save'
              ? preparePlanSave(body.plan!, previous, body.today, now, body.restart_date, officialIds)
              : { plan: structuredClone(previous!), restart: false };
          // 官方计划导入的模板副本与计划在同一事务创建；已有副本仅引用，绝不覆盖。
          for (const copy of body.template_copies ?? []) {
            const outcome = await applyFitnessChange(tx, auth, {
              mutation_id: uuidV5(body.mutation_id, `template:${copy.id}`),
              entity_type: 'fitness_template',
              entity_id: copy.id,
              ledger_id: null,
              fitness_space_id: space.id,
              sync_id: space.syncId,
              base_revision: 0,
              action: 'upsert',
              updated_at: copy.payload.updated_at,
              payload: copy.payload,
            });
            if (outcome.status === 'conflict')
              throw new ApiError(409, 'FITNESS_TEMPLATE_CHANGED', '模板副本标识已存在，请重新打开导入');
          }
          const supporting = await tx.fitnessEntity.findMany({
            where: {
              fitnessSpaceId: space.id,
              entityType: { in: ['fitness_template', 'fitness_preferences'] },
              deletedAt: null,
            },
          });
          const templates = new Map(
            supporting
              .filter((item) => item.entityType === 'fitness_template')
              .map((item) => [item.id, item.payload as Template]),
          );
          const preferences = supporting.find((item) => item.entityType === 'fitness_preferences')?.payload as
            FitnessPreferencesPayload | undefined;
          const result = generatePlanCycles(
            planId,
            prepared.plan,
            body.today,
            now,
            templates,
            preferences?.exercise_rest_settings,
            prepared.restart,
          );
          let removedCount = 0;
          if (prepared.restart) {
            const overwritten = await tx.fitnessEntity.findMany({
              where: {
                fitnessSpaceId: space.id,
                entityType: 'fitness_workout',
                deletedAt: null,
                AND: [
                  { payload: { path: ['source_plan_id'], equals: planId } },
                  { payload: { path: ['scheduled_date'], gte: result.plan.start_date! } },
                  { payload: { path: ['scheduled_date'], lt: result.plan.generation_state.next_cycle_start_date! } },
                ],
              },
            });
            for (const workout of overwritten) {
              const outcome = await applyFitnessChange(tx, auth, {
                mutation_id: uuidV5(body.mutation_id, `delete:${workout.id}`),
                entity_type: 'fitness_workout',
                entity_id: workout.id,
                ledger_id: null,
                fitness_space_id: space.id,
                sync_id: space.syncId,
                base_revision: workout.revision,
                action: 'delete',
                updated_at: now,
                payload: {},
              });
              if (outcome.status === 'conflict')
                throw new ApiError(409, 'FITNESS_PLAN_CHANGED', '覆盖范围内的训练已变化，请重新确认');
              removedCount++;
            }
          }
          let generatedCount = 0;
          const existing = await tx.fitnessEntity.findMany({
            where: { id: { in: result.workouts.map((workout) => workout.id) } },
            select: { id: true, fitnessSpaceId: true, entityType: true },
          });
          const existingIds = new Set(existing.map((workout) => workout.id));
          if (existing.some((item) => item.fitnessSpaceId !== space.id || item.entityType !== 'fitness_workout'))
            throw new ApiError(409, 'ENTITY_SCOPE_CONFLICT', '训练安排标识已被其他实体占用');
          for (const workout of result.workouts) {
            if (existingIds.has(workout.id)) continue; // 含墓碑；已删除的发生身份永不复活。
            const outcome = await applyFitnessChange(tx, auth, {
              mutation_id: uuidV5(body.mutation_id, `create:${workout.id}`),
              entity_type: 'fitness_workout',
              entity_id: workout.id,
              ledger_id: null,
              fitness_space_id: space.id,
              sync_id: space.syncId,
              base_revision: 0,
              action: 'upsert',
              updated_at: now,
              payload: workout.payload,
            });
            if (outcome.status === 'conflict')
              throw new ApiError(409, 'FITNESS_PLAN_CHANGED', '计划训练已变化，请重新加载');
            generatedCount++;
          }
          validateFitnessPayload('fitness_plan', result.plan, officialIds);
          if (previous) validateFitnessTransition('fitness_plan', previous, result.plan);
          const references = [...result.plan.days, ...(result.plan.pending_schedule?.days ?? [])].flatMap((day) =>
            day.slot?.source_template_id ? [day.slot.source_template_id] : [],
          );
          if (
            references.length &&
            (await tx.fitnessEntity.findFirst({ where: { id: { in: references }, fitnessSpaceId: { not: space.id } } }))
          )
            throw new ApiError(400, 'FITNESS_CROSS_SPACE_REFERENCE', '计划模板必须属于同一空间');
          const saved = row
            ? await tx.fitnessEntity.update({
                where: { id: row.id },
                data: {
                  payload: result.plan as Prisma.InputJsonObject,
                  updatedAt: new Date(result.plan.updated_at),
                  revision: { increment: 1 },
                },
              })
            : await tx.fitnessEntity.create({
                data: {
                  id: planId,
                  fitnessSpaceId: space.id,
                  entityType: 'fitness_plan',
                  payload: result.plan as Prisma.InputJsonObject,
                  createdAt: new Date(result.plan.created_at),
                  updatedAt: new Date(result.plan.updated_at),
                },
              });
          await tx.fitnessSpace.update({
            where: { id: space.id },
            data: { updatedAt: new Date(Math.max(space.updatedAt.getTime(), Date.parse(result.plan.updated_at))) },
          });
          const snapshot = fitnessSnapshot(saved, space);
          await createChange(
            tx,
            auth,
            null,
            'fitness_plan',
            planId,
            'upsert',
            snapshot,
            new Date(),
            null,
            body.mutation_id,
            identity.requestHash,
            null,
            null,
            space.id,
          );
          return {
            plan: snapshot,
            generated_count: generatedCount,
            removed_count: removedCount,
            has_more: result.hasMore,
            replayed: false,
          };
        });
      }),
  );
}
