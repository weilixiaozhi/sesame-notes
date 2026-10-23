import { expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  assertCategoryConflictTestDatabase,
  categoryConflictTestDatabaseUrl,
} from './category-conflict-test-database.js';

const url = 'postgresql://fixture:fixture@localhost:55432/sesame_notes';
const exclusive = {
  E2E_DATABASE_MODE: 'existing-exclusive',
  E2E_EXCLUSIVE_WINDOW: 'sesame_notes:api-8080-stopped',
};
const identity = { database: 'sesame_notes', port: 5432, schema: 'public', user: 'fixture' };
/** 只提供明确排列的只读查询结果，未知额外查询会直接失败。 */
function database(results: unknown[]) {
  return {
    $queryRaw: vi.fn().mockImplementation(async () => {
      if (!results.length) throw new Error('unexpected query');
      return results.shift();
    }),
  } as unknown as Pick<PrismaClient, '$queryRaw'>;
}

it('原测试库必须同时声明固定独占模式和API停止窗口', () => {
  expect(() => categoryConflictTestDatabaseUrl(url, {})).toThrow();
  expect(() => categoryConflictTestDatabaseUrl(url, { E2E_DATABASE_MODE: 'existing-exclusive' })).toThrow();
  expect(categoryConflictTestDatabaseUrl(url, exclusive)).toBe(url);
});
it.each([
  undefined,
  'postgresql://fixture:fixture@10.20.30.40:55432/sesame_notes',
  'postgresql://fixture:fixture@localhost:5432/sesame_notes',
  'postgresql://fixture:fixture@localhost:55432/production',
  `${url}?schema=other`,
  'https://localhost:55432/sesame_notes',
])('拒绝缺失或偏离已核实地址的既有库连接 %s', (value) => {
  expect(() => categoryConflictTestDatabaseUrl(value, exclusive)).toThrow();
});
it('显式隔离库路径仍可使用，不默认连接原测试库', () => {
  const isolated = url.replace('sesame_notes', 'sesame_test_owned');
  expect(categoryConflictTestDatabaseUrl(isolated, {})).toBe(isolated);
});
it('实际身份匹配且无其他连接才允许既有库窗口', async () => {
  const prisma = database([[identity], [{ count: 0n }]]);
  await expect(assertCategoryConflictTestDatabase(prisma, url, exclusive)).resolves.toBeUndefined();
  expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
});
it.each([
  { ...identity, database: 'other' },
  { ...identity, schema: 'other' },
  { ...identity, port: 9999 },
  { ...identity, user: 'other' },
])('实际库身份不同就中止，不继续检查或写入 %j', async (actual) => {
  const prisma = database([[actual]]);
  await expect(assertCategoryConflictTestDatabase(prisma, url, exclusive)).rejects.toThrow('实际 PostgreSQL');
  expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
});
it('既有库仍有其他客户端连接则拒绝独占测试', async () => {
  await expect(
    assertCategoryConflictTestDatabase(database([[identity], [{ count: 1n }]]), url, exclusive),
  ).rejects.toThrow('其他客户端');
});
