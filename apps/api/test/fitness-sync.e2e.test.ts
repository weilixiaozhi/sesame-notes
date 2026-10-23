import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
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
  it('官方副本来源可同步落库和完整读取，数据库拒绝非法来源', async () => {
    try {
      const session = await register();
      const origin = { source: 'official', item_id: randomUUID(), revision: 1 };
      const template = change('fitness_template', { ...fitnessTemplate(), catalog_origin: origin });
      const plan = change('fitness_plan', { ...fitnessPlan(), catalog_origin: origin });
      const result = await push(session, template, plan);
      expect(result.status).toBe(200);
      expect(result.body.outcomes.map((entry: { status: string }) => entry.status)).toEqual(['accepted', 'accepted']);
      const snapshot = await get(session);
      expect(snapshot.fitness_templates[0].catalog_origin).toEqual(origin);
      expect(snapshot.fitness_plans[0].catalog_origin).toEqual(origin);
      for (const invalid of [
        null,
        {},
        { ...origin, revision: 0 },
        { ...origin, revision: '1' },
        { ...origin, revision: 1.5 },
        { ...origin, source: 'other' },
        { ...origin, item_id: 'missing' },
        { ...origin, extra: true },
      ]) {
        const rows = await prisma.$queryRawUnsafe<Array<{ valid: boolean }>>(
          'SELECT fitness_payload_valid($1, $2::jsonb) AS valid',
          'fitness_template',
          JSON.stringify({ ...fitnessTemplate(), catalog_origin: invalid }),
        );
        expect(rows[0]!.valid).toBe(false);
      }
    } catch (error) {
      throw new Error('官方副本同步与数据库校验失败', { cause: error });
    }
  });
  it('默认热身休息随偏好创建与更新，数据库和完整快照保留包括零值的设置', async () => {
    try {
      const session = await register();
      const payload = { ...fitnessPreferences(), default_warmup_rest_seconds: 30 };
      const preference = change('fitness_preferences', payload, { entity_id: session.space_id });
      const created = await push(session, preference);
      expect(created.status).toBe(200);
      expect(created.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 1 });
      const first = await prisma.fitnessEntity.findUniqueOrThrow({ where: { id: session.space_id } });
      expect(first.payload).toEqual(payload);
      expect((await get(session)).fitness_preferences[0]).toMatchObject({
        default_warmup_rest_seconds: 30,
        revision: 1,
      });

      const updatedPayload = {
        ...payload,
        default_warmup_rest_seconds: 0,
        updated_at: '2026-09-11T01:03:03.789Z',
      };
      const updated = await push(session, {
        ...preference,
        mutation_id: randomUUID(),
        base_revision: 1,
        payload: updatedPayload,
      });
      expect(updated.status).toBe(200);
      expect(updated.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 2 });
      const second = await prisma.fitnessEntity.findUniqueOrThrow({ where: { id: session.space_id } });
      expect(second.payload).toEqual(updatedPayload);
      expect((await get(session)).fitness_preferences[0]).toMatchObject({
        default_warmup_rest_seconds: 0,
        revision: 2,
      });
    } catch (cause) {
      throw new Error('健身默认热身休息同步回归失败', { cause });
    }
  });

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

  it('删除计划保留全部训练及迟到同步的已生成记录', async () => {
    const session = await register();
    const plan = change('fitness_plan', fitnessPlan());
    const otherPlan = change('fitness_plan', fitnessPlan());
    const own = plannedWorkout(plan.entity_id, randomUUID());
    const other = plannedWorkout(otherPlan.entity_id, randomUUID());
    const template = change('fitness_template', fitnessTemplate());
    const independent = change('fitness_workout', fitnessWorkout());
    const created = await push(
      session,
      plan,
      otherPlan,
      template,
      independent,
      change('fitness_workout', own.payload, { entity_id: own.id }),
      change('fitness_workout', other.payload, { entity_id: other.id }),
    );
    const completed = {
      ...own.payload,
      status: 'completed',
      run_segments: [{ started_at: fitnessTime, ended_at: fitnessTime }],
    };
    expect(
      (
        await push(
          session,
          change('fitness_workout', completed, {
            entity_id: own.id,
            sync_id: created.body.outcomes[4].sync_id,
            base_revision: 1,
          }),
        )
      ).body.outcomes[0].status,
    ).toBe('accepted');
    const closed = {
      ...plan,
      mutation_id: randomUUID(),
      sync_id: created.body.outcomes[0].sync_id,
      base_revision: 1,
      payload: { ...plan.payload, status: 'closed' },
    };
    expect((await push(session, closed)).body.outcomes[0].status).toBe('accepted');
    expect(
      (await get(session)).fitness_workouts.find((row: { id: string }) => row.id === own.id).deleted_at,
    ).toBeNull();
    const configured = {
      ...closed,
      mutation_id: randomUUID(),
      base_revision: 2,
      payload: { ...closed.payload, start_date: '2026-09-15' },
    };
    expect((await push(session, configured)).body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 3 });
    const stored = (await get(session)).fitness_plans.find((row: { id: string }) => row.id === plan.entity_id);
    expect(stored.status).toBe('closed');
    expect(stored.generation_state).toEqual(plan.payload.generation_state);
    const before = (await get(session)).fitness_workouts;
    const deletion = { ...configured, mutation_id: randomUUID(), base_revision: 3, action: 'delete', payload: {} };
    expect((await push(session, deletion)).body.outcomes[0].status).toBe('accepted');
    expect((await push(session, deletion)).body.outcomes[0].status).toBe('ignored');
    const late = plannedWorkout(plan.entity_id, randomUUID());
    const lateRequest = change('fitness_workout', late.payload, { entity_id: late.id });
    expect((await push(session, lateRequest)).body.outcomes[0].status).toBe('accepted');
    const full = await get(session);
    expect(full.fitness_workouts.find((row: { id: string }) => row.id === own.id).deleted_at).toBeNull();
    expect(full.fitness_workouts.find((row: { id: string }) => row.id === late.id).deleted_at).toBeNull();
    expect(full.fitness_workouts.find((row: { id: string }) => row.id === other.id).deleted_at).toBeNull();
    expect(full.fitness_workouts.find((row: { id: string }) => row.id === independent.entity_id).deleted_at).toBeNull();
    expect(full.fitness_templates[0].deleted_at).toBeNull();
    const events = (await get(session, 'pull?since=0&limit=100')).changes;
    expect(
      events.filter(
        (event: { entity_id: string; action: string }) => event.entity_id === own.id && event.action === 'delete',
      ),
    ).toHaveLength(0);
    expect(events.find((event: { entity_id: string; action: string }) => event.entity_id === late.id).action).toBe(
      'upsert',
    );
    for (const workout of before) {
      expect(full.fitness_workouts.find((row: { id: string }) => row.id === workout.id)).toEqual(workout);
    }
  });
  it('数据库只接受每日单项或休息，拒绝当前和待生效周期的旧列表', async () => {
    const plan = fitnessPlan();
    const slot = plan.days[0]!.slot!;
    const valid = [plan, { ...plan, pending_schedule: { cycle_days: 2, days: plan.days } }];
    const invalid = [];
    for (const day of [
      { day_index: 0, slots: [slot, { ...slot, id: randomUUID() }] },
      { day_index: 0, slot: [slot] },
      { day_index: 0 },
    ]) {
      const schedule = { cycle_days: 2, days: [day, plan.days[1]!] };
      invalid.push({ ...plan, ...schedule }, { ...plan, pending_schedule: schedule });
    }
    for (const [payloads, expected] of [
      [valid, true],
      [invalid, false],
    ] as const) {
      for (const payload of payloads) {
        const [result] = await prisma.$queryRaw<Array<{ valid: boolean }>>`
          SELECT fitness_payload_valid('fitness_plan', ${JSON.stringify(payload)}::jsonb) AS valid
        `;
        expect(result?.valid).toBe(expected);
      }
    }
  });
  it('同步和数据库都拒绝改期及已删除字段', async () => {
    const session = await register();
    const request = change('fitness_workout', fitnessWorkout());
    const created = (await push(session, request)).body.outcomes[0];
    expect(created.status).toBe('accepted');
    const changed = { ...request.payload, scheduled_date: '2026-09-12' };
    const updated = await push(session, {
      ...request,
      mutation_id: randomUUID(),
      sync_id: created.sync_id,
      base_revision: 1,
      payload: changed,
    });
    expect(updated.body.outcomes[0].status).toBe('invalid');
    await expect(
      prisma.fitnessEntity.update({
        where: { id: request.entity_id },
        data: {
          payload: changed as Prisma.InputJsonObject,
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow();
    expect((await get(session)).fitness_workouts[0].scheduled_date).toBe('2026-09-11');
    for (const [type, payload] of [
      ['fitness_template', { ...fitnessTemplate(), sort_order: 0 }],
      ['fitness_preferences', { ...fitnessPreferences(), favorite_plan_ids: [] }],
    ] as const) {
      const [result] = await prisma.$queryRaw<
        Array<{ valid: boolean }>
      >`SELECT fitness_payload_valid(${type}::text, ${JSON.stringify(payload)}::jsonb) AS valid`;
      expect(result?.valid).toBe(false);
    }
  });
  it('逐组实际休息完整推送拉取，数据库拒绝未完成组历史和错误计时关联', async () => {
    const session = await register();
    const exercise = fitnessExercise(true);
    const set = { ...exercise.sets[0]!, rest_durations_seconds: [17, 42] };
    const payload = {
      ...fitnessWorkout(),
      status: 'in_progress',
      run_segments: [{ started_at: fitnessTime, ended_at: null }],
      exercises: [{ ...exercise, sets: [set] }],
      rest_timer: {
        status: 'paused',
        ends_at: null,
        duration_seconds: 90,
        remaining_seconds: 30,
        elapsed_seconds: 12,
        exercise_id: exercise.id,
        set_id: set.id,
      },
    };
    expect((await push(session, change('fitness_workout', payload))).body.outcomes[0].status).toBe('accepted');
    const full = await get(session);
    expect(full.fitness_workouts[0].exercises).toEqual(payload.exercises);
    expect(full.fitness_workouts[0].rest_timer).toEqual(payload.rest_timer);
    for (const invalid of [
      { ...payload, exercises: [{ ...exercise, sets: [{ ...set, completed: false }] }] },
      { ...payload, exercises: [{ ...exercise, sets: [{ ...set, rest_durations_seconds: [-1] }] }] },
      { ...payload, rest_timer: { ...payload.rest_timer, set_id: exercise.id } },
    ]) {
      const result = await prisma.$queryRaw<Array<{ valid: boolean }>>`
        SELECT fitness_payload_valid('fitness_workout', ${JSON.stringify(invalid)}::jsonb) AS valid
      `;
      expect(result[0]!.valid).toBe(false);
    }
  });
  it('左右重量按动作分流，数据库拒绝混合口径、单边值与非法偏好标识', async () => {
    const session = await register();
    const exercise = fitnessExercise(true);
    const side = { ...exercise.sets[0]!, weight: null, weight_left: '5', weight_right: '6.25' };
    const payload = {
      ...fitnessWorkout(),
      status: 'completed',
      run_segments: [{ started_at: fitnessTime, ended_at: fitnessTime }],
      exercises: [{ ...exercise, sets: [side] }],
    };
    expect((await push(session, change('fitness_workout', payload))).body.outcomes[0].status).toBe('accepted');
    const full = await get(session);
    expect(full.fitness_workouts[0].exercises).toEqual(payload.exercises);
    for (const invalid of [
      // 总重与左右重量同时存在
      { ...payload, exercises: [{ ...exercise, sets: [{ ...side, weight: '11' }] }] },
      // 只填单边
      { ...payload, exercises: [{ ...exercise, sets: [{ ...side, weight_right: null }] }] },
      { ...payload, exercises: [{ ...exercise, sets: [{ ...side, weight_left: null }] }] },
      // 左右重量必须各自满足 decimal 契约
      { ...payload, exercises: [{ ...exercise, sets: [{ ...side, weight_left: '5.' }] }] },
      { ...payload, exercises: [{ ...exercise, sets: [{ ...side, weight_left: 5 }] }] },
    ]) {
      const result = await prisma.$queryRaw<Array<{ valid: boolean }>>`
        SELECT fitness_payload_valid('fitness_workout', ${JSON.stringify(invalid)}::jsonb) AS valid
      `;
      expect(result[0]!.valid).toBe(false);
    }
    // 编辑中的草稿允许只填单边重量
    const draft = {
      ...payload,
      status: 'in_progress',
      run_segments: [{ started_at: fitnessTime, ended_at: null }],
      exercises: [{ ...exercise, sets: [{ ...side, completed: false, weight_right: null }] }],
    };
    const [draftRow] = await prisma.$queryRaw<Array<{ valid: boolean }>>`
      SELECT fitness_payload_valid('fitness_workout', ${JSON.stringify(draft)}::jsonb) AS valid
    `;
    expect(draftRow?.valid).toBe(true);
    const preferencesValid = async (modes: unknown): Promise<boolean> => {
      const [row] = await prisma.$queryRaw<Array<{ valid: boolean }>>`
        SELECT fitness_payload_valid('fitness_preferences', ${JSON.stringify({
          ...fitnessPreferences(),
          exercise_weight_modes: modes,
        })}::jsonb) AS valid
      `;
      return row?.valid === true;
    };
    expect(await preferencesValid({})).toBe(true);
    expect(await preferencesValid({ '0025': true, 'custom:11111111-1111-4111-8111-111111111111': false })).toBe(true);
    for (const modes of [
      ['0025'],
      { '0025': 'true' },
      { '0025': 1 },
      { '': true },
      { ['x'.repeat(129)]: true },
      null,
    ]) {
      expect(await preferencesValid(modes)).toBe(false);
    }
  });
  it('可空开始日期、关闭及重新选日期的周期快照在数据库和同步端一致', async () => {
    const session = await register();
    const plan = fitnessPlan();
    const request = change('fitness_plan', {
      ...plan,
      start_date: null,
      status: 'closed',
      generation_state: { next_cycle_start_date: null, next_cycle_index: 0, generated_cycles: [] },
    });
    const created = (await push(session, request)).body.outcomes[0];
    expect(created.status).toBe('accepted');
    const active = { ...request, mutation_id: randomUUID(), sync_id: created.sync_id, base_revision: 1, payload: plan };
    expect((await push(session, active)).body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 2 });
    expect(
      (
        await push(session, {
          ...active,
          mutation_id: randomUUID(),
          base_revision: 2,
          payload: { ...plan, status: 'closed' },
        })
      ).body.outcomes[0],
    ).toMatchObject({ status: 'accepted', revision: 3 });
    const restarted = {
      ...plan,
      start_date: '2026-09-12',
      generation_state: {
        next_cycle_start_date: '2026-09-14',
        next_cycle_index: 2,
        generated_cycles: [
          ...plan.generation_state.generated_cycles,
          {
            cycle_index: 1,
            start_date: '2026-09-12',
            cycle_days: 2,
            generated_from_date: '2026-09-12',
            rest_dates: ['2026-09-13'],
          },
        ],
      },
    };
    expect(
      (await push(session, { ...active, mutation_id: randomUUID(), base_revision: 3, payload: restarted })).body
        .outcomes[0],
    ).toMatchObject({ status: 'accepted', revision: 4 });
    const full = await get(session);
    expect(full.fitness_plans[0].start_date).toBe('2026-09-12');
    expect(full.fitness_plans[0].generation_state).toEqual(restarted.generation_state);
    await expect(
      prisma.fitnessEntity.update({
        where: { id: request.entity_id },
        data: { payload: { ...restarted, start_date: null } },
      }),
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
  it('四实体完整快照、空组、空训练、账号隔离、分页面水位', async () => {
    const owner = await register();
    const stranger = await register();
    const template = fitnessTemplate();
    template.exercises[0]!.sets = [];
    const requests = [
      change('fitness_template', template),
      change('fitness_plan', fitnessPlan()),
      change('fitness_workout', fitnessWorkout()),
      change('fitness_preferences', fitnessPreferences(), { entity_id: owner.space_id }),
    ];
    const pushed = await push(owner, ...requests);
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body.outcomes.map((item: { status: string }) => item.status)).toEqual(
      Array.from({ length: 4 }).fill('accepted'),
    );
    const full = await get(owner);
    expect(full.fitness_templates[0].exercises[0].sets).toEqual([]);
    expect(full.fitness_workouts[0].exercises).toEqual([]);
    expect(full.fitness_preferences[0].id).toBe(owner.space_id);
    const foreign = await get(stranger);
    for (const key of ['fitness_templates', 'fitness_plans', 'fitness_workouts', 'fitness_preferences'])
      expect(foreign[key]).toEqual([]);
    const attempted = await push(stranger, requests[0]!);
    expect(attempted.body.outcomes[0]).toMatchObject({ status: 'invalid' });
    expect(attempted.body.outcomes[0].current_entity).toBeUndefined();
    const first = await get(owner, 'pull?since=0&limit=2');
    expect(first.has_more).toBe(true);
    const second = await get(owner, `pull?since=${first.server_cursor}&limit=100`);
    const ids = [...first.changes, ...second.changes]
      .filter((item) => item.entity_type.startsWith('fitness_'))
      .map((item) => item.entity_id);
    expect(new Set(ids)).toEqual(new Set(requests.map((request) => request.entity_id)));
    expect(
      (await get(stranger, 'pull?since=0')).changes.filter((item: { entity_type: string }) =>
        item.entity_type.startsWith('fitness_'),
      ),
    ).toEqual([]);
  });

  it('精确幂等、CAS竞争、身份失配、删除墓碑与同一mutation禁止变更载荷', async () => {
    const session = await register();
    const create = change('fitness_template', fitnessTemplate());
    const initial = (await push(session, create)).body.outcomes[0];
    expect(initial.status).toBe('accepted');
    const updates = [1, 2].map((suffix) => ({
      ...create,
      mutation_id: randomUUID(),
      sync_id: initial.sync_id,
      base_revision: 1,
      payload: { ...create.payload, name: `改名${suffix}` },
    }));
    const concurrent = await Promise.all(updates.map((update) => push(session, update)));
    expect(concurrent.map((response) => response.body.outcomes[0].status).sort()).toEqual(['accepted', 'conflict']);
    const replay = (await push(session, create)).body.outcomes[0];
    expect(replay).toMatchObject({
      status: 'ignored',
      revision: 1,
      change_id: initial.change_id,
      sync_id: initial.sync_id,
    });
    expect((await push(session, { ...create, payload: { ...create.payload, name: '复用身份' } })).status).toBe(409);
    expect(
      (await push(session, { ...updates[0], mutation_id: randomUUID(), sync_id: randomUUID(), base_revision: 2 }))
        .status,
    ).toBe(412);
    const deleted = await push(session, {
      ...create,
      mutation_id: randomUUID(),
      action: 'delete',
      payload: {},
      sync_id: initial.sync_id,
      base_revision: 2,
    });
    expect(deleted.body.outcomes[0]).toMatchObject({ status: 'accepted', revision: 3 });
    expect((await get(session)).fitness_templates[0].deleted_at).not.toBeNull();
    const revive = await push(session, {
      ...create,
      mutation_id: randomUUID(),
      sync_id: initial.sync_id,
      base_revision: 3,
    });
    expect(revive.body.outcomes[0]).toMatchObject({ status: 'conflict', current_deleted: true, current_revision: 3 });
    const missingDelete = await push(session, change('fitness_template', {}, { action: 'delete' }));
    expect(missingDelete.body.outcomes[0]).toMatchObject({ status: 'conflict', current_revision: 0 });
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

  it('拒绝原始载荷隐式类型转换/备注/无效动作标识；单条invalid不阻塞后续', async () => {
    const session = await register();
    const invalid = change('fitness_template', {
      ...fitnessTemplate(),
      exercises: [{ ...fitnessExercise(), exercise_id: 'custom-action' }],
    });
    const good = change('fitness_workout', fitnessWorkout());
    const result = await push(session, invalid, good);
    expect(result.body.outcomes.map((item: { status: string }) => item.status)).toEqual(['invalid', 'accepted']);
    const badWeight = await push(
      session,
      change('fitness_template', {
        ...fitnessTemplate(),
        exercises: [{ ...fitnessExercise(), sets: [{ ...fitnessExercise().sets[0], weight: 70 }] }],
      }),
    );
    expect(badWeight.body.outcomes[0].status).toBe('invalid');
    const note = await push(session, change('fitness_workout', { ...fitnessWorkout(), notes: '不支持备注' }));
    expect(note.body.outcomes[0].status).toBe('invalid');
    for (const name of ['\uD800', '\u200B\u2060', '\u0000', '\u0001\u001F']) {
      const invalidName = await push(session, change('fitness_workout', { ...fitnessWorkout(), name }));
      expect(invalidName.status).toBe(200);
      expect(invalidName.body.outcomes[0].status).toBe('invalid');
    }
    expect((await get(session)).fitness_workouts).toHaveLength(1);
  });

  it('数据库直接写也拒绝口径、空模板名、伪造进行中与账号/来源变更', async () => {
    const owner = await register();
    const stranger = await register();
    const request = change('fitness_workout', {
      ...fitnessWorkout(),
      status: 'in_progress',
      run_segments: [{ started_at: fitnessTime, ended_at: null }],
    });
    expect((await push(owner, request)).body.outcomes[0].status).toBe('accepted');
    const row = await prisma.fitnessEntity.findUniqueOrThrow({ where: { id: request.entity_id } });
    await expect(
      prisma.fitnessEntity.create({
        data: { ...row, payload: request.payload as Prisma.InputJsonObject, id: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.fitnessEntity.update({ where: { id: row.id }, data: { fitnessSpaceId: stranger.space_id } }),
    ).rejects.toThrow();
    await expect(
      prisma.fitnessEntity.update({
        where: { id: row.id },
        data: { payload: { ...request.payload, run_segments: [] } },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.fitnessEntity.create({
        data: {
          id: randomUUID(),
          fitnessSpaceId: owner.space_id,
          entityType: 'fitness_template',
          createdAt: new Date(fitnessTime),
          updatedAt: new Date(fitnessTime),
          payload: { ...fitnessTemplate(), name: '' },
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.fitnessEntity.update({ where: { id: row.id }, data: { status: 'completed' } }),
    ).rejects.toThrow();
  });
});
