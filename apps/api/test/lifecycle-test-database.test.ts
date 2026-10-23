import type { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertLifecycleSuite,
  assertOwnedLifecycleUrl,
  createLifecycleDatabase,
  lifecycleDatabaseConfig,
  lifecycleDatabaseSpec,
  type LifecycleAttempt,
  type LifecycleState,
} from './lifecycle-test-database.js';

// setup.ts imports the pure guards before test collection; reload them against these mocks.
vi.hoisted(() => vi.resetModules());

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(() => {
    throw new Error('A pure lifecycle test attempted a real filesystem write.');
  }),
}));
vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => {
    throw new Error('A pure lifecycle test attempted to construct a real database client.');
  }),
}));

const endpoint = 'postgresql://fixture:secret-not-for-logs@localhost:55432/sesame_notes?schema=public';
const runId = 'a'.repeat(32);
const env: NodeJS.ProcessEnv = {
  E2E_DATABASE_URL: endpoint,
  E2E_DATABASE_MODE: 'lifecycle-only',
  E2E_LIFECYCLE_SUITE: 'temporary-databases-only-v1',
  E2E_LIFECYCLE_RUN_ID: runId,
  E2E_LIFECYCLE_STATE_PATH: resolve('unused-pure-lifecycle-evidence.json'),
};
type Kind = LifecycleAttempt['kind'];
type AdminClient = Pick<PrismaClient, '$queryRaw' | '$executeRawUnsafe' | '$disconnect'>;
type Target = { name: string; oid: number; owner: string };

function emptyState(): LifecycleState {
  return { version: 1, runId, limit: 13, active: null, halted: false, attempts: [], failures: [] };
}

function completed(kind: Kind, number: number): LifecycleAttempt {
  const suffix = number.toString(16).padStart(32, '0');
  return {
    name: `sesame_${kind === 'migration' ? 'migration' : 'generation'}_test_${runId.slice(0, 6)}_${suffix}`,
    kind,
    status: 'dropped',
    oid: number + 100,
    owner: 'fixture',
  };
}

function activeState(spec = lifecycleDatabaseSpec('migration', env)): LifecycleState {
  return {
    ...emptyState(),
    active: spec.name,
    attempts: [{ name: spec.name, kind: spec.kind, status: 'created', oid: 101, owner: 'fixture' }],
  };
}

