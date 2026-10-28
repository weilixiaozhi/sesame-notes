import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { fitnessPlan, fitnessTemplate, fitnessTime } from './fitness-fixtures.js';
import { generatePlanCycles, type FitnessPlanPayload } from '../src/modules/fitness/testing.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const app = buildApp({
  logger: false,
  prisma,
  config: {
    ...loadConfig({
      DATABASE_URL: databaseUrl,
      JWT_SECRET: 'fitness-plan-tests-only-secret-at-least-32-bytes',
      STORAGE_PATH: '.plan-test-storage',
    }),
    authRateLimitMax: 10000,
    rateLimitMax: 10000,
  },
});
beforeAll(() => app.ready());
afterAll(() => app.close());
type Actor = { token: string; userId: string; deviceId: string };

/** 每项测试使用随机独立账号，只连接显式给出的临时库。 */
async function account(): Promise<Actor> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      country_code: '+86',
      phone: `138${randomInt(100000000).toString().padStart(8, '0')}`,
      password: 'plan-test-password',
      device: { installation_id: randomUUID(), name: 'plan test', platform: 'web' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json();
  return { token: body.access_token, userId: body.user.user_id, deviceId: body.device_id };
}

/** 空间只属于当前测试账号。 */
async function scope(actor: Actor) {
  return prisma.fitnessSpace.create({
    data: { id: randomUUID(), ownerId: actor.userId, name: 'plan test', createdAt: new Date(), updatedAt: new Date() },
  });
}

/** 使用统一的完整计划样本，服务器必须自行维护生成游标。 */
function fresh(): FitnessPlanPayload {
  return {
    ...fitnessPlan(),
    generation_state: { next_cycle_index: 0, next_cycle_start_date: null, generated_cycles: [] },
  } as FitnessPlanPayload;
}

