import type { PrismaClient } from '@prisma/client';
import { guardedTestDatabaseUrl } from './existing-test-database.js';

/** 仅允许显式隔离库，或已停 API 的固定原测试库独占窗口；不得回退到默认连接。 */
export function categoryConflictTestDatabaseUrl(value: string | undefined, env: NodeJS.ProcessEnv): string {
  return guardedTestDatabaseUrl(value, env);
}

/** 在任何 fixture 写入前复核实际库身份和无其他客户端连接；此检查不创建、清空或迁移数据库。 */
export async function assertCategoryConflictTestDatabase(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  value: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const url = new URL(categoryConflictTestDatabaseUrl(value, env));
  const [identity] = await prisma.$queryRaw<Array<{ database: string; port: number; schema: string; user: string }>>`
    SELECT current_database() AS database, inet_server_port() AS port,
      current_schema() AS schema, current_user AS "user"
  `;
  if (
    !identity ||
    identity.database !== url.pathname.slice(1) ||
    identity.port !== 5432 ||
    identity.schema !== 'public' ||
    identity.user !== decodeURIComponent(url.username)
  ) {
    throw new Error('实际 PostgreSQL 库身份与显式测试连接不一致');
  }
  if (url.pathname !== '/sesame_notes') return;
  const [connections] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM pg_stat_activity
    WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()
  `;
  if (!connections || connections.count !== 0n) {
    throw new Error('原测试库仍有其他客户端连接，拒绝触发器或全局锁测试');
  }
}
