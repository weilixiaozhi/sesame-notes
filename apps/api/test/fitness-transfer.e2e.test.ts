import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import {
  fitnessTemplate,
  fitnessPlan,
  fitnessPreferences,
  fitnessWorkout,
  fitnessTime,
  plannedWorkout,
} from './fitness-fixtures.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  prisma,
  logger: false,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'fitness-transfer-test-only-secret-32-bytes',
      STORAGE_PATH: '.fitness-transfer-test-storage',
    }),
    authRateLimitMax: 10000,
    rateLimitMax: 10000,
  },
});
beforeAll(() => app.ready());
afterAll(() => app.close());
/** 为导入联调创建独立测试账号和健身本。 */
async function account() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `139${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'fitness-tests-only',
      device: { installation_id: randomUUID(), name: 'Fitness transfer test', platform: 'web' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const actor = response.json<{ access_token: string; user: { user_id: string } }>();
  const space = await prisma.fitnessSpace.create({
    data: {
      id: randomUUID(),
      ownerId: actor.user.user_id,
      name: '导入测试',
      createdAt: new Date(fitnessTime),
      updatedAt: new Date(fitnessTime),
    },
  });
  return { ...actor, space };
}
/** 经真实 HTTP 写入和读取，不绕过接口鉴权或事务。 */
function api(
  actor: { access_token: string; space: { id: string } },
  method: 'GET' | 'POST',
  action: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url: `/api/v1/fitness-spaces/${actor.space.id}/${action}`,
    headers: { authorization: `Bearer ${actor.access_token}` },
    ...(payload ? { payload } : {}),
  });
}
/** 构造含自定义动作、模板、计划和计划训练的真实文件业务记录。 */
function document() {
  const custom = `custom:${randomUUID()}`;
  const preferences = {
    ...fitnessPreferences(),
    custom_exercises: [
      {
        id: custom,
        name: '自定义推举',
        body_part: 'chest',
        equipment: 'dumbbell',
        icon: 'Dumbbell',
        image: null,
        deleted: false,
      },
    ],
    pinned_exercise_ids: [custom],
    exercise_weight_modes: { [custom]: true },
  };
  const template = fitnessTemplate();
  template.exercises[0]!.exercise_id = custom;
  const templateId = randomUUID();
  const planId = randomUUID();
  const plan = fitnessPlan();
  const slot = plan.days[0]!.slot!;
  slot.source_template_id = templateId as never;
  slot.exercises = template.exercises;
  const workout = plannedWorkout(planId, slot.id);
  workout.payload.source_template_id = templateId as never;
  workout.payload.exercises = template.exercises.map((exercise) => ({
    ...exercise,
    sets: exercise.sets.map((set) => ({ ...set, completed: false })),
  })) as never;
  return {
    export_id: randomUUID(),
    custom,
    records: [
      { id: randomUUID(), entity_type: 'fitness_preferences', payload: preferences },
      { id: templateId, entity_type: 'fitness_template', payload: template },
      { id: planId, entity_type: 'fitness_plan', payload: plan },
      { id: workout.id, entity_type: 'fitness_workout', payload: workout.payload },
    ],
  };
}
it('同文件可分组导入，四实体及自定义引用正确重映射，逐记录回执阻止重复和改写', async () => {
  const actor = await account();
  const source = document();
  const initial = await api(actor, 'POST', 'import', {
    sync_id: actor.space.syncId,
    export_id: source.export_id,
    records: [source.records[0]],
  });
  expect(initial.statusCode, initial.body).toBe(200);
  expect(initial.json()).toMatchObject({ imported: 1, skipped: 0 });
  const remaining = await api(actor, 'POST', 'import', {
    sync_id: actor.space.syncId,
    export_id: source.export_id,
    records: source.records.slice(1),
  });
  expect(remaining.statusCode, remaining.body).toBe(200);
  expect(remaining.json()).toMatchObject({ imported: 3, skipped: 0 });
  const repeat = await api(actor, 'POST', 'import', {
    sync_id: actor.space.syncId,
    export_id: source.export_id,
    records: source.records,
  });
  expect(repeat.statusCode, repeat.body).toBe(200);
  expect(repeat.json()).toMatchObject({ imported: 0, skipped: 4, replayed: true });
  expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: actor.space.id } })).toBe(4);
  const exported = await api(actor, 'GET', 'export');
  expect(exported.statusCode, exported.body).toBe(200);
  const records = exported.json().records as Array<{
    id: string;
    entity_type: string;
    payload: Record<string, unknown>;
  }>;
  const prefs = records.find((item) => item.entity_type === 'fitness_preferences')!;
  const template = records.find((item) => item.entity_type === 'fitness_template')!;
  const plan = records.find((item) => item.entity_type === 'fitness_plan')!;
  const workout = records.find((item) => item.entity_type === 'fitness_workout')!;
  expect(prefs.id).toBe(actor.space.id);
  const mapped = (prefs.payload.custom_exercises as Array<{ id: string }>)[0]!.id;
  expect(mapped).toMatch(/^custom:/);
  expect(mapped).not.toBe(source.custom);
  expect((template.payload.exercises as Array<{ exercise_id: string }>)[0]!.exercise_id).toBe(mapped);
  expect(workout.payload).toMatchObject({ source_plan_id: plan.id, source_template_id: template.id });
  expect((workout.payload.occurrence_key as string).startsWith(`${plan.id}:`)).toBe(true);
  const receipt = await prisma.idempotencyKey.findFirst({
    where: { userId: actor.user.user_id, key: { startsWith: `fitness-import:${actor.space.id}:` } },
  });
  expect(receipt!.expiresAt.getUTCFullYear()).toBe(9999);
  const changed = structuredClone(source.records[1]!);
  (changed.payload as Record<string, unknown>).name = '文件被修改';
  expect(
    (
      await api(actor, 'POST', 'import', {
        sync_id: actor.space.syncId,
        export_id: source.export_id,
        records: [changed],
      })
    ).statusCode,
  ).toBe(409);
});
it('晚于模板写入的进行中冲突回滚全部数据和回执，导入不悄悄结束既有训练', async () => {
  const actor = await account();
  const existing = {
    ...fitnessWorkout(),
    status: 'in_progress',
    run_segments: [{ started_at: fitnessTime, ended_at: null }],
  };
  await prisma.fitnessEntity.create({
    data: {
      id: randomUUID(),
      fitnessSpaceId: actor.space.id,
      entityType: 'fitness_workout',
      status: 'in_progress',
      payload: existing,
      createdAt: new Date(fitnessTime),
      updatedAt: new Date(fitnessTime),
    },
  });
  const exportId = randomUUID();
  const response = await api(actor, 'POST', 'import', {
    sync_id: actor.space.syncId,
    export_id: exportId,
    records: [
      { id: randomUUID(), entity_type: 'fitness_template', payload: fitnessTemplate() },
      { id: randomUUID(), entity_type: 'fitness_workout', payload: existing },
    ],
  });
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().code).toBe('FITNESS_IMPORT_CONFLICT');
  expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: actor.space.id } })).toBe(1);
  expect(
    await prisma.idempotencyKey.count({
      where: { userId: actor.user.user_id, key: { startsWith: 'fitness-import:' } },
    }),
  ).toBe(0);
  expect(await prisma.syncChange.count({ where: { fitnessSpaceId: actor.space.id } })).toBe(0);
});
it('偏好覆盖要求明确确认并保留目标自定义动作，所有权、代次与缺失引用均拒绝', async () => {
  const actor = await account();
  const other = await account();
  const source = document();
  expect(
    (
      await api(actor, 'POST', 'import', {
        sync_id: actor.space.syncId,
        export_id: source.export_id,
        records: [source.records[0]],
      })
    ).statusCode,
  ).toBe(200);
  const next = document();
  const body = { sync_id: actor.space.syncId, export_id: next.export_id, records: [next.records[0]] };
  const denied = await api(actor, 'POST', 'import', body);
  expect(denied.statusCode, denied.body).toBe(409);
  expect(denied.json().code).toBe('FITNESS_PREFERENCES_CONFIRMATION_REQUIRED');
  expect((await api(actor, 'POST', 'import', { ...body, replace_preferences: true })).statusCode).toBe(200);
  const prefs = await prisma.fitnessEntity.findUnique({ where: { id: actor.space.id } });
  expect((prefs!.payload as { custom_exercises: unknown[] }).custom_exercises).toHaveLength(2);
  expect((await api({ ...other, space: actor.space }, 'GET', 'export')).statusCode).toBe(404);
  expect((await api({ ...other, space: actor.space }, 'POST', 'import', body)).statusCode).toBe(404);
  expect((await api(actor, 'POST', 'import', { ...body, sync_id: randomUUID() })).statusCode).toBe(412);
  const missing = document();
  expect(
    (
      await api(actor, 'POST', 'import', {
        sync_id: actor.space.syncId,
        export_id: missing.export_id,
        records: [missing.records[1]],
      })
    ).statusCode,
  ).toBe(400);
});

it('单路由严格校验拒绝非法参数、错类型正文、未知字段且不会删除联合字段', async () => {
  const actor = await account();
  const source = document();
  const body = { sync_id: actor.space.syncId, export_id: source.export_id, records: source.records };
  for (const invalid of [
    { ...body, unknown: true },
    { ...body, records: 'invalid' },
    { ...body, records: [{ ...source.records[0], deleted_at: null }] },
    { ...body, records: [{ ...source.records[1], payload: { ...source.records[1]!.payload, unknown: true } }] },
  ]) {
    const response = await api(actor, 'POST', 'import', invalid);
    expect(response.statusCode, response.body).toBe(400);
  }
  const invalidParams = await api({ ...actor, space: { id: 'not-uuid' } }, 'POST', 'import', body);
  expect(invalidParams.statusCode, invalidParams.body).toBe(400);
  expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: actor.space.id } })).toBe(0);
  const valid = await api(actor, 'POST', 'import', body);
  expect(valid.statusCode, valid.body).toBe(200);
  expect(valid.json().imported).toBe(4);
});
