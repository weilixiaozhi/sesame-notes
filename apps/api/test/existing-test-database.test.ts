import type { PrismaClient } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import {
  assertExistingTestDatabase,
  assertExclusiveTestLocksReleased,
  assertTestTriggerRemoved,
  assertGuardedTestDatabase,
  existingTestDatabaseUrl,
  guardedTestDatabaseUrl,
} from './existing-test-database.js';

const url = 'postgresql://fixture:secret-not-for-logs@localhost:55432/sesame_notes';
const env = { E2E_DATABASE_MODE: 'existing-exclusive', E2E_EXCLUSIVE_WINDOW: 'sesame_notes:api-8080-stopped' };
const identity = { database: 'sesame_notes', port: 5432, schema: 'public', user: 'fixture' };
function database(results: unknown[]) {
  return {
    $queryRaw: vi.fn().mockImplementation(async () => {
      if (!results.length) throw new Error('Unexpected database query.');
      return results.shift();
    }),
  } as unknown as Pick<PrismaClient, '$queryRaw'>;
}

it.each([url, url.replace('localhost', '127.0.0.1'), `${url}?schema=public`])(
  'accepts the exact approved endpoint %#',
  (value) => {
    expect(existingTestDatabaseUrl(value, env)).toBe(value);
  },
);
it.each([
  undefined,
  'malformed',
  url.replace('postgresql:', 'https:'),
  url.replace('localhost', '10.20.30.40'),
  url.replace('55432', '5432'),
  url.replace('sesame_notes', 'sesame_test_owned'),
  url.replace('sesame_notes', 'production'),
  `${url}?schema=private`,
  `${url}?schema=public&schema=private`,
  `${url}?schema=public&schema=public`,
  `${url}?options=-csearch_path%3Dother`,
  `${url}?host=remote`,
  `${url}#fragment`,
  'postgresql://localhost:55432/sesame_notes',
])('rejects an unapproved endpoint %#', (value) => {
  expect(() => existingTestDatabaseUrl(value, env)).toThrow();
});
it.each([{}, { E2E_DATABASE_MODE: 'existing-exclusive' }, { ...env, E2E_EXCLUSIVE_WINDOW: 'wrong' }])(
  'requires explicit exclusive flags %j',
  (flags) => {
    expect(() => existingTestDatabaseUrl(url, flags)).toThrow();
  },
);
it('never includes a malformed connection URL in an error', () => {
  try {
    existingTestDatabaseUrl('secret-not-for-logs', env);
  } catch (error) {
    expect(String(error)).not.toContain('secret-not-for-logs');
  }
});
it('keeps local isolated compatibility without allowing an existing-mode bypass', () => {
  const isolated = url.replace('sesame_notes', 'sesame_test_owned');
  expect(guardedTestDatabaseUrl(isolated, {})).toBe(isolated);
  expect(guardedTestDatabaseUrl(url, env)).toBe(url);
  expect(() => guardedTestDatabaseUrl(isolated, env)).toThrow();
  expect(() => guardedTestDatabaseUrl(isolated.replace('localhost', 'remote'), {})).toThrow();
  expect(() => guardedTestDatabaseUrl(url, {})).toThrow();
});
it('固定测试库要求明确环境与一致的数据库凭据', () => {
  const named = url.replace('sesame_notes', 'sesame_notes_test');
  const configuration = { SESAME_ENV: 'test', DATABASE_URL: named, E2E_DATABASE_URL: named };
  expect(guardedTestDatabaseUrl(named, configuration)).toBe(named);
  expect(() => guardedTestDatabaseUrl(named, {})).toThrow('SESAME_ENV');
  expect(() => guardedTestDatabaseUrl(named, { ...configuration, SESAME_ENV: 'prod' })).toThrow('SESAME_ENV');
  expect(() =>
    guardedTestDatabaseUrl(named, { ...configuration, DATABASE_URL: named.replace('fixture:', 'other:') }),
  ).toThrow('same test target');
});
it('用户持久验收库不能作为自动测试目标', () => {
  const preview = url.replace('55432/sesame_notes', '55433/sesame_notes_test');
  expect(() => guardedTestDatabaseUrl(preview, { SESAME_ENV: 'test', DATABASE_URL: preview })).toThrow(
    'only the named local test or CI database endpoint',
  );
});
it('隔离库拒绝生产环境与不一致的默认连接', () => {
  const isolated = url.replace('sesame_notes', 'sesame_test_owned');
  expect(() => guardedTestDatabaseUrl(isolated, { SESAME_ENV: 'prod' })).toThrow();
  expect(() => guardedTestDatabaseUrl(isolated, { NODE_ENV: 'production' })).toThrow();
  expect(() => guardedTestDatabaseUrl(isolated, { DATABASE_URL: url })).toThrow('same explicit target');
});
it('checks the actual database and all other client connections', async () => {
  const prisma = database([[identity], [{ count: 0n }], [{ id: 0 }]]);
  await expect(assertExistingTestDatabase(prisma, url, env)).resolves.toBeUndefined();
  expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
});
it.each([{ epochs: [] }, { epochs: [{ id: 1 }] }])(
  'rejects a missing server epoch without writing %#',
  async ({ epochs }) => {
    const prisma = {
      ...database([[identity], [{ count: 0n }], epochs]),
      $executeRaw: vi.fn(),
      $executeRawUnsafe: vi.fn(),
      serverEpoch: { upsert: vi.fn(), create: vi.fn(), update: vi.fn() },
    };
    await expect(assertExistingTestDatabase(prisma, url, env)).rejects.toThrow(
      'Existing API server epoch is missing; no test fixtures were started.',
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    for (const [query] of vi.mocked(prisma.$queryRaw).mock.calls)
      expect(Array.isArray(query) ? query.join('') : String(query)).toMatch(/^\s*SELECT\b/);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.serverEpoch.upsert).not.toHaveBeenCalled();
    expect(prisma.serverEpoch.create).not.toHaveBeenCalled();
    expect(prisma.serverEpoch.update).not.toHaveBeenCalled();
  },
);
it.each([
  undefined,
  { ...identity, database: 'other' },
  { ...identity, port: 55432 },
  { ...identity, schema: 'other' },
  { ...identity, user: 'other' },
])('fails closed on identity mismatch %j', async (actual) => {
  const prisma = database([actual ? [actual] : []]);
  await expect(assertExistingTestDatabase(prisma, url, env)).rejects.toThrow('identity');
  expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
});
it.each([{ connections: [] }, { connections: [{ count: 1n }] }])(
  'rejects missing or busy connection state',
  async ({ connections }) => {
    await expect(assertExistingTestDatabase(database([[identity], connections]), url, env)).rejects.toThrow(
      'client connections',
    );
  },
);
it('validates configuration before issuing any query', async () => {
  const prisma = database([]);
  await expect(assertExistingTestDatabase(prisma, url, {})).rejects.toThrow();
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
it('the suite adapter checks existing databases but keeps isolated behavior', async () => {
  const prisma = database([[identity], [{ count: 0n }], [{ id: 0 }]]);
  await assertGuardedTestDatabase(prisma, url, env);
  await assertGuardedTestDatabase(database([]), url.replace('sesame_notes', 'sesame_test_owned'), {});
});

it('checks exact transient objects and shared locks after cleanup', async () => {
  await expect(
    assertTestTriggerRemoved(database([[{ triggers: 0n, functions: 0n }]]), `category_rollback_${'a'.repeat(32)}`),
  ).resolves.toBeUndefined();
  await expect(assertExclusiveTestLocksReleased(database([[{ count: 0n }]]), env)).resolves.toBeUndefined();
});
it.each([
  { triggers: 1n, functions: 0n },
  { triggers: 0n, functions: 1n },
])('rejects remaining test objects %#', async (state) => {
  await expect(assertTestTriggerRemoved(database([[state]]), `category_rollback_${'b'.repeat(32)}`)).rejects.toThrow(
    'not completely removed',
  );
});
it('rejects non-fixture object names before reading the database', async () => {
  const prisma = database([]);
  await expect(assertTestTriggerRemoved(prisma, 'production')).rejects.toThrow('identity');
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
it('reports unreleased locks and leaves isolated compatibility unchanged', async () => {
  await expect(assertExclusiveTestLocksReleased(database([[{ count: 1n }]]), env)).rejects.toThrow('lock remains');
  const prisma = database([]);
  await assertExclusiveTestLocksReleased(prisma, {});
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
});