/** All state, PostgreSQL sessions, and DDL are simulated in memory. */
function harness(initial = emptyState()) {
  const fake = {
    state: structuredClone(initial),
    target: undefined as Target | undefined,
    holder: undefined as number | undefined,
    session: 1000,
    readCount: 0,
    writeCount: 0,
    failWrites: 0,
    failAtWrite: 0,
    responseLost: false,
    dropError: false,
    retainAfterDrop: false,
    databaseDisconnectError: false,
    adminDisconnectError: false,
    unlockError: false,
    databaseFactoryError: false,
    identityDatabase: 'postgres',
    identityPort: 5432,
    identityUser: 'fixture',
    identityPidOverride: undefined as number | undefined,
    onLock: undefined as (() => void) | undefined,
    events: [] as string[],
  };
  const execute = vi.fn(async (sql: string) => {
    const create = /^CREATE DATABASE "([a-z0-9_]+)"$/.exec(sql);
    if (create) {
      const name = create[1]!;
      fake.events.push(`create:${name}`);
      expect(fake.target).toBeUndefined();
      expect(fake.state.active).toBe(name);
      expect(fake.state.attempts.at(-1)).toMatchObject({ name, status: 'planned' });
      expect(fake.state.attempts.length).toBeLessThanOrEqual(13);
      fake.target = { name, oid: 2000 + fake.state.attempts.length, owner: 'fixture' };
      if (fake.responseLost) throw new Error('CREATE succeeded but its response was lost.');
      return 1;
    }
    const drop = /^DROP DATABASE "([a-z0-9_]+)" WITH \(FORCE\)$/.exec(sql);
    if (drop) {
      fake.events.push(`drop:${drop[1]!}`);
      expect(drop[1]).toBe(fake.target?.name);
      expect(fake.state.active).toBe(drop[1]);
      if (fake.dropError) throw new Error('DROP failed.');
      if (!fake.retainAfterDrop) fake.target = undefined;
      return 1;
    }
    throw new Error('Unexpected DDL in the pure lifecycle test.');
  });
  const adminDisconnect = vi.fn(async (pid: number) => {
    fake.events.push('admin-disconnect');
    if (fake.adminDisconnectError) throw new Error('Administrative disconnect failed.');
    if (fake.holder === pid) fake.holder = undefined;
  });
  const admin = vi.fn((url: string): AdminClient => {
    expect(new URL(url).pathname).toBe('/postgres');
    expect(new URL(url).searchParams.get('connection_limit')).toBe('1');
    const pid = ++fake.session;
    return {
      $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const sql = parts.join('?');
        if (sql.includes('current_database()')) {
          return [
            {
              database: fake.identityDatabase,
              port: fake.identityPort,
              user: fake.identityUser,
              pid: fake.identityPidOverride ?? pid,
            },
          ];
        }
        if (sql.includes('pg_try_advisory_lock')) {
          fake.events.push('lock');
          if (fake.holder !== undefined && fake.holder !== pid) return [{ acquired: false }];
          fake.holder = pid;
          fake.onLock?.();
          return [{ acquired: true }];
        }
        if (sql.includes('pg_advisory_unlock')) {
          fake.events.push('unlock');
          if (fake.unlockError) throw new Error('Unlock failed.');
          const unlocked = fake.holder === pid;
          if (unlocked) fake.holder = undefined;
          return [{ pg_advisory_unlock: unlocked }];
        }
        if (sql.includes('WHERE datname=')) {
          const target = fake.target;
          if (!target || target.name !== values[0]) return [];
          return [{ oid: target.oid, owner: target.owner }];
        }
        if (sql.includes('datname LIKE')) return fake.target ? [{ name: fake.target.name }] : [];
        throw new Error('Unexpected administrative query in the pure lifecycle test.');
      }),
      $executeRawUnsafe: execute,
      $disconnect: () => adminDisconnect(pid),
    } as unknown as AdminClient;
  });
  const databaseDisconnect = vi.fn(async () => {
    fake.events.push('database-disconnect');
    if (fake.databaseDisconnectError) throw new Error('Temporary database disconnect failed.');
  });
  const database = vi.fn((url: string) => {
    expect(new URL(url).pathname).toBe(`/${fake.target?.name}`);
    if (fake.databaseFactoryError) throw new Error('Temporary client construction failed.');
    return { $disconnect: databaseDisconnect } as unknown as PrismaClient;
  });
  const read = vi.fn(() => {
    fake.readCount++;
    fake.events.push('read');
    return structuredClone(fake.state);
  });
  const write = vi.fn((_path: string, state: LifecycleState) => {
    fake.writeCount++;
    fake.events.push('write');
    if (fake.failWrites > 0 || fake.writeCount === fake.failAtWrite) {
      fake.failWrites = Math.max(0, fake.failWrites - 1);
      throw new Error('Ledger write failed.');
    }
    fake.state = structuredClone(state);
  });
  const log = vi.fn();
  return {
    fake,
    execute,
    adminDisconnect,
    databaseDisconnect,
    dependencies: { admin, database, read, write, log },
    creates: () => execute.mock.calls.filter(([sql]) => sql.startsWith('CREATE DATABASE')),
    drops: () => execute.mock.calls.filter(([sql]) => sql.startsWith('DROP DATABASE')),
  };
}

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
});

