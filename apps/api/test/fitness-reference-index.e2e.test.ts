import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { fitnessPlan, fitnessTemplate, fitnessTime, fitnessWorkout } from './fitness-fixtures.js';

const databaseUrl = testFixtureDatabaseUrl();
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
let userId: string;
let spaceId: string;
let otherSpaceId: string;

beforeAll(async () => {
  try {
    const user = await prisma.user.create({
      data: {
        phoneE164: `+86139${randomInt(100_000_000).toString().padStart(8, '0')}`,
        sesameNumber: randomInt(100_000_000, 1_000_000_000).toString(),
        passwordHash: 'fitness-reference-index-test',
      },
    });
    userId = user.id;
    const spaces = await Promise.all(
      ['引用来源空间', '其他空间'].map((name) =>
        prisma.fitnessSpace.create({
          data: {
            id: randomUUID(),
            ownerId: user.id,
            name,
            createdAt: new Date(fitnessTime),
            updatedAt: new Date(fitnessTime),
          },
        }),
      ),
    );
    spaceId = spaces[0]!.id;
    otherSpaceId = spaces[1]!.id;
  } catch (cause) {
    throw new Error('健身引用索引测试初始化失败', { cause });
  }
});

afterAll(async () => {
  try {
    if (userId) await prisma.user.delete({ where: { id: userId } });
  } catch (cause) {
    throw new Error('健身引用索引测试清理失败', { cause });
  } finally {
    await prisma.$disconnect();
  }
});

/** 构造带可选来源的实体，真实数据库形态约束仍验证完整业务正文。 */
function entityData(
  id: string,
  targetSpaceId: string,
  entityType: 'fitness_template' | 'fitness_workout' | 'fitness_plan',
  payload: Prisma.InputJsonObject,
): Prisma.FitnessEntityUncheckedCreateInput {
  return {
    id,
    fitnessSpaceId: targetSpaceId,
    entityType,
    payload,
    status: entityType === 'fitness_workout' ? 'scheduled' : null,
    createdAt: new Date(fitnessTime),
    updatedAt: new Date(fitnessTime),
  };
}

/** 构造来源模板可以晚到的训练正文。 */
function workoutPayload(targetId: string) {
  return { ...fitnessWorkout(), source_kind: 'template', source_template_id: targetId };
}

/** 构造嵌套日程来源，更新此引用不改变已生成周期。 */
function planPayload(targetId: string | null) {
  const plan = fitnessPlan();
  return {
    ...plan,
    days: plan.days.map((day) => ({
      ...day,
      slot: day.slot ? { ...day.slot, source_template_id: targetId } : null,
    })),
  };
}

/** 读取来源实体的派生边，排序保证断言不依赖数据库返回顺序。 */
async function references(entityId: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRaw<Array<{ target_id: string }>>`
      SELECT target_id::text FROM fitness_entity_references WHERE entity_id = ${entityId}::uuid ORDER BY target_id
    `;
    return rows.map((row) => row.target_id);
  } catch (cause) {
    throw new Error('读取健身派生引用失败', { cause });
  }
}

