import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { fitnessWorkout, fitnessExercise, fitnessPreferences, fitnessTime } from './fitness-fixtures.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  prisma,
  logger: false,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'fitness-stats-test-only-secret-32-bytes',
      STORAGE_PATH: '.fitness-stat-test-storage',
    }),
    authRateLimitMax: 10000,
    rateLimitMax: 10000,
  },
});
let statisticsFixture: Awaited<ReturnType<typeof prepareStatisticsFixture>>;
beforeAll(async () => {
  await app.ready();
  statisticsFixture = await prepareStatisticsFixture();
}, 30000);
afterAll(() => app.close());
/** 为当前测试创建独立账号，不使用或清理用户现有数据。 */
async function account() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `139${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'fitness-tests-only',
      device: { installation_id: randomUUID(), name: 'Fitness statistics test', platform: 'web' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ access_token: string; user: { user_id: string } }>();
}
/** 使用账号令牌访问真实 HTTP 路由和隔离 PostgreSQL。 */
function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}
it('聚合跨越 200 条列表上限，动作筛选要求同一动作有完成组，并保护详情所有权', async () => {
  const { actor, other, space, activeId, deleted } = statisticsFixture;
  const base = `/api/v1/fitness-spaces/${space.id}`;
  const query = 'start_date=2026-09-01&end_date=2026-09-30&time_zone=UTC';
  const stats = await get(`${base}/statistics?${query}`, actor.access_token);
  expect(stats.statusCode, stats.body).toBe(200);
  expect(stats.json()).toMatchObject({
    training_days: 1,
    completed_workouts: 205,
    completed_sets: 205,
    total_duration_ms: 369000000,
    volume_kg: '102500.000000164',
  });
  const history = await get(`${base}/workouts?exercise_id=0025&limit=200`, actor.access_token);
  expect(history.statusCode, history.body).toBe(200);
  const page = history.json();
  expect(page.items).toHaveLength(200);
  expect(page.next_cursor).toBeTruthy();
  const second = await get(
    `${base}/workouts?exercise_id=0025&limit=200&cursor=${encodeURIComponent(page.next_cursor)}`,
    actor.access_token,
  );
  expect(second.json().items).toHaveLength(6);
  expect([...page.items, ...second.json().items].some((item: { id: string }) => item.id === activeId)).toBe(true);
  const calendar = await get(`${base}/calendar?${query}`, actor.access_token);
  expect(calendar.statusCode, calendar.body).toBe(200);
  expect(calendar.json().days.find((day: { date: string }) => day.date === '2026-09-11').workouts).toHaveLength(207);
  const detail = await get(`${base}/workouts/${activeId}`, actor.access_token);
  expect(detail.statusCode, detail.body).toBe(200);
  expect(detail.json()).toMatchObject({ id: activeId, status: 'in_progress', sync_id: space.syncId });
  for (const path of [`/statistics?${query}`, `/calendar?${query}`, `/workouts/${activeId}`])
    expect((await get(base + path, other.access_token)).statusCode).toBe(404);
  expect((await get(`${base}/workouts/${deleted.id}`, actor.access_token)).statusCode).toBe(404);
  expect((await get(`${base}/statistics?${query}&sync_id=${randomUUID()}`, actor.access_token)).statusCode).toBe(412);
  expect(
    (await get(`${base}/statistics?start_date=2026-02-30&end_date=2026-03-01`, actor.access_token)).statusCode,
  ).toBe(400);
});
it('健身偏好使用本子唯一 ID，分页读取与他人账号隔离', async () => {
  const actor = await account();
  const other = await account();
  const space = await prisma.fitnessSpace.create({
    data: {
      id: randomUUID(),
      createdAt: new Date(fitnessTime),
      updatedAt: new Date(fitnessTime),
      ownerId: actor.user.user_id,
      name: '偏好测试',
    },
  });
  const time = new Date(fitnessTime);
  await prisma.fitnessEntity.create({
    data: {
      id: space.id,
      fitnessSpaceId: space.id,
      entityType: 'fitness_preferences',
      payload: fitnessPreferences(),
      createdAt: time,
      updatedAt: time,
    },
  });
  const url = `/api/v1/fitness-spaces/${space.id}/preferences`;
  const response = await get(url, actor.access_token);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().items).toHaveLength(1);
  expect(response.json().next_cursor).toBeNull();
  expect((await get(url, other.access_token)).statusCode).toBe(404);
});

/** 单独准备超过分页上限的真实数据；数据库 CHECK 校验耗时不挤占请求断言的默认五秒预算。 */
async function prepareStatisticsFixture() {
  const actor = await account();
  const other = await account();
  const space = await prisma.fitnessSpace.create({
    data: {
      id: randomUUID(),
      createdAt: new Date(fitnessTime),
      updatedAt: new Date(fitnessTime),
      ownerId: actor.user.user_id,
      name: '统计测试',
    },
  });
  const time = new Date(fitnessTime);
  const records = Array.from({ length: 205 }, () => {
    const payload = {
      ...fitnessWorkout(),
      status: 'completed',
      exercises: [fitnessExercise(true)],
      run_segments: [{ started_at: '2026-09-11T01:00:00.000Z', ended_at: '2026-09-11T01:30:00.000Z' }],
    };
    return {
      id: randomUUID(),
      fitnessSpaceId: space.id,
      entityType: 'fitness_workout',
      status: 'completed',
      payload,
      createdAt: time,
      updatedAt: time,
    };
  });
  await prisma.fitnessEntity.createMany({ data: records });
  const active = {
    ...fitnessWorkout(),
    status: 'in_progress',
    exercises: [fitnessExercise(true)],
    run_segments: [{ started_at: '2026-09-11T02:00:00.000Z', ended_at: null }],
  };
  const activeId = randomUUID();
  await prisma.fitnessEntity.create({
    data: {
      id: activeId,
      fitnessSpaceId: space.id,
      entityType: 'fitness_workout',
      status: 'in_progress',
      payload: active,
      createdAt: time,
      updatedAt: time,
    },
  });
  const uncompleted = fitnessExercise(false);
  const otherExercise = fitnessExercise(true);
  otherExercise.exercise_id = '0047';
  const unrelated = {
    ...fitnessWorkout(),
    status: 'completed',
    exercises: [uncompleted, otherExercise],
    run_segments: [{ started_at: '2026-08-01T02:00:00.000Z', ended_at: '2026-08-01T02:30:00.000Z' }],
  };
  await prisma.fitnessEntity.create({
    data: {
      id: randomUUID(),
      fitnessSpaceId: space.id,
      entityType: 'fitness_workout',
      status: 'completed',
      payload: unrelated,
      createdAt: time,
      updatedAt: time,
    },
  });
  const deleted = { ...records[0]!, id: randomUUID(), deletedAt: time };
  await prisma.fitnessEntity.create({ data: deleted });

  return { actor, other, space, activeId, deleted };
}
