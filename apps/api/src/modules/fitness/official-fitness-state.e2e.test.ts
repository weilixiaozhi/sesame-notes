import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { testFixtureDatabaseUrl } from '../../../test/existing-test-database.js';
import { advanceOfficialContentVersion } from './official-fitness-state.js';
import { validateOfficialContent } from './official-fitness.js';
import library from './fitness-library.json' with { type: 'json' };

const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });

afterAll(async () => {
  await prisma.$disconnect();
});

it('官方目录提交只递增持久化版本，验收事务结束后保留原版本', async () => {
  const rollback = new Error('结束官方目录版本验收事务');
  const before = await prisma.officialFitnessState.findUniqueOrThrow({ where: { id: 1 } });
  try {
    await prisma.$transaction(async (tx) => {
      await advanceOfficialContentVersion(tx);
      expect(await tx.officialFitnessState.findUniqueOrThrow({ where: { id: 1 } })).toEqual({
        ...before,
        contentVersion: before.contentVersion + 1,
      });
      // 验收只观察事务内的真实递增结果，结束时恢复原始数据库状态。
      throw rollback;
    });
  } catch (cause) {
    if (cause !== rollback) throw new Error('官方目录版本递增验收失败', { cause });
  }
  expect(await prisma.officialFitnessState.findUniqueOrThrow({ where: { id: 1 } })).toEqual(before);
});

it('目录版本缺失使同一事务的正文修改回滚，不能重建版本并提交正文', async () => {
  const state = await prisma.officialFitnessState.findUniqueOrThrow({ where: { id: 1 } });
  const content = await prisma.officialFitnessContent.findFirstOrThrow();
  let failure: unknown;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.officialFitnessContent.update({ where: { id: content.id }, data: { isEnabled: !content.isEnabled } });
      await tx.officialFitnessState.delete({ where: { id: 1 } });
      await advanceOfficialContentVersion(tx);
      // 即使实现错误地提交成功，也主动回滚测试制造的缺失状态。
      throw new Error('版本记录缺失后意外完成了版本推进');
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toMatchObject({ message: '官方健身目录版本更新失败', cause: { code: 'P2025' } });
  expect(await prisma.officialFitnessState.findUniqueOrThrow({ where: { id: 1 } })).toEqual(state);
  expect(await prisma.officialFitnessContent.findUniqueOrThrow({ where: { id: content.id } })).toEqual(content);
});

it('官方引用允许重复身份和休息日，并只阻止正在使用的内容停用', async () => {
  const rollback = new Error('结束官方引用验收事务');
  try {
    await prisma.$transaction(async (tx) => {
      const originalExercise = await tx.officialFitnessContent.findUniqueOrThrow({ where: { id: '0025' } });
      const exerciseId = randomUUID();
      const templateId = randomUUID();
      const planId = randomUUID();
      const exercise = await tx.officialFitnessContent.create({
        data: {
          id: exerciseId,
          kind: 'exercise',
          content: { ...(originalExercise.content as object), id: exerciseId },
        },
      });
      const originalTemplate = library.templates[0]!;
      const repeatedExercise = { ...originalTemplate.exercises[0]!, exercise_id: exerciseId };
      const template = await tx.officialFitnessContent.create({
        data: {
          id: templateId,
          kind: 'template',
          content: {
            ...originalTemplate,
            id: templateId,
            equipment: [],
            exercises: [repeatedExercise, repeatedExercise],
          },
        },
      });
      const originalPlan = library.plans[0]!;
      const plan = await tx.officialFitnessContent.create({
        data: {
          id: planId,
          kind: 'plan',
          content: {
            ...originalPlan,
            id: planId,
            days: originalPlan.days.map((day, index) => ({ ...day, template_id: index === 0 ? null : templateId })),
          },
        },
      });

      await validateOfficialContent(tx, template);
      await validateOfficialContent(tx, plan);
      await expect(validateOfficialContent(tx, { ...exercise, isEnabled: false })).rejects.toMatchObject({
        statusCode: 409,
        code: 'FITNESS_CONTENT_REFERENCED',
      });
      await expect(validateOfficialContent(tx, { ...template, isEnabled: false })).rejects.toMatchObject({
        statusCode: 409,
        code: 'FITNESS_CONTENT_REFERENCED',
      });

      await tx.officialFitnessContent.update({ where: { id: planId }, data: { isEnabled: false } });
      await validateOfficialContent(tx, { ...template, isEnabled: false });
      await tx.officialFitnessContent.update({ where: { id: templateId }, data: { isEnabled: false } });
      await validateOfficialContent(tx, { ...exercise, isEnabled: false });
      await expect(validateOfficialContent(tx, plan)).rejects.toMatchObject({
        statusCode: 409,
        code: 'FITNESS_REFERENCE_UNAVAILABLE',
      });

      await tx.officialFitnessContent.update({ where: { id: exerciseId }, data: { isEnabled: false } });
      await expect(validateOfficialContent(tx, template)).rejects.toMatchObject({
        statusCode: 409,
        code: 'FITNESS_REFERENCE_UNAVAILABLE',
      });
      throw rollback;
    });
  } catch (cause) {
    if (cause !== rollback) throw new Error('官方内容引用验收失败', { cause });
  }
});