/** 所有写入通过真实 Fastify 路由和鉴权守卫。 */
function command(actor: Actor, spaceId: string, id: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/fitness-spaces/${spaceId}/plans/${id}/command`,
    headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

describe('atomic online plan commands', () => {
  it('imports template copies and a closed plan atomically, preserving retry identity', async () => {
    const actor = await account();
    const space = await scope(actor);
    const templateId = randomUUID();
    const planId = randomUUID();
    const plan = fresh();
    plan.status = 'closed';
    plan.days[0]!.slot!.source_template_id = templateId;
    const body = {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: 0,
      today: '2026-09-11',
      action: 'save',
      plan,
      template_copies: [{ id: templateId, payload: fitnessTemplate() }],
    };
    const first = await command(actor, space.id, planId, body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ generated_count: 0, plan: { status: 'closed' } });
    expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: space.id } })).toBe(2);
    expect((await command(actor, space.id, planId, body)).json().replayed).toBe(true);
    expect(await prisma.syncChange.count({ where: { fitnessSpaceId: space.id } })).toBe(2);
    const failedSpace = await scope(actor);
    const collision = await command(actor, failedSpace.id, randomUUID(), {
      ...body,
      mutation_id: randomUUID(),
      sync_id: failedSpace.syncId,
      template_copies: [
        { id: randomUUID(), payload: fitnessTemplate() },
        { id: templateId, payload: fitnessTemplate() },
      ],
    });
    expect(collision.statusCode, collision.body).toBe(409);
    expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: failedSpace.id } })).toBe(0);
    expect(await prisma.syncChange.count({ where: { fitnessSpaceId: failedSpace.id } })).toBe(0);
  });

  it('commits plan, generated workouts and sync events together and replays exactly once', async () => {
    const actor = await account();
    const space = await scope(actor);
    const id = randomUUID();
    const body = {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: 0,
      today: '2026-09-11',
      action: 'save',
      plan: fresh(),
    };
    const first = await command(actor, space.id, id, body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ generated_count: 1, replayed: false, has_more: false });
    expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: space.id } })).toBe(2);
    const events = await prisma.syncChange.findMany({ where: { fitnessSpaceId: space.id } });
    expect(events.map((event) => event.entityType).sort()).toEqual(['fitness_plan', 'fitness_workout']);
    const repeated = await command(actor, space.id, id, body);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json().replayed).toBe(true);
    expect(repeated.json().plan).toEqual(first.json().plan);
    expect(await prisma.syncChange.count({ where: { fitnessSpaceId: space.id } })).toBe(2);
    const reused = await command(actor, space.id, id, { ...body, plan: { ...body.plan, name: 'different request' } });
    expect(reused.statusCode).toBe(409);
  });

  it('rejects stale versions, foreign ownership and stale space generations without writing', async () => {
    const actor = await account();
    const stranger = await account();
    const space = await scope(actor);
    const id = randomUUID();
    const body = {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: 0,
      today: '2026-09-11',
      action: 'save',
      plan: fresh(),
    };
    expect((await command(stranger, space.id, id, body)).statusCode).toBe(404);
    expect((await command(actor, space.id, id, { ...body, sync_id: randomUUID() })).statusCode).toBe(412);
    expect((await command(actor, space.id, id, body)).statusCode).toBe(200);
    expect((await command(actor, space.id, id, { ...body, mutation_id: randomUUID() })).statusCode).toBe(409);
    expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: space.id } })).toBe(2);
    const anonymous = await app.inject({
      method: 'POST',
      url: `/api/v1/fitness-spaces/${space.id}/plans/${id}/command`,
      payload: body,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('分批补齐的重放保留剩余周期提示，并且不会重复写入训练或事件', async () => {
    const actor = await account();
    const space = await scope(actor);
    const id = randomUUID();
    try {
      const plan = fresh();
      plan.start_date = '2020-01-01';
      const created = await command(actor, space.id, id, {
        mutation_id: randomUUID(),
        sync_id: space.syncId,
        base_revision: 0,
        today: '2020-01-01',
        action: 'save',
        plan,
      });
      expect(created.statusCode, created.body).toBe(200);
      const body = {
        mutation_id: randomUUID(),
        sync_id: space.syncId,
        base_revision: created.json().plan.revision,
        today: '2021-01-01',
        action: 'generate',
      };
      const first = await command(actor, space.id, id, body);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ generated_count: 100, has_more: true, replayed: false });
      expect(first.json().plan.generation_state.next_cycle_start_date <= body.today).toBe(true);
      const stored = await prisma.fitnessEntity.findUniqueOrThrow({ where: { id } });
      const workouts = await prisma.fitnessEntity.count({
        where: { fitnessSpaceId: space.id, entityType: 'fitness_workout' },
      });
      const events = await prisma.syncChange.count({ where: { fitnessSpaceId: space.id } });

      // 相同冻结命令用于响应丢失后的重试，回执必须继续提示仍未补齐的周期。
      const repeated = await command(actor, space.id, id, body);
      expect(repeated.statusCode, repeated.body).toBe(200);
      expect(repeated.json()).toEqual({
        plan: first.json().plan,
        generated_count: 0,
        removed_count: 0,
        has_more: true,
        replayed: true,
      });
      expect(await prisma.fitnessEntity.findUniqueOrThrow({ where: { id } })).toEqual(stored);
      expect(
        await prisma.fitnessEntity.count({ where: { fitnessSpaceId: space.id, entityType: 'fitness_workout' } }),
      ).toBe(workouts);
      expect(await prisma.syncChange.count({ where: { fitnessSpaceId: space.id } })).toBe(events);

      const completed = await command(actor, space.id, id, {
        ...body,
        mutation_id: randomUUID(),
        base_revision: first.json().plan.revision,
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(completed.json()).toMatchObject({ has_more: false, replayed: false });
      expect(completed.json().plan.generation_state.next_cycle_start_date > body.today).toBe(true);
      const completedEvents = await prisma.syncChange.count({ where: { fitnessSpaceId: space.id } });
      // 后续命令推进当前云态后，旧命令仍返回自身已提交的快照和补齐状态。
      expect((await command(actor, space.id, id, body)).json()).toEqual(repeated.json());
      expect(await prisma.syncChange.count({ where: { fitnessSpaceId: space.id } })).toBe(completedEvents);
    } catch (cause) {
      console.error('计划分批重放状态验收失败', { planId: id, spaceId: space.id, cause });
      throw cause;
    }
  });

  it('rolls back an earlier generated workout when a later generated write is rejected', async () => {
    const actor = await account();
    const space = await scope(actor);
    const another = await scope(actor);
    const brokenTemplate = fitnessTemplate();
    const templateId = randomUUID();
    await prisma.fitnessEntity.create({
      data: {
        id: templateId,
        fitnessSpaceId: another.id,
        entityType: 'fitness_template',
        payload: brokenTemplate,
        createdAt: new Date(fitnessTime),
        updatedAt: new Date(fitnessTime),
      },
    });
    const plan = fresh();
    plan.days[1] = {
      day_index: 1,
      slot: { ...structuredClone(plan.days[0]!.slot!), id: randomUUID(), source_template_id: templateId },
    };
    const id = randomUUID();
    const response = await command(actor, space.id, id, {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: 0,
      today: '2026-09-11',
      action: 'save',
      plan,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(
      await prisma.fitnessEntity.count({
        where: { fitnessSpaceId: space.id, entityType: { in: ['fitness_plan', 'fitness_workout'] } },
      }),
    ).toBe(0);
    expect(await prisma.syncChange.count({ where: { fitnessSpaceId: space.id } })).toBe(0);
  });

  it('advances past a deleted occurrence without resurrecting its tombstone', async () => {
    const actor = await account();
    const space = await scope(actor);
    const id = randomUUID();
    const first = await command(actor, space.id, id, {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: 0,
      today: '2026-09-11',
      action: 'save',
      plan: fresh(),
    });
    expect(first.statusCode, first.body).toBe(200);
    const saved = first.json().plan;
    const next = generatePlanCycles(id, saved, '2026-09-13', fitnessTime).workouts[0]!;
    const tombstone = await prisma.fitnessEntity.create({
      data: {
        id: next.id,
        fitnessSpaceId: space.id,
        entityType: 'fitness_workout',
        payload: next.payload,
        status: 'scheduled',
        occurrenceKey: next.payload.occurrence_key,
        deletedAt: new Date(),
        revision: 3,
        createdAt: new Date(fitnessTime),
        updatedAt: new Date(fitnessTime),
      },
    });
    const response = await command(actor, space.id, id, {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: saved.revision,
      today: '2026-09-13',
      action: 'generate',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().generated_count).toBe(0);
    expect(response.json().plan.generation_state.next_cycle_index).toBe(2);
    expect(await prisma.fitnessEntity.findUnique({ where: { id: tombstone.id } })).toMatchObject({
      revision: 3,
      deletedAt: tombstone.deletedAt,
    });
  });

  it('restarts with a new cycle identity and only removes overlapping records from that plan', async () => {
    const actor = await account();
    const space = await scope(actor);
    const id = randomUUID();
    const first = await command(actor, space.id, id, {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: 0,
      today: '2026-09-11',
      action: 'save',
      plan: fresh(),
    });
    const continued = await command(actor, space.id, id, {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: first.json().plan.revision,
      today: '2026-09-13',
      action: 'generate',
    });
    const active = continued.json().plan;
    const closedPayload: FitnessPlanPayload = {
      name: active.name,
      status: 'closed',
      start_date: active.start_date,
      cycle_days: active.cycle_days,
      days: active.days,
      generation_state: active.generation_state,
      pending_schedule: active.pending_schedule,
      created_at: active.created_at,
      updated_at: active.updated_at,
    };
    const stopped = await command(actor, space.id, id, {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: active.revision,
      today: '2026-09-13',
      action: 'save',
      plan: closedPayload,
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    const before = await prisma.fitnessEntity.findMany({
      where: { fitnessSpaceId: space.id, entityType: 'fitness_workout' },
    });
    const response = await command(actor, space.id, id, {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: stopped.json().plan.revision,
      today: '2026-09-13',
      action: 'save',
      restart_date: '2026-09-13',
      plan: { ...closedPayload, status: 'in_progress' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ generated_count: 1, removed_count: 1 });
    expect(response.json().plan.generation_state.next_cycle_index).toBe(3);
    const early = before.find((row) => (row.payload as { scheduled_date: string }).scheduled_date === '2026-09-11')!;
    const overlap = before.find((row) => (row.payload as { scheduled_date: string }).scheduled_date === '2026-09-13')!;
    expect((await prisma.fitnessEntity.findUnique({ where: { id: early.id } }))!.deletedAt).toBeNull();
    expect((await prisma.fitnessEntity.findUnique({ where: { id: overlap.id } }))!.deletedAt).not.toBeNull();
  });

  it('rejects cross-space template references even for a closed plan with no generated workouts', async () => {
    const actor = await account();
    const space = await scope(actor);
    const another = await scope(actor);
    const template = await prisma.fitnessEntity.create({
      data: {
        id: randomUUID(),
        fitnessSpaceId: another.id,
        entityType: 'fitness_template',
        payload: fitnessTemplate(),
        createdAt: new Date(fitnessTime),
        updatedAt: new Date(fitnessTime),
      },
    });
    const plan = fresh();
    plan.status = 'closed';
    plan.days[0]!.slot!.source_template_id = template.id;
    const response = await command(actor, space.id, randomUUID(), {
      mutation_id: randomUUID(),
      sync_id: space.syncId,
      base_revision: 0,
      today: '2026-09-11',
      action: 'save',
      plan,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(await prisma.fitnessEntity.count({ where: { fitnessSpaceId: space.id } })).toBe(0);
  });
});
