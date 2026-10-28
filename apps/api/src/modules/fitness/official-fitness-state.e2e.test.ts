import { PrismaClient } from '@prisma/client';
import { afterAll, expect, it } from 'vitest';
import { testFixtureDatabaseUrl } from '../../../test/existing-test-database.js';
import { advanceOfficialContentVersion } from './official-fitness-state.js';

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