describe('lifecycle endpoint and suite isolation', () => {
  it('隔离容器只接受显式声明的随机回环端口和独立数据库标识', () => {
    try {
      const isolatedUrl = endpoint.replace('55432/sesame_notes', '49170/sesame_test_lifecycle');
      const config = lifecycleDatabaseConfig({
        ...env,
        E2E_DATABASE_URL: isolatedUrl,
        E2E_LIFECYCLE_ISOLATED_PORT: '49170',
      });
      expect(new URL(config.adminUrl).port).toBe('49170');
      expect(new URL(config.adminUrl).pathname).toBe('/postgres');
      expect(() => lifecycleDatabaseConfig({ ...env, E2E_DATABASE_URL: isolatedUrl })).toThrow();
      expect(() => lifecycleDatabaseConfig({ ...env, E2E_LIFECYCLE_ISOLATED_PORT: '49170' })).toThrow();
    } catch (cause) {
      throw new Error('生命周期隔离容器配置回归失败', { cause });
    }
  });

  it.each(['', '1', '5432', '55432', '65536', '049170', '49170x', ' 49170'])('拒绝隔离端口 %j', (port) => {
    try {
      expect(() =>
        lifecycleDatabaseConfig({
          ...env,
          E2E_DATABASE_URL: endpoint.replace('55432/sesame_notes', `${port}/sesame_test_lifecycle`),
          E2E_LIFECYCLE_ISOLATED_PORT: port,
        }),
      ).toThrow();
    } catch (cause) {
      throw new Error('生命周期隔离端口边界回归失败', { cause });
    }
  });

  it.each(['localhost', '127.0.0.1'])('derives administration only through postgres on %s', (host) => {
    const config = lifecycleDatabaseConfig({ ...env, E2E_DATABASE_URL: endpoint.replace('localhost', host) });
    const admin = new URL(config.adminUrl);
    expect(admin.hostname).toBe(host);
    expect(admin.port).toBe('55432');
    expect(admin.pathname).toBe('/postgres');
    expect(admin.searchParams.get('connection_limit')).toBe('1');
    expect(config.user).toBe('fixture');
  });

  it.each([
    undefined,
    'secret-not-for-logs',
    endpoint.replace('postgresql:', 'https:'),
    endpoint.replace('localhost', 'remote.example'),
    endpoint.replace('55432', '5432'),
    endpoint.replace('sesame_notes', 'postgres'),
    endpoint.replace('sesame_notes', 'sesame_test_other'),
    endpoint.replace('fixture:secret-not-for-logs@', ''),
    endpoint.replace('schema=public', 'schema=other'),
    `${endpoint}&schema=public`,
    `${endpoint}&host=remote.example`,
    `${endpoint}#fragment`,
  ])('rejects an unapproved endpoint %# without exposing credentials', (value) => {
    let caught: unknown;
    try {
      lifecycleDatabaseConfig({ ...env, E2E_DATABASE_URL: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain('secret-not-for-logs');
  });

  it.each([
    { E2E_DATABASE_MODE: undefined },
    { E2E_DATABASE_MODE: 'existing-exclusive' },
    { E2E_LIFECYCLE_SUITE: undefined },
    { E2E_LIFECYCLE_SUITE: 'existing-exclusive-v1' },
    { E2E_EXISTING_SUITE: 'existing-exclusive-v1' },
    { E2E_EXCLUSIVE_WINDOW: 'sesame_notes:api-8080-stopped' },
    { E2E_LIFECYCLE_RUN_ID: 'wrong' },
    { E2E_LIFECYCLE_STATE_PATH: undefined },
    { E2E_LIFECYCLE_STATE_PATH: 'relative-state.json' },
  ])('rejects missing lifecycle flags and mixed existing-suite flags %#', (flags) => {
    expect(() => lifecycleDatabaseConfig({ ...env, ...flags })).toThrow();
  });

  it.each(['database-initialization.test.ts', 'server-generations.test.ts'])(
    'allows only the selected suite %s',
    (suite) => {
      expect(() => assertLifecycleSuite(suite, env)).not.toThrow();
    },
  );

  it.each(['', 'admin.test.ts', 'auth.e2e.test.ts', 'database-invariants.test.ts', 'lifecycle-test-database.test.ts'])(
    'rejects suite %s from the lifecycle entry point',
    (suite) => {
      expect(() => assertLifecycleSuite(suite, env)).toThrow();
    },
  );
});

describe('active migration URL ownership', () => {
  it('accepts only the exact active temporary URL', () => {
    const spec = lifecycleDatabaseSpec('migration', env);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(activeState(spec)));
    expect(() => assertOwnedLifecycleUrl(spec.url, env)).not.toThrow();
    expect(readFileSync).toHaveBeenCalledWith(env.E2E_LIFECYCLE_STATE_PATH, 'utf8');
    expect(() => assertOwnedLifecycleUrl(endpoint, env)).toThrow(
      'Migration target is not the active temporary database.',
    );
    expect(() => assertOwnedLifecycleUrl(lifecycleDatabaseSpec('migration', env).url, env)).toThrow(
      'Migration target is not the active temporary database.',
    );
  });

  it.each(['sesame_notes', 'postgres', `sesame_migration_test_bbbbbb_${'c'.repeat(32)}`])(
    'refuses a ledger naming %s as its active database',
    (name) => {
      const state = activeState();
      state.active = name;
      state.attempts[0]!.name = name;
      const url = new URL(endpoint);
      url.pathname = `/${name}`;
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(state));
      expect(() => assertOwnedLifecycleUrl(url.toString(), env)).toThrow(
        'Lifecycle run state does not match this invocation.',
      );
      expect(readFileSync).toHaveBeenCalledWith(env.E2E_LIFECYCLE_STATE_PATH, 'utf8');
    },
  );

  it.each(['wrong-owner', 'invalid-oid', 'missing-oid', 'duplicate-name', 'two-active', 'unknown-kind', 'halted'])(
    'rejects malformed or halted lease evidence: %s',
    (fault) => {
      const spec = lifecycleDatabaseSpec('migration', env);
      const state = activeState(spec);
      const attempt = state.attempts[0]!;
      if (fault === 'wrong-owner') attempt.owner = 'other';
      if (fault === 'invalid-oid') attempt.oid = 0;
      if (fault === 'missing-oid') delete attempt.oid;
      if (fault === 'duplicate-name') state.attempts.push({ ...attempt });
      if (fault === 'two-active')
        state.attempts.push({ ...attempt, name: lifecycleDatabaseSpec('migration', env).name });
      if (fault === 'unknown-kind') attempt.kind = 'other' as Kind;
      if (fault === 'halted') state.halted = true;
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(state));
      expect(() => assertOwnedLifecycleUrl(spec.url, env)).toThrow(
        fault === 'halted'
          ? 'There is no active lifecycle lease.'
          : 'Lifecycle run state does not match this invocation.',
      );
      expect(readFileSync).toHaveBeenCalledWith(env.E2E_LIFECYCLE_STATE_PATH, 'utf8');
    },
  );
});

