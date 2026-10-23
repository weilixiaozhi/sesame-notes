import type { PrismaClient } from '@prisma/client';
import { resolveTestEnvironment } from './test-database.js';

const EXCLUSIVE_WINDOW = 'sesame_notes:api-8080-stopped';

/** Validate the single existing database without printing connection credentials. */
export function existingTestDatabaseUrl(value: string | undefined, env: NodeJS.ProcessEnv): string {
  if (!value) throw new Error('Existing API tests require E2E_DATABASE_URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Existing API tests require a valid PostgreSQL URL.');
  }
  if (
    env.E2E_DATABASE_MODE !== 'existing-exclusive' ||
    env.E2E_EXCLUSIVE_WINDOW !== EXCLUSIVE_WINDOW ||
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '55432' ||
    url.pathname !== '/sesame_notes' ||
    !url.username ||
    !!url.hash ||
    [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public') ||
    url.searchParams.getAll('schema').length > 1
  ) {
    throw new Error('Existing API tests require the approved exclusive localhost:55432/sesame_notes window.');
  }
  return value;
}

/** Preserve local isolated runs; an existing-mode request can never select another database. */
export function guardedTestDatabaseUrl(value: string | undefined, env: NodeJS.ProcessEnv): string {
  if (env.E2E_DATABASE_MODE !== undefined || env.E2E_EXCLUSIVE_WINDOW !== undefined)
    return existingTestDatabaseUrl(value, env);
  if (!value) throw new Error('API tests require E2E_DATABASE_URL.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('API tests require a valid PostgreSQL URL.');
  }
  // 固定测试库沿用完整的环境身份、凭据一致性与连接选项校验。
  if (['/sesame_notes_test', '/sesame_notes_test_ci'].includes(url.pathname))
    return resolveTestEnvironment({ ...env, E2E_DATABASE_URL: value }).E2E_DATABASE_URL;
  if (
    (env.SESAME_ENV !== undefined && env.SESAME_ENV !== 'test') ||
    (env.NODE_ENV !== undefined && !['development', 'test'].includes(env.NODE_ENV)) ||
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !/^\/sesame_test_[a-z0-9_]+$/.test(url.pathname) ||
    !url.username ||
    value.trim() !== value ||
    !!url.hash ||
    [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public') ||
    url.searchParams.getAll('schema').length > 1
  )
    throw new Error('API tests require a local isolated database or the approved existing database window.');
  // 临时库也不能通过两个变量指向不同目标，避免部分客户端沿用错误的默认连接。
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== value)
    throw new Error('Isolated DATABASE_URL and E2E_DATABASE_URL must identify the same explicit target.');
  return value;
}

/** 数据库测试必须显式选择固定测试库或本轮隔离库，禁止默认连接业务库。 */
export function testFixtureDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return guardedTestDatabaseUrl(env.E2E_DATABASE_URL, env);
}

/** Read-only identity and exclusivity checks run before any application fixture is created. */
export async function assertExistingTestDatabase(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  value: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const url = new URL(existingTestDatabaseUrl(value, env));
  const [identity] = await prisma.$queryRaw<Array<{ database: string; port: number; schema: string; user: string }>>`
    SELECT current_database() AS database, inet_server_port() AS port,
      current_schema() AS schema, current_user AS "user"
  `;
  if (
    !identity ||
    identity.database !== 'sesame_notes' ||
    identity.port !== 5432 ||
    identity.schema !== 'public' ||
    identity.user !== decodeURIComponent(url.username)
  )
    throw new Error('Existing API database identity does not match the approved database.');
  const [connections] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM pg_stat_activity
    WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()
  `;
  if (!connections || connections.count !== 0n)
    throw new Error('Existing API database has other client connections; stop before creating fixtures.');
  // Application generation reads use upsert; require its singleton to exist before importing fixtures.
  const epochs = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM public.server_epochs WHERE id = 0
  `;
  if (epochs.length !== 1 || epochs[0]?.id !== 0)
    throw new Error('Existing API server epoch is missing; no test fixtures were started.');
}

/** Per-suite adapters also protect direct execution outside the existing-suite configuration. */
export async function assertGuardedTestDatabase(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  value: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  guardedTestDatabaseUrl(value, env);
  if (env.E2E_DATABASE_MODE === 'existing-exclusive') await assertExistingTestDatabase(prisma, value, env);
}

/** 分类回滚测试清理后核对临时触发器和函数，防止数据库对象残留。 */
export async function assertTestTriggerRemoved(prisma: Pick<PrismaClient, '$queryRaw'>, name: string): Promise<void> {
  const prefix = 'category_rollback_';
  if (!name.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(name.slice(prefix.length)))
    throw new Error('Unexpected transient test object identity.');
  const [state] = await prisma.$queryRaw<Array<{ triggers: bigint; functions: bigint }>>`
    SELECT
      (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='sync_changes' AND t.tgname=${name}) AS triggers,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname=${name}) AS functions
  `;
  if (!state || state.triggers !== 0n || state.functions !== 0n)
    throw new Error(`Transient test trigger/function was not completely removed: ${name}`);
}

/** Only exclusive runs can assert that shared test lock keys have no remaining holder or waiter. */
export async function assertExclusiveTestLocksReleased(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (env.E2E_DATABASE_MODE !== 'existing-exclusive') return;
  const [state] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM pg_locks
    WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND ((locktype='advisory' AND classid=1936028513 AND objid=1 AND objsubid=2)
        OR (locktype='relation' AND relation='public.sync_changes'::regclass AND mode='AccessExclusiveLock'))
  `;
  if (!state || state.count !== 0n) throw new Error('An exclusive API test lock remains held or awaited.');
}
