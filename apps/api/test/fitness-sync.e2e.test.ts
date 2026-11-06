import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import {
  fitnessExercise,
  fitnessPlan,
  fitnessPreferences,
  fitnessTemplate,
  fitnessTime,
  fitnessWorkout,
  plannedWorkout,
} from './fitness-fixtures.js';

const databaseUrl = testFixtureDatabaseUrl();
const config: ApiConfig = {
  databaseUrl,
  jwtSecret: 'fitness-test-secret-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2592000,
  storagePath: testStoragePath('fitness-sync'),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({ logger: false, config, prisma });
type Session = { access_token: string; device_id: string; user_id: string; space_id: string; space_sync_id: string };
beforeAll(() => app.ready());
afterAll(() => app.close());

async function register(): Promise<Session> {
  const result = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `139${randomInt(100_000_000).toString().padStart(8, '0')}`,
      password: 'fitness-test-password',
      device: { installation_id: randomUUID(), name: 'fitness-test', platform: 'test' },
    },
  });
  expect(result.statusCode).toBe(201);
  const session = result.json();
  const device = await prisma.device.findUniqueOrThrow({ where: { id: session.device_id } });
  const space = await prisma.fitnessSpace.create({
    data: {
      id: randomUUID(),
      ownerId: device.userId,
      name: '我的健身',
      createdAt: new Date(fitnessTime),
      updatedAt: new Date(fitnessTime),
    },
  });
  return { ...session, user_id: device.userId, space_id: space.id, space_sync_id: space.syncId };
}
function change(type: string, payload: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  return {
    mutation_id: randomUUID(),
    entity_type: type,
    entity_id: randomUUID(),
    ledger_id: null,
    day_book_id: null,
    memo_book_id: null,
    action: 'upsert',
    updated_at: fitnessTime,
    payload,
    ...extras,
  };
}
async function push(session: Session, ...changes: Record<string, unknown>[]) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/sync/push',
    headers: { authorization: `Bearer ${session.access_token}` },
    payload: {
      device_id: session.device_id,
      changes: changes.map((value) => ({
        fitness_space_id: session.space_id,
        sync_id: session.space_sync_id,
        ...value,
      })),
    },
  });
  return { status: response.statusCode, body: response.json() };
}
async function get(session: Session, suffix = `fitness-spaces/full?fitness_space_id=${session.space_id}`) {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/sync/${suffix}`,
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('个人健身真实 PostgreSQL 同步', () => {
  it('自定义动作随空间同步，编辑删除保留训练引用，数据库检查首版字段', async () => {
    const session = await register();
    const custom = {
      id: `custom:${randomUUID()}`,
      name: '自定义划船',
      body_part: 'back',
      equipment: 'dumbbell',
      icon: 'dumbbell',
      image: 'aGVsbG8=',
      deleted: false,
    };
    const payload = { ...fitnessPreferences(), custom_exercises: [custom] };
    const preference = change('fitness_preferences', payload, { entity_id: session.space_id });
    expect((await push(session, preference)).body.outcomes[0].status).toBe('accepted');
    const template = fitnessTemplate();
    template.exercises[0]!.exercise_id = custom.id;
    expect((await push(session, change('fitness_template', template))).body.outcomes[0].status).toBe('accepted');
    const full = await get(session);
    expect(full.fitness_preferences[0].custom_exercises).toEqual([custom]);
    const deleted = { ...payload, custom_exercises: [{ ...custom, name: '单臂划船', deleted: true }] };
    expect(
      (await push(session, { ...preference, mutation_id: randomUUID(), base_revision: 1, payload: deleted })).body
        .outcomes[0].status,
    ).toBe('accepted');
    const after = await get(session);
    expect(after.fitness_preferences[0].custom_exercises[0]).toMatchObject({ name: '单臂划船', deleted: true });
    expect(after.fitness_templates[0].exercises[0].exercise_id).toBe(custom.id);
    await expect(
      prisma.fitnessEntity.update({
        where: { id: session.space_id },
        data: { payload: { ...payload, custom_exercises: [{ ...custom, name: '' }] } },
      }),
    ).rejects.toThrow();
  });

  it('空间是独立父本：目录账号隔离、父绑定校验、多空间运行与条件删除', async () => {
    const session = await register();
    const stranger = await register();
    const id = randomUUID();
    const create = change(
      'fitness_space',
      { name: '第二空间', created_at: fitnessTime, updated_at: fitnessTime },
      { entity_id: id, fitness_space_id: id, sync_id: undefined },
    );
    const created = (await push(session, create)).body.outcomes[0];
    expect(created.status).toBe('accepted');
    expect((await push(session, create)).body.outcomes[0].status).toBe('ignored');
    const scope = { fitness_space_id: id, sync_id: created.sync_id };
    const running = {
      ...fitnessWorkout(),
      status: 'in_progress',
      run_segments: [{ started_at: fitnessTime, ended_at: null }],
    };
    expect((await push(session, change('fitness_workout', running))).body.outcomes[0].status).toBe('accepted');
    const inSecond = change('fitness_workout', running, scope);
    expect((await push(session, inSecond)).body.outcomes[0].status).toBe('accepted');
    expect((await push(stranger, change('fitness_workout', fitnessWorkout(), scope))).body.outcomes[0].status).toBe(
      'invalid',
    );
    expect(
      (await get(session, 'fitness-spaces')).fitness_spaces.map((space: { id: string }) => space.id).sort(),
    ).toEqual([session.space_id, id].sort());
    expect((await get(stranger, 'fitness-spaces')).fitness_spaces.map((space: { id: string }) => space.id)).toEqual([
      stranger.space_id,
    ]);
    const full = await get(session, `fitness-spaces/full?fitness_space_id=${id}`);
    expect(full.fitness_workouts.map((workout: { id: string }) => workout.id)).toEqual([inSecond.entity_id]);
    const preferences = change('fitness_preferences', fitnessPreferences(), { ...scope, entity_id: id });
    expect((await push(session, preferences)).body.outcomes[0].status).toBe('accepted');
    const remove = change(
      'fitness_space',
      { expected_full_cursor: full.server_cursor },
      { ...scope, entity_id: id, base_revision: 1, action: 'delete' },
    );
    expect((await push(session, remove)).body.outcomes[0].status).toBe('invalid');
    const fresh = await get(session, `fitness-spaces/full?fitness_space_id=${id}`);
    expect(
      (
        await push(session, {
          ...remove,
          mutation_id: randomUUID(),
          payload: { expected_full_cursor: fresh.server_cursor },
        })
      ).body.outcomes[0].status,
    ).toBe('accepted');
    expect((await get(session)).fitness_workouts).toHaveLength(1);
    expect((await get(session, 'fitness-spaces')).fitness_spaces.map((space: { id: string }) => space.id)).toEqual([
      session.space_id,
    ]);
  });

  it('空间恢复建立新绑定，旧子请求与跨空间引用被拒绝', async () => {
    const session = await register();
    const template = change('fitness_template', fitnessTemplate());
    expect((await push(session, template)).body.outcomes[0].status).toBe('accepted');
    const full = await get(session);
    const restore = change(
      'fitness_space',
      {
        name: '恢复空间',
        created_at: fitnessTime,
        updated_at: fitnessTime,
        restore: true,
        expected_full_cursor: full.server_cursor,
      },
      { entity_id: session.space_id, base_revision: 1 },
    );
    const result = (await push(session, restore)).body.outcomes[0];
    expect(result.status).toBe('accepted');
    expect(result.sync_id).not.toBe(session.space_sync_id);
    expect((await push(session, change('fitness_template', fitnessTemplate()))).status).toBe(412);
    session.space_sync_id = result.sync_id;
    const replacement = change('fitness_template', fitnessTemplate());
    expect((await push(session, replacement)).body.outcomes[0].status).toBe('accepted');
    const other = await prisma.fitnessSpace.create({
      data: {
        id: randomUUID(),
        ownerId: session.user_id,
        name: '独立空间',
        createdAt: new Date(fitnessTime),
        updatedAt: new Date(fitnessTime),
      },
    });
    const cross = change(
      'fitness_workout',
      { ...fitnessWorkout(), source_kind: 'template', source_template_id: replacement.entity_id },
      { fitness_space_id: other.id, sync_id: other.syncId },
    );
    expect((await push(session, cross)).body.outcomes[0].status).toBe('invalid');
    await expect(
      prisma.fitnessSpace.update({ where: { id: other.id }, data: { ownerId: (await register()).user_id } }),
    ).rejects.toThrow();
  });
  it('计划暂停和待生效编辑保留生成事实，JSONB键顺序不造成假冲突', async () => {
    const session = await register();
    const payload = fitnessPlan();
    const request = change('fitness_plan', payload);
    const created = (await push(session, request)).body.outcomes[0];
    expect(created.status).toBe('accepted');
    const paused = {
      ...request,
      mutation_id: randomUUID(),
      sync_id: created.sync_id,
      base_revision: 1,
      payload: { ...payload, status: 'closed' },
    };
    expect((await push(session, paused)).body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 2 });
    const edited = {
      ...paused,
      mutation_id: randomUUID(),
      base_revision: 2,
      payload: { ...payload, pending_schedule: { cycle_days: payload.cycle_days, days: payload.days } },
    };
    expect((await push(session, edited)).body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 3 });
    const invalid = {
      ...edited,
      mutation_id: randomUUID(),
      base_revision: 3,
      payload: { ...edited.payload, generation_state: { ...payload.generation_state, generated_cycles: [] } },
    };
    expect((await push(session, invalid)).body.outcomes[0].status).toBe('invalid');
    const full = await get(session);
    expect(full.fitness_plans[0].generation_state).toEqual(payload.generation_state);
    expect(full.fitness_plans[0].pending_schedule).toEqual(edited.payload.pending_schedule);
  });

  it('删除来源保留已生成训练，单独删除训练后不复活', async () => {
    const session = await register();
    const template = change('fitness_template', fitnessTemplate());
    const plan = change('fitness_plan', fitnessPlan());
    const workout = plannedWorkout(plan.entity_id, randomUUID());
    const workoutChange = change('fitness_workout', workout.payload, { entity_id: workout.id });
    const created = await push(session, template, plan, workoutChange);
    expect(created.body.outcomes.map((item: { status: string }) => item.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
    ]);
    for (const [index, request] of [template, plan].entries()) {
      const outcome = created.body.outcomes[index];
      expect(
        (
          await push(session, {
            ...request,
            action: 'delete',
            mutation_id: randomUUID(),
            payload: {},
            sync_id: outcome.sync_id,
            base_revision: 1,
          })
        ).body.outcomes[0].status,
      ).toBe('accepted');
    }
    const full = await get(session);
    expect(full.fitness_workouts[0]).toMatchObject(workout.payload);
    expect(full.fitness_workouts[0].deleted_at).toBeNull();
    expect(full.fitness_plans[0].generation_state.generated_cycles[0].rest_dates).toEqual(['2026-09-12']);
    const duplicate = await push(session, {
      ...workoutChange,
      mutation_id: randomUUID(),
      sync_id: created.body.outcomes[2].sync_id,
    });
    expect(duplicate.body.outcomes[0].status).toBe('conflict');
    const otherDeviceCreate = await push(session, { ...workoutChange, mutation_id: randomUUID() });
    expect(otherDeviceCreate.body.outcomes[0]).toMatchObject({
      status: 'conflict',
      current_revision: 1,
      current_entity: { id: workout.id, sync_id: created.body.outcomes[2].sync_id },
    });
    await push(session, {
      ...workoutChange,
      mutation_id: randomUUID(),
      action: 'delete',
      payload: {},
      base_revision: 1,
      sync_id: created.body.outcomes[2].sync_id,
    });
    expect(
      (
        await push(session, {
          ...workoutChange,
          mutation_id: randomUUID(),
          base_revision: 2,
          sync_id: created.body.outcomes[2].sync_id,
        })
      ).body.outcomes[0],
    ).toMatchObject({ status: 'conflict', current_deleted: true });
    expect(
      (await push(session, { ...workoutChange, entity_id: randomUUID(), mutation_id: randomUUID() })).body.outcomes[0]
        .status,
    ).toBe('invalid');
  });

  it('多端仅一场进行中；跨场冲突不修改自身CAS或任一分支，结束/重开仍同一记录', async () => {
    const session = await register();
    const running = {
      ...fitnessWorkout(),
      status: 'in_progress',
      exercises: [fitnessExercise(false)],
      run_segments: [{ started_at: fitnessTime, ended_at: null }],
    };
    const first = change('fitness_workout', running);
    const second = change('fitness_workout', { ...running, name: '另一场' });
    const one = (await push(session, first)).body.outcomes[0];
    expect(one.status).toBe('accepted');
    const two = (await push(session, second)).body.outcomes[0];
    expect(two).toMatchObject({
      status: 'conflict',
      current_revision: 0,
      current_entity: null,
      blocking_entity: { id: first.entity_id, revision: 1 },
    });
    expect((await get(session)).fitness_workouts).toHaveLength(1);
    const ended = {
      ...first,
      mutation_id: randomUUID(),
      sync_id: one.sync_id,
      base_revision: 1,
      payload: {
        ...running,
        status: 'completed',
        run_segments: [{ started_at: fitnessTime, ended_at: '2026-09-11T01:12:03.789Z' }],
      },
    };
    expect((await push(session, ended)).body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 2 });
    const restart = {
      ...ended,
      mutation_id: randomUUID(),
      base_revision: 2,
      payload: {
        ...ended.payload,
        status: 'in_progress',
        run_segments: [...ended.payload.run_segments, { started_at: '2026-09-11T02:00:00.000Z', ended_at: null }],
      },
    };
    expect((await push(session, restart)).body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 3 });
    const full = await get(session);
    expect(full.fitness_workouts).toHaveLength(1);
    expect(full.fitness_workouts[0].run_segments).toEqual(restart.payload.run_segments);
    expect(full.fitness_workouts[0].exercises[0].sets[0].completed).toBe(false);
  });

  it('首次上云完整墓碑不占用进行中名额，不丢失occurrence且重试不复活', async () => {
    const session = await register();
    const running = {
      ...fitnessWorkout(),
      status: 'in_progress',
      run_segments: [{ started_at: fitnessTime, ended_at: null }],
    };
    expect((await push(session, change('fitness_workout', running))).body.outcomes[0].status).toBe('accepted');
    const planned = plannedWorkout(randomUUID(), randomUUID());
    const tombstone = change(
      'fitness_workout',
      { ...planned.payload, status: 'in_progress', run_segments: running.run_segments },
      { entity_id: planned.id, deleted_at: fitnessTime },
    );
    const saved = (await push(session, tombstone)).body.outcomes[0];
    expect(saved.status).toBe('accepted');
    expect((await push(session, tombstone)).body.outcomes[0].status).toBe('ignored');
    const row = (await get(session)).fitness_workouts.find((item: { id: string }) => item.id === planned.id);
    expect(row).toMatchObject({
      deleted_at: fitnessTime,
      status: 'in_progress',
      occurrence_key: planned.payload.occurrence_key,
    });
    const event = await prisma.syncChange.findUniqueOrThrow({
      where: { deviceId_mutationId: { deviceId: session.device_id, mutationId: tombstone.mutation_id } },
    });
    expect(event.action).toBe('delete');
    const activePreferences = change('fitness_preferences', fitnessPreferences(), { entity_id: session.space_id });
    const historicalPreferences = change('fitness_preferences', fitnessPreferences(), { deleted_at: fitnessTime });
    const preferences = await push(session, activePreferences, historicalPreferences);
    expect(preferences.body.outcomes.map((item: { status: string }) => item.status)).toEqual(['accepted', 'invalid']);
    expect((await get(session)).fitness_preferences).toHaveLength(1);
    expect((await push(session, change('fitness_preferences', fitnessPreferences()))).body.outcomes[0].status).toBe(
      'invalid',
    );
  });
});