describe('lifecycle allocation limits', () => {
  it('allows twelve migration leases and one generation lease, then refuses a fourteenth CREATE', async () => {
    const test = harness();
    for (const kind of [...Array.from({ length: 12 }, () => 'migration' as const), 'generation' as const]) {
      const lease = await createLifecycleDatabase(lifecycleDatabaseSpec(kind, env), env, test.dependencies);
      expect(test.fake.state.active).toBe(lease.name);
      await lease.close();
      expect(test.fake.state.active).toBeNull();
      expect(test.fake.target).toBeUndefined();
    }
    expect(test.creates()).toHaveLength(13);
    expect(test.drops()).toHaveLength(13);
    expect(test.fake.state.attempts.filter((attempt) => attempt.kind === 'migration')).toHaveLength(12);
    expect(test.fake.state.attempts.filter((attempt) => attempt.kind === 'generation')).toHaveLength(1);
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.creates()).toHaveLength(13);
  });

  it.each([
    { kind: 'migration' as const, count: 12 },
    { kind: 'generation' as const, count: 1 },
  ])('enforces the separate $kind quota even below the total limit', async ({ kind, count }) => {
    const state = emptyState();
    state.attempts = Array.from({ length: count }, (_, index) => completed(kind, index + 1));
    const test = harness(state);
    await expect(createLifecycleDatabase(lifecycleDatabaseSpec(kind, env), env, test.dependencies)).rejects.toThrow();
    expect(test.creates()).toHaveLength(0);
  });

  it('does not start another CREATE while the first session owns the lease', async () => {
    const test = harness();
    const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies);
    const reserved = structuredClone(test.fake.state);
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.fake.state).toEqual(reserved);
    expect(test.creates()).toHaveLength(1);
    await lease.close();
  });

  it('reloads and preserves another completed lease after acquiring the lock', async () => {
    const test = harness();
    const earlier = completed('migration', 1);
    test.fake.onLock = () => {
      test.fake.state.attempts = [earlier];
    };
    const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('generation', env), env, test.dependencies);
    expect(test.fake.readCount).toBeGreaterThanOrEqual(2);
    expect(test.fake.state.attempts).toHaveLength(2);
    expect(test.fake.state.attempts[0]).toEqual(earlier);
    await lease.close();
  });

  it('refuses creation when the ledger became exhausted while acquiring the lock', async () => {
    const test = harness();
    test.fake.onLock = () => {
      test.fake.state.attempts = [
        ...Array.from({ length: 12 }, (_, index) => completed('migration', index + 1)),
        completed('generation', 13),
      ];
    };
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.fake.state.attempts).toHaveLength(13);
    expect(test.creates()).toHaveLength(0);
  });

  it('refuses unknown kinds, foreign names, and business database targets before any administrative client', async () => {
    const test = harness();
    const original = lifecycleDatabaseSpec('migration', env);
    for (const spec of [
      { ...original, kind: 'other' as Kind },
      { ...original, name: 'sesame_notes', url: endpoint },
      { ...original, url: endpoint },
    ]) {
      await expect(createLifecycleDatabase(spec, env, test.dependencies)).rejects.toThrow();
    }
    expect(test.dependencies.admin).not.toHaveBeenCalled();
    expect(test.creates()).toHaveLength(0);
  });
});

