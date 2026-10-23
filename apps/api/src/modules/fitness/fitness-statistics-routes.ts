import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { fitnessPayloadSchemas, type FitnessWorkoutPayload, type FitnessPlanPayload } from './fitness-schemas.js';
import { fitnessSnapshot } from './fitness-sync.js';
import { fitnessCalendar, fitnessDateContext, summarizeFitness } from './fitness-statistics.js';

const date = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const nullableText = Type.Union([Type.String(), Type.Null()]);
const count = Type.Integer({ minimum: 0 });
const volume = Type.String({ pattern: '^\\d+(?:\\.\\d+)?$' });
const QuerySchema = Type.Object({
  start_date: date,
  end_date: date,
  time_zone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  sync_id: Type.Optional(UuidSchema),
});
type Query = Static<typeof QuerySchema>;
const StatsSchema = Type.Object({
  training_days: count,
  completed_workouts: count,
  completed_sets: count,
  total_duration_ms: count,
  volume_kg: volume,
  by_date: Type.Array(
    Type.Object({ date, completed_workouts: count, completed_sets: count, duration_ms: count, volume_kg: volume }),
  ),
  by_exercise: Type.Array(
    Type.Object({ exercise_id: Type.String(), completed_sets: count, working_sets: count, volume_kg: volume }),
  ),
});
const CalendarSchema = Type.Object({
  days: Type.Array(
    Type.Object({
      date,
      workouts: Type.Array(
        Type.Object({
          id: AnyUuidSchema,
          name: Type.String(),
          status: Type.Union([Type.Literal('scheduled'), Type.Literal('in_progress'), Type.Literal('completed')]),
          scheduled_date: date,
          workout_date: date,
          source_plan_id: nullableText,
          source_plan_name: nullableText,
          revision: count,
        }),
      ),
      rest_days: Type.Array(Type.Object({ source_plan_id: AnyUuidSchema, source_plan_name: Type.String() })),
    }),
  ),
});
const WorkoutSchema = Type.Object({
  ...fitnessPayloadSchemas.fitness_workout.properties,
  id: AnyUuidSchema,
  fitness_space_id: AnyUuidSchema,
  sync_id: UuidSchema,
  revision: Type.Integer({ minimum: 1 }),
  deleted_at: nullableText,
});

/** 提供完整云端训练统计、按用户时区归档的日历及详情；不以当前列表页估算聚合。 */
export function registerFitnessStatisticsRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  for (const mode of ['statistics', 'calendar'] as const) {
    app.get(
      `/api/v1/fitness-spaces/:fitness_space_id/${mode}`,
      {
        ...secured,
        schema: {
          tags: ['fitness'],
          params: Type.Object({ fitness_space_id: AnyUuidSchema }),
          querystring: QuerySchema,
          response: { 200: mode === 'statistics' ? StatsSchema : CalendarSchema },
        },
      },
      async (request) =>
        execute(request, '读取健身统计与日历', async () => {
          const { userId } = requireAuth(request);
          const { fitness_space_id: id } = request.params as { fitness_space_id: string };
          const query = request.query as Query;
          const context = fitnessDateContext(query.start_date, query.end_date, query.time_zone ?? 'UTC');
          return prisma.$transaction(
            async (tx) => {
              const space = await tx.fitnessSpace.findFirst({ where: { id, ownerId: userId, deletedAt: null } });
              if (!space) throw new ApiError(404, 'FITNESS_SPACE_NOT_FOUND', '健身本不存在或无权访问');
              if (query.sync_id && query.sync_id !== space.syncId)
                throw new ApiError(412, 'SYNC_ID_MISMATCH', '健身本已重建，请重新载入');
              const rows = await tx.fitnessEntity.findMany({
                where: {
                  fitnessSpaceId: id,
                  deletedAt: null,
                  entityType: 'fitness_workout',
                  ...(mode === 'statistics' ? { status: 'completed' } : {}),
                },
              });
              const workouts = rows.map((row) => ({
                ...(row.payload as FitnessWorkoutPayload),
                id: row.id,
                revision: row.revision,
              }));
              if (mode === 'statistics') return summarizeFitness(workouts, context);
              const plans = await tx.fitnessEntity.findMany({
                where: { fitnessSpaceId: id, deletedAt: null, entityType: 'fitness_plan' },
              });
              return fitnessCalendar(
                workouts,
                plans.map((row) => ({ ...(row.payload as FitnessPlanPayload), id: row.id })),
                context,
              );
            },
            { isolationLevel: 'RepeatableRead' },
          );
        }),
    );
  }
  app.get(
    '/api/v1/fitness-spaces/:fitness_space_id/workouts/:workout_id',
    {
      ...secured,
      schema: {
        tags: ['fitness'],
        params: Type.Object({ fitness_space_id: AnyUuidSchema, workout_id: AnyUuidSchema }),
        querystring: Type.Object({ sync_id: Type.Optional(UuidSchema) }),
        response: { 200: WorkoutSchema },
      },
    },
    async (request) =>
      execute(request, '读取训练详情', async () => {
        const { userId } = requireAuth(request);
        const { fitness_space_id: id, workout_id: workoutId } = request.params as {
          fitness_space_id: string;
          workout_id: string;
        };
        const query = request.query as { sync_id?: string };
        return prisma.$transaction(
          async (tx) => {
            const space = await tx.fitnessSpace.findFirst({ where: { id, ownerId: userId, deletedAt: null } });
            if (!space) throw new ApiError(404, 'FITNESS_SPACE_NOT_FOUND', '健身本不存在或无权访问');
            if (query.sync_id && query.sync_id !== space.syncId)
              throw new ApiError(412, 'SYNC_ID_MISMATCH', '健身本已重建，请重新载入');
            const row = await tx.fitnessEntity.findFirst({
              where: { id: workoutId, fitnessSpaceId: id, entityType: 'fitness_workout', deletedAt: null },
            });
            if (!row) throw new ApiError(404, 'FITNESS_WORKOUT_NOT_FOUND', '训练不存在或已删除');
            return fitnessSnapshot(row, space);
          },
          { isolationLevel: 'RepeatableRead' },
        );
      }),
  );
}
