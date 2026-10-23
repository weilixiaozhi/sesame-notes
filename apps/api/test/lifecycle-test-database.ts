import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const LIFECYCLE_SUITES = ['database-initialization.test.ts', 'server-generations.test.ts'];
const PREFIXES = { migration: 'sesame_migration_test_', generation: 'sesame_generation_test_' } as const;
type Kind = keyof typeof PREFIXES;
type Identity = { database: string; port: number; user: string; pid: number };
type DatabaseIdentity = { oid: number; owner: string };
const uncertainProcessRuns = new Set<string>();
const haltedRuns = new Set<string>();
const setupDeadlines = new Map<string, number>();
export type LifecycleAttempt = {
  name: string;
  kind: Kind;
  status: 'planned' | 'created' | 'dropped';
  oid?: number;
  owner?: string;
};
export type LifecycleState = {
  version: 1;
  runId: string;
  limit: 13;
  active: string | null;
  halted: boolean;
  cleanupBlocked?: boolean;
  attempts: LifecycleAttempt[];
  failures: string[];
};

/** The input supplies credentials only; every administrative connection targets postgres. */
export function lifecycleDatabaseConfig(env: NodeJS.ProcessEnv) {
  let base: URL;
  try {
    base = new URL(env.E2E_DATABASE_URL ?? '');
  } catch {
    throw new Error('Lifecycle validation requires an explicit valid PostgreSQL endpoint.');
  }
  // 隔离容器的随机映射端口必须再次显式声明，并使用独立标识，不能回落到共享端口。
  const isolatedPort = env.E2E_LIFECYCLE_ISOLATED_PORT;
  const isolatedEndpoint =
    isolatedPort !== undefined &&
    /^[1-9]\d{3,4}$/.test(isolatedPort) &&
    Number(isolatedPort) >= 1024 &&
    Number(isolatedPort) <= 65535 &&
    !['5432', '55432'].includes(isolatedPort) &&
    base.port === isolatedPort &&
    base.pathname === '/sesame_test_lifecycle';
  const approvedEndpoint =
    isolatedPort === undefined ? base.port === '55432' && base.pathname === '/sesame_notes' : isolatedEndpoint;
  if (
    env.E2E_DATABASE_MODE !== 'lifecycle-only' ||
    env.E2E_LIFECYCLE_SUITE !== 'temporary-databases-only-v1' ||
    env.E2E_EXISTING_SUITE !== undefined ||
    env.E2E_EXCLUSIVE_WINDOW !== undefined ||
    !/^[a-f0-9]{32}$/.test(env.E2E_LIFECYCLE_RUN_ID ?? '') ||
    !env.E2E_LIFECYCLE_STATE_PATH ||
    !isAbsolute(env.E2E_LIFECYCLE_STATE_PATH) ||
    !['postgresql:', 'postgres:'].includes(base.protocol) ||
    !['localhost', '127.0.0.1'].includes(base.hostname) ||
    !approvedEndpoint ||
    !base.username ||
    !!base.hash ||
    [...base.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public') ||
    base.searchParams.getAll('schema').length > 1
  ) {
    throw new Error('Lifecycle validation requires the dedicated local temporary-database-only configuration.');
  }
  const admin = new URL(base);
  admin.pathname = '/postgres';
  admin.searchParams.set('connection_limit', '1');
  return {
    baseUrl: base.toString(),
    adminUrl: admin.toString(),
    user: decodeURIComponent(base.username),
    runId: env.E2E_LIFECYCLE_RUN_ID!,
    statePath: env.E2E_LIFECYCLE_STATE_PATH!,
  };
}

export function assertLifecycleSuite(suite: string, env: NodeJS.ProcessEnv): void {
  lifecycleDatabaseConfig(env);
  if (!LIFECYCLE_SUITES.includes(suite)) throw new Error('The lifecycle configuration allows exactly two suites.');
}

export function lifecycleDatabaseSpec(kind: Kind, env: NodeJS.ProcessEnv) {
  const config = lifecycleDatabaseConfig(env);
  const name = `${PREFIXES[kind]}${config.runId.slice(0, 6)}_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(config.baseUrl);
  target.pathname = `/${name}`;
  return { kind, name, url: target.toString() };
}

function readState(path: string): LifecycleState {
  return JSON.parse(readFileSync(path, 'utf8')) as LifecycleState;
}

function ownedName(name: string, kind: Kind, runId: string): boolean {
  if (!['migration', 'generation'].includes(kind)) return false;
  const prefix = `${PREFIXES[kind]}${runId.slice(0, 6)}_`;
  return (
    typeof name === 'string' &&
    kind in PREFIXES &&
    name.startsWith(prefix) &&
    /^[a-f0-9]{32}$/.test(name.slice(prefix.length)) &&
    name.length <= 63
  );
}

function validateState(state: LifecycleState, runId: string, owner: string): void {
  if (
    !state ||
    state.version !== 1 ||
    state.runId !== runId ||
    state.limit !== 13 ||
    typeof state.halted !== 'boolean' ||
    !Array.isArray(state.failures) ||
    (state.cleanupBlocked !== undefined && typeof state.cleanupBlocked !== 'boolean') ||
    !state.failures.every((failure) => typeof failure === 'string') ||
    !Array.isArray(state.attempts) ||
    state.attempts.length > 13 ||
    state.attempts.filter((attempt) => attempt.kind === 'migration').length > 12 ||
    state.attempts.filter((attempt) => attempt.kind === 'generation').length > 1 ||
    new Set(state.attempts.map((attempt) => attempt.name)).size !== state.attempts.length ||
    state.attempts.some(
      (attempt) =>
        !ownedName(attempt.name, attempt.kind, runId) ||
        !['planned', 'created', 'dropped'].includes(attempt.status) ||
        (attempt.oid !== undefined && (!Number.isSafeInteger(attempt.oid) || attempt.oid <= 0)) ||
        (attempt.owner !== undefined && attempt.owner !== owner) ||
        (attempt.status === 'created' && (attempt.oid === undefined || attempt.owner !== owner)),
    ) ||
    (state.active !== null && typeof state.active !== 'string') ||
    state.attempts.filter((attempt) => attempt.status !== 'dropped').length > 1 ||
    (state.active === null
      ? state.attempts.some((attempt) => attempt.status !== 'dropped')
      : !state.attempts.some((attempt) => attempt.name === state.active && attempt.status !== 'dropped'))
  )
    throw new Error('Lifecycle run state does not match this invocation.');
}

/** Subprocess migrations can only receive the exact active lease URL. */
export function assertOwnedLifecycleUrl(url: string, env: NodeJS.ProcessEnv): void {
  const config = lifecycleDatabaseConfig(env);
  const state = readState(config.statePath);
  validateState(state, config.runId, config.user);
  const active = state.attempts.find((attempt) => attempt.name === state.active);
  if (
    !active ||
    active.status !== 'created' ||
    state.halted ||
    haltedRuns.has(config.statePath) ||
    state.cleanupBlocked ||
    uncertainProcessRuns.has(config.statePath)
  )
    throw new Error('There is no active lifecycle lease.');
  const expected = new URL(config.baseUrl);
  expected.pathname = `/${active.name}`;
  if (url !== expected.toString()) throw new Error('Migration target is not the active temporary database.');
}

export function lifecycleSetupBudgetMs(url: string, env: NodeJS.ProcessEnv): number {
  assertOwnedLifecycleUrl(url, env);
  const deadline = setupDeadlines.get(url);
  if (!deadline) throw new Error('Migration process has no locally owned lifecycle deadline.');
  return Math.min(80_000, deadline - Date.now());
}

/** An uncertain subprocess tree must prevent both DROP/recreation races and subsequent CREATEs. */
export function haltLifecycleRun(env: NodeJS.ProcessEnv, message: string, cleanupBlocked = false): void {
  const config = lifecycleDatabaseConfig(env);
  haltedRuns.add(config.statePath);
  if (cleanupBlocked) uncertainProcessRuns.add(config.statePath);
  const state = readState(config.statePath);
  validateState(state, config.runId, config.user);
  state.halted = true;
  state.cleanupBlocked ||= cleanupBlocked;
  state.failures.push(message);
  writeFileSync(config.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

type Client = Pick<PrismaClient, '$queryRaw' | '$executeRawUnsafe' | '$disconnect'>;
type Dependencies = {
  admin: (url: string) => Client;
  database: (url: string) => PrismaClient;
  read: (path: string) => LifecycleState;
  write: (path: string, state: LifecycleState) => void;
  log: (event: { event: string; name: string; oid?: number }) => void;
};

/** Hold one cluster lease, cap CREATE attempts, and remove only the registered name/OID/owner. */
export async function createLifecycleDatabase(
  spec: ReturnType<typeof lifecycleDatabaseSpec>,
  env: NodeJS.ProcessEnv,
  overrides: Partial<Dependencies> = {},
) {
  const config = lifecycleDatabaseConfig(env);
  // Shared Vitest setup imports the pure guards; load Prisma only when a lease is requested.
  const { PrismaClient } = await import('@prisma/client');
  const defaults: Dependencies = {
    admin: (url) => new PrismaClient({ datasourceUrl: url }),
    database: (url) => new PrismaClient({ datasourceUrl: url }),
    read: readState,
    write: (path, state) => writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8'),
    log: (event) => process.stdout.write(`LIFECYCLE_DATABASE ${JSON.stringify(event)}\n`),
  };
  const services = { ...defaults, ...overrides };
  const expected = new URL(config.baseUrl);
  expected.pathname = `/${spec.name}`;
  if (!ownedName(spec.name, spec.kind, config.runId) || spec.url !== expected.toString())
    throw new Error('Lifecycle database identity is not owned by this run.');
  let state = services.read(config.statePath);
  validateState(state, config.runId, config.user);
  let mayPersist = false;

  const admin = services.admin(config.adminUrl);
  let database: PrismaClient | undefined;
  let backendPid: number | undefined;
  let lockAcquired = false;
  let creationAttempted = false;
  let closed = false;
  let dropVerified = false;
  const attempt: LifecycleAttempt = { name: spec.name, kind: spec.kind, status: 'planned' };

  function persist() {
    services.write(config.statePath, state);
  }
  function halt(message: string) {
    if (!mayPersist) return;
    state.halted = true;
    state.failures.push(message);
    persist();
  }
  async function identity() {
    const [actual] = await admin.$queryRaw<Identity[]>`
      SELECT current_database() AS database, inet_server_port() AS port, current_user AS "user", pg_backend_pid() AS pid
    `;
    if (
      !actual ||
      actual.database !== 'postgres' ||
      actual.port !== 5432 ||
      actual.user !== config.user ||
      (backendPid !== undefined && actual.pid !== backendPid)
    )
      throw new Error('Lifecycle administrative identity or lock-holding session changed.');
    backendPid = actual.pid;
  }
  async function targetIdentity() {
    const rows = await admin.$queryRaw<DatabaseIdentity[]>`
      SELECT oid::int AS oid, pg_get_userbyid(datdba)::text AS owner FROM pg_database WHERE datname=${spec.name}
    `;
    return rows[0];
  }
  async function close() {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      try {
        await database?.$disconnect();
      } catch (error) {
        failures.push(error);
      }
      if (creationAttempted) {
        try {
          const latest = services.read(config.statePath);
          validateState(latest, config.runId, config.user);
          state.halted ||= latest.halted || haltedRuns.has(config.statePath);
          state.cleanupBlocked ||= latest.cleanupBlocked || uncertainProcessRuns.has(config.statePath);
          state.failures = [...new Set([...state.failures, ...latest.failures])];
          if (state.cleanupBlocked)
            throw new Error('Lifecycle subprocess termination is uncertain; database cleanup requires review.');
          await identity();
          const current = await targetIdentity();
          if (current) {
            if (current.owner !== config.user || (attempt.oid !== undefined && current.oid !== attempt.oid))
              throw new Error('Lifecycle cleanup refuses a changed database OID or owner.');
            // A response-lost CREATE is owned by its persisted reservation and pre-CREATE absence check.
            attempt.oid ??= current.oid;
            attempt.owner ??= current.owner;
            // Evidence failures must stop later CREATEs, but must not skip this proven-owned DROP.
            try {
              persist();
            } catch (error) {
              failures.push(error);
            }
            await admin.$executeRawUnsafe(`DROP DATABASE "${spec.name}" WITH (FORCE)`);
          }
          if (await targetIdentity()) throw new Error('Lifecycle database still exists after cleanup.');
          dropVerified = true;
          services.log({ event: 'dropped-and-verified', name: spec.name, oid: attempt.oid });
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      if (failures.length) {
        try {
          halt(`Cleanup failed for ${spec.name}; subsequent CREATE operations are forbidden.`);
        } catch (error) {
          failures.push(error);
        }
      }
      if (lockAcquired) {
        try {
          await admin.$queryRaw`SELECT pg_advisory_unlock(1936028513, 15)`;
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await admin.$disconnect();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      try {
        halt(`Lifecycle connection cleanup failed for ${spec.name}.`);
      } catch (error) {
        failures.push(error);
      }
      throw new AggregateError(failures, 'Lifecycle cleanup failed; stop this run.');
    }
    if (dropVerified) {
      attempt.status = 'dropped';
      state.active = null;
      try {
        persist();
      } catch (error) {
        // Disk still contains the active lease, so another invocation cannot create a database.
        throw new AggregateError([error], 'Lifecycle cleanup evidence could not be saved; stop this run.');
      }
    }
  }

  try {
    await identity();
    const [lock] = await admin.$queryRaw<
      Array<{ acquired: boolean }>
    >`SELECT pg_try_advisory_lock(1936028513, 15) AS acquired`;
    if (!lock?.acquired) throw new Error('Another lifecycle run holds the cluster lease.');
    lockAcquired = true;
    // An earlier reader may have waited until another lease ended; never overwrite its ledger.
    state = services.read(config.statePath);
    validateState(state, config.runId, config.user);
    mayPersist = true;
    if (
      state.halted ||
      haltedRuns.has(config.statePath) ||
      state.cleanupBlocked ||
      uncertainProcessRuns.has(config.statePath) ||
      state.active ||
      state.attempts.length >= state.limit ||
      state.attempts.some((a) => a.status !== 'dropped')
    )
      throw new Error('Lifecycle run is halted, busy, or has exhausted its thirteen CREATE attempts.');
    if (state.attempts.filter((entry) => entry.kind === spec.kind).length >= (spec.kind === 'migration' ? 12 : 1))
      throw new Error('Lifecycle migration/generation CREATE quota is exhausted.');
    const pending = await admin.$queryRaw<Array<{ name: string }>>`
      SELECT datname::text AS name FROM pg_database
      WHERE datname LIKE 'sesame_migration_test_%' OR datname LIKE 'sesame_generation_test_%'
    `;
    if (pending.length)
      throw new Error('An existing temporary lifecycle database requires review; none will be deleted.');
    await identity();
    state.active = spec.name;
    state.attempts.push(attempt);
    persist();
    creationAttempted = true;
    services.log({ event: 'create-attempt', name: spec.name });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${spec.name}"`);
    const created = await targetIdentity();
    if (!created || created.owner !== config.user)
      throw new Error('Created lifecycle database identity cannot be verified.');
    attempt.oid = created.oid;
    attempt.owner = created.owner;
    attempt.status = 'created';
    persist();
    services.log({ event: 'created', name: spec.name, oid: attempt.oid });
    database = services.database(spec.url);
    setupDeadlines.set(spec.url, Date.now() + 100_000);
    return { ...spec, prisma: database, close };
  } catch (error) {
    const failures = [error];
    try {
      halt(`Lifecycle setup failed for ${spec.name}; this run is stopped.`);
    } catch (stateError) {
      failures.push(stateError);
    }
    try {
      await close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw new AggregateError(failures, 'Lifecycle setup failed; no further temporary database may be created.');
  }
}