describe('owned cleanup and failure containment', () => {
  it('cleans a response-lost CREATE by its reserved exact identity and stops later CREATEs', async () => {
    const test = harness();
    const spec = lifecycleDatabaseSpec('migration', env);
    test.fake.responseLost = true;
    await expect(createLifecycleDatabase(spec, env, test.dependencies)).rejects.toThrow();
    expect(test.creates()).toEqual([[`CREATE DATABASE "${spec.name}"`]]);
    expect(test.drops()).toEqual([[`DROP DATABASE "${spec.name}" WITH (FORCE)`]]);
    expect(test.fake.target).toBeUndefined();
    expect(test.fake.state.halted).toBe(true);
    expect(test.fake.state.attempts[0]).toMatchObject({ name: spec.name, oid: 2001, owner: 'fixture' });
    test.fake.responseLost = false;
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.creates()).toHaveLength(1);
  });

  it.each(['database-disconnect', 'admin-disconnect', 'unlock'])(
    'still drops the owned database and blocks later CREATE after %s fails',
    async (fault) => {
      const test = harness();
      const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies);
      if (fault === 'database-disconnect') test.fake.databaseDisconnectError = true;
      if (fault === 'admin-disconnect') test.fake.adminDisconnectError = true;
      if (fault === 'unlock') test.fake.unlockError = true;
      await expect(lease.close()).rejects.toThrow();
      expect(test.drops()).toHaveLength(1);
      expect(test.fake.target).toBeUndefined();
      expect(test.fake.state.active).toBe(lease.name);
      expect(test.fake.state.halted).toBe(true);
      test.fake.databaseDisconnectError = false;
      test.fake.adminDisconnectError = false;
      test.fake.unlockError = false;
      await expect(
        createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
      ).rejects.toThrow();
      expect(test.creates()).toHaveLength(1);
    },
  );

  it.each([1, Number.POSITIVE_INFINITY])(
    'attempts proven-owned DROP despite %s cleanup ledger write failures, retaining a stop marker',
    async (failures) => {
      const test = harness();
      const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies);
      test.fake.failWrites = failures;
      await expect(lease.close()).rejects.toThrow();
      expect(test.drops()).toEqual([[`DROP DATABASE "${lease.name}" WITH (FORCE)`]]);
      expect(test.fake.target).toBeUndefined();
      expect(test.fake.state.active).toBe(lease.name);
      test.fake.failWrites = 0;
      await expect(
        createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
      ).rejects.toThrow();
      expect(test.creates()).toHaveLength(1);
    },
  );

  it('retains the existing active reservation when disconnect and every halt write fail', async () => {
    const test = harness();
    const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies);
    test.fake.adminDisconnectError = true;
    test.fake.failWrites = Number.POSITIVE_INFINITY;
    await expect(lease.close()).rejects.toThrow();
    expect(test.drops()).toHaveLength(1);
    expect(test.fake.state.active).toBe(lease.name);
    test.fake.adminDisconnectError = false;
    test.fake.failWrites = 0;
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.creates()).toHaveLength(1);
  });

  it('cleans the database if persisting its post-CREATE identity fails', async () => {
    const test = harness();
    test.fake.failAtWrite = 2;
    const spec = lifecycleDatabaseSpec('migration', env);
    await expect(createLifecycleDatabase(spec, env, test.dependencies)).rejects.toThrow();
    expect(test.drops()).toEqual([[`DROP DATABASE "${spec.name}" WITH (FORCE)`]]);
    expect(test.fake.target).toBeUndefined();
    expect(test.fake.state.halted).toBe(true);
  });

  it('never sends CREATE when its reservation cannot be persisted', async () => {
    const test = harness();
    test.fake.failWrites = Number.POSITIVE_INFINITY;
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.creates()).toHaveLength(0);
    expect(test.drops()).toHaveLength(0);
    expect(test.adminDisconnect).toHaveBeenCalled();
  });

  it('cleans a verified created database if the temporary client cannot be constructed', async () => {
    const test = harness();
    test.fake.databaseFactoryError = true;
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.creates()).toHaveLength(1);
    expect(test.drops()).toHaveLength(1);
    expect(test.fake.target).toBeUndefined();
    expect(test.fake.state.halted).toBe(true);
  });

  it.each(['owner', 'oid'])('refuses DROP when the database %s changed', async (field) => {
    const test = harness();
    const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies);
    if (field === 'owner') test.fake.target!.owner = 'other';
    else test.fake.target!.oid++;
    await expect(lease.close()).rejects.toThrow();
    expect(test.drops()).toHaveLength(0);
    expect(test.fake.target).toBeDefined();
    expect(test.fake.state.active).toBe(lease.name);
    expect(test.fake.state.halted).toBe(true);
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.creates()).toHaveLength(1);
  });

  it.each(['drop-error', 'still-present'])('halts when cleanup cannot prove absence: %s', async (fault) => {
    const test = harness();
    const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies);
    if (fault === 'drop-error') test.fake.dropError = true;
    else test.fake.retainAfterDrop = true;
    await expect(lease.close()).rejects.toThrow();
    expect(test.fake.target).toBeDefined();
    expect(test.fake.state.active).toBe(lease.name);
    expect(test.fake.state.halted).toBe(true);
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.creates()).toHaveLength(1);
  });

  it('refuses to clean an unrelated pre-existing temporary database', async () => {
    const test = harness();
    test.fake.target = { name: completed('migration', 8).name, oid: 208, owner: 'fixture' };
    const previous = { ...test.fake.target };
    await expect(
      createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies),
    ).rejects.toThrow();
    expect(test.creates()).toHaveLength(0);
    expect(test.drops()).toHaveLength(0);
    expect(test.fake.target).toEqual(previous);
  });

  it('rejects a changed administrative session during cleanup without dropping through it', async () => {
    const test = harness();
    const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies);
    test.fake.identityPidOverride = 99999;
    await expect(lease.close()).rejects.toThrow();
    expect(test.drops()).toHaveLength(0);
    expect(test.fake.state.halted).toBe(true);
    expect(test.fake.state.active).toBe(lease.name);
  });

  it('clears active only after the temporary client, lock, and administrative client have closed', async () => {
    const test = harness();
    const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', env), env, test.dependencies);
    const writesBeforeCleanup = test.dependencies.write.mock.calls.length;
    await lease.close();
    expect(test.fake.state.active).toBeNull();
    expect(test.fake.state.attempts[0]!.status).toBe('dropped');
    const lastWrite = test.fake.events.lastIndexOf('write');
    expect(lastWrite).toBeGreaterThan(test.fake.events.lastIndexOf('database-disconnect'));
    expect(lastWrite).toBeGreaterThan(test.fake.events.lastIndexOf('unlock'));
    expect(lastWrite).toBeGreaterThan(test.fake.events.lastIndexOf('admin-disconnect'));
    expect(test.dependencies.write.mock.calls.length).toBeGreaterThan(writesBeforeCleanup);
    await lease.close();
    expect(test.drops()).toHaveLength(1);
  });
});