describe('健身来源关系索引', () => {
  it('任意嵌套、数组与大小写遵循原始 JSONPath 比较语义', async () => {
    const first = 'aaaaaaaa-1111-4111-8111-111111111111';
    const second = 'bbbbbbbb-2222-4222-8222-222222222222';
    const unrelated = 'cccccccc-3333-4333-8333-333333333333';
    const candidates = [first, second, unrelated];
    const payloads = [
      { source_plan_id: first, source_template_id: second, unrelated },
      { nested: [{ deeper: { source_template_id: [first, second, first] } }], unrelated },
      { source_template_id: [[first], second], nested: { source_plan_id: null }, unrelated },
      { source_plan_id: first.toUpperCase(), source_template_id: 7, unrelated },
      [{ source_template_id: first }, { nested: { source_plan_id: second } }],
      { source_plan_id: { nested: first }, unrelated },
    ];
    try {
      for (const payload of payloads) {
        const [result] = await prisma.$queryRaw<Array<{ actual: string[]; expected: string[] }>>`
          SELECT
            ARRAY(SELECT target_id::text FROM fitness_reference_ids(${JSON.stringify(payload)}::jsonb) ORDER BY target_id) AS actual,
            ARRAY(
              SELECT id FROM jsonb_array_elements_text(${JSON.stringify(candidates)}::jsonb) AS candidate(id)
              WHERE jsonb_path_exists(
                ${JSON.stringify(payload)}::jsonb,
                '$.** ? (@.source_plan_id == $id || @.source_template_id == $id)',
                jsonb_build_object('id', id)
              ) ORDER BY id
            ) AS expected
        `;
        expect(result!.actual, JSON.stringify(payload)).toEqual(result!.expected);
      }
      expect(
        await prisma.$queryRaw`SELECT target_id::text FROM fitness_reference_ids(${JSON.stringify(payloads[0])}::jsonb) ORDER BY target_id`,
      ).toEqual([{ target_id: first }, { target_id: second }]);
    } catch (cause) {
      throw new Error('健身来源提取与原始 JSONPath 语义不一致', { cause });
    }
  });

  it('来源晚到、同空间补齐、目标软删和物理删除保留引用，引用方删除级联清理', async () => {
    const targetId = randomUUID();
    const sourceId = randomUUID();
    try {
      await prisma.fitnessEntity.create({
        data: entityData(sourceId, spaceId, 'fitness_workout', workoutPayload(targetId)),
      });
      expect(await references(sourceId)).toEqual([targetId]);
      await prisma.fitnessEntity.create({ data: entityData(targetId, spaceId, 'fitness_template', fitnessTemplate()) });
      await prisma.fitnessEntity.update({
        where: { id: targetId },
        data: { revision: { increment: 1 }, deletedAt: new Date(fitnessTime) },
      });
      expect(await references(sourceId)).toEqual([targetId]);
      await prisma.fitnessEntity.delete({ where: { id: targetId } });
      expect(await references(sourceId)).toEqual([targetId]);
      await prisma.fitnessEntity.delete({ where: { id: sourceId } });
      expect(await references(sourceId)).toEqual([]);
    } catch (cause) {
      throw new Error('健身来源生命周期索引验证失败', { cause });
    }
  });

  it('现存异空间目标和晚到异空间目标都在提交时拒绝，失败事务不留下派生边', async () => {
    const existingTarget = randomUUID();
    const rejectedSource = randomUUID();
    const lateTarget = randomUUID();
    const waitingSource = randomUUID();
    try {
      await prisma.fitnessEntity.create({
        data: entityData(existingTarget, otherSpaceId, 'fitness_template', fitnessTemplate()),
      });
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.fitnessEntity.create({
            data: entityData(rejectedSource, spaceId, 'fitness_workout', workoutPayload(existingTarget)),
          });
        }),
      ).rejects.toThrow('FITNESS_CROSS_SPACE_REFERENCE');
      expect(await references(rejectedSource)).toEqual([]);
      await prisma.fitnessEntity.create({
        data: entityData(waitingSource, spaceId, 'fitness_workout', workoutPayload(lateTarget)),
      });
      await expect(
        prisma.fitnessEntity.create({
          data: entityData(lateTarget, otherSpaceId, 'fitness_template', fitnessTemplate()),
        }),
      ).rejects.toThrow('FITNESS_CROSS_SPACE_REFERENCE');
      expect(await prisma.fitnessEntity.findUnique({ where: { id: lateTarget } })).toBeNull();
      expect(await references(waitingSource)).toEqual([lateTarget]);
    } catch (cause) {
      throw new Error('健身跨空间引用双向约束验证失败', { cause });
    }
  });

  it('嵌套引用更新同步刷新索引，延迟约束检查同事务最终状态', async () => {
    const targetId = randomUUID();
    const sourceId = randomUUID();
    const lateTargetId = randomUUID();
    try {
      await prisma.fitnessEntity.create({
        data: entityData(targetId, otherSpaceId, 'fitness_template', fitnessTemplate()),
      });
      await prisma.$transaction(async (tx) => {
        await tx.fitnessEntity.create({ data: entityData(sourceId, spaceId, 'fitness_plan', planPayload(targetId)) });
        await tx.fitnessEntity.update({
          where: { id: sourceId },
          data: { payload: planPayload(lateTargetId), revision: { increment: 1 } },
        });
      });
      expect(await references(sourceId)).toEqual([lateTargetId]);
      await prisma.fitnessEntity.update({
        where: { id: sourceId },
        data: { payload: planPayload(null), revision: { increment: 1 } },
      });
      expect(await references(sourceId)).toEqual([]);
    } catch (cause) {
      throw new Error('健身嵌套引用事务更新验证失败', { cause });
    }
  });

  it('直接 SQL 与先取得同步锁的事务交错时先等待，再拒绝跨空间晚到目标', async () => {
    const writer = new PrismaClient({ datasourceUrl: databaseUrl });
    const contender = new PrismaClient({ datasourceUrl: databaseUrl });
    const sourceId = randomUUID();
    const targetId = randomUUID();
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sourceReady = () => {};
    const ready = new Promise<void>((resolve) => {
      sourceReady = resolve;
    });
    let contenderPid: number | undefined;
    let owner: Promise<unknown> | undefined;
    let conflict: Promise<{ error?: unknown }> | undefined;
    try {
      owner = writer.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(1936028513, 1)`;
          await tx.fitnessEntity.create({
            data: entityData(sourceId, spaceId, 'fitness_workout', workoutPayload(targetId)),
          });
          sourceReady();
          await hold;
        },
        { timeout: 15_000 },
      );
      await Promise.race([ready, owner]);
      conflict = contender
        .$transaction(
          async (tx) => {
            const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            contenderPid = backend!.pid;
            // 原生 SQL 没有应用包装器，BEFORE STATEMENT 必须在任何实体行写入前取得同一锁。
            await tx.$executeRaw`
          INSERT INTO fitness_entities(id, fitness_space_id, entity_type, payload, created_at, updated_at)
          VALUES (${targetId}::uuid, ${otherSpaceId}::uuid, 'fitness_template', ${JSON.stringify(fitnessTemplate())}::jsonb,
            ${new Date(fitnessTime)}, ${new Date(fitnessTime)})
        `;
          },
          { timeout: 15_000 },
        )
        .then(
          () => ({}),
          (error: unknown) => ({ error }),
        );
      await expect
        .poll(
          async () => {
            if (contenderPid === undefined) return false;
            const [activity] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT wait_event_type = 'Lock' AND wait_event = 'advisory' AS waiting
          FROM pg_stat_activity WHERE pid = ${contenderPid}
        `;
            return activity?.waiting === true;
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      expect(await prisma.fitnessEntity.findUnique({ where: { id: targetId } })).toBeNull();
      release();
      await owner;
      const result = await conflict;
      expect(String(result.error)).toContain('FITNESS_CROSS_SPACE_REFERENCE');
      expect(await references(sourceId)).toEqual([targetId]);
    } catch (cause) {
      throw new Error('健身引用交错提交未维持锁顺序或跨空间约束', { cause });
    } finally {
      release();
      await Promise.allSettled([owner, conflict]);
      await Promise.all([writer.$disconnect(), contender.$disconnect()]);
    }
  }, 20_000);
});
