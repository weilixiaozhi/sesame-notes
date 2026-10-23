import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaClient, type Prisma } from '@prisma/client';

import { lockAdminSecurity, writeAuditLog } from './modules/admin/index.js';

type RecoveryConfig = {
  mode: 'inspect' | 'apply';
  databaseUrl: string;
  databaseName: string;
  username: string;
  target: string;
  operator: string;
  reason: string;
  backupReference: string;
};

/** 只接受明确模式与数据库身份；目标确认不含密码，检查模式不会要求或执行写入授权。 */
export function serverRecoveryConfig(args: string[], env: NodeJS.ProcessEnv): RecoveryConfig {
  try {
    if (args.length !== 1 || !['--inspect', '--apply'].includes(args[0]!))
      throw new Error('请指定且仅指定 --inspect 或 --apply');
    const raw = env.DATABASE_URL;
    if (!raw || raw.trim() !== raw) throw new Error('必须显式设置 DATABASE_URL');
    const url = new URL(raw);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    if (
      !['postgresql:', 'postgres:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      url.hash ||
      !/^\w[\w.-]{0,62}$/.test(databaseName) ||
      ['postgres', 'template0', 'template1'].includes(databaseName) ||
      [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public') ||
      url.searchParams.getAll('schema').length > 1
    )
      throw new Error('恢复目标必须是明确业务库、public schema，不能使用管理库或附加连接选项');
    const target = `${url.hostname}:${url.port || '5432'}/${databaseName}`;
    const mode = args[0] === '--apply' ? 'apply' : 'inspect';
    const operator = env.SERVER_RECOVERY_OPERATOR?.trim() ?? '';
    const reason = env.SERVER_RECOVERY_REASON?.trim() ?? '';
    const backupReference = env.SERVER_RECOVERY_BACKUP_REFERENCE?.trim() ?? '';
    if (mode === 'apply') {
      if (env.SERVER_RECOVERY_CONFIRM !== target)
        throw new Error(`SERVER_RECOVERY_CONFIRM 必须与恢复目标完全一致：${target}`);
      if (env.SERVER_RECOVERY_MAINTENANCE !== 'API_STOPPED')
        throw new Error('请停掉全部 API/后台/任务写入者，再设置 SERVER_RECOVERY_MAINTENANCE=API_STOPPED');
      if (
        !operator ||
        operator.length > 100 ||
        !reason ||
        reason.length > 500 ||
        !backupReference ||
        backupReference.length > 200
      )
        throw new Error(
          '必须提供有效的 SERVER_RECOVERY_OPERATOR、SERVER_RECOVERY_REASON 与 SERVER_RECOVERY_BACKUP_REFERENCE',
        );
    }
    // 本命令仅使用一个连接；维护窗口检查可以明确排除当前连接而拒绝其他客户端。
    url.searchParams.set('connection_limit', '1');
    return {
      mode,
      databaseUrl: url.toString(),
      databaseName,
      username: decodeURIComponent(url.username),
      target,
      operator,
      reason,
      backupReference,
    };
  } catch (cause) {
    throw new Error('服务器恢复参数校验失败', { cause });
  }
}

/** 核对真实连接身份，不把目标 URL 的声明当成数据库已经匹配的证据。 */
async function assertRecoveryDatabase(tx: Prisma.TransactionClient, config: RecoveryConfig): Promise<void> {
  try {
    const [identity] = await tx.$queryRaw<Array<{ database: string; schema: string; username: string }>>`
      SELECT current_database() AS database, current_schema() AS schema, current_user AS username
    `;
    if (
      !identity ||
      identity.database !== config.databaseName ||
      identity.schema !== 'public' ||
      identity.username !== config.username
    )
      throw new Error('实际数据库、schema 或连接账号与显式恢复目标不一致');
  } catch (cause) {
    throw new Error('恢复数据库身份核对失败', { cause });
  }
}

/** 只允许停止所有服务后的独占窗口，不主动终止用户连接或忽略活动会话。 */
async function assertMaintenanceWindow(tx: Prisma.TransactionClient): Promise<void> {
  try {
    const [row] = await tx.$queryRaw<Array<{ clients: bigint }>>`
      SELECT count(*) AS clients FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
    `;
    if (!row || row.clients !== 0n) throw new Error('目标数据库仍有其他客户端连接，请停服并关闭数据库管理工具后重试');
  } catch (cause) {
    throw new Error('恢复维护窗口未满足独占要求', { cause });
  }
}

/** 输出只读规模预览；不读取密码、会话凭据、正文或代际随机值。 */
async function recoveryCounts(tx: Prisma.TransactionClient) {
  try {
    return {
      ledgers: await tx.ledger.count(),
      day_books: await tx.dayBook.count(),
      memo_books: await tx.memoBook.count(),
      fitness_spaces: await tx.fitnessSpace.count(),
      active_user_sessions: await tx.refreshToken.count({ where: { revokedAt: null } }),
      active_admin_sessions: await tx.adminSession.count({ where: { revokedAt: null } }),
    };
  } catch (cause) {
    throw new Error('恢复对象规模读取失败，请先完成目标库迁移', { cause });
  }
}

/** 在一个维护事务里轮换认证与绑定身份；任何更新或审计失败都会回滚全部改变。 */
async function prepareRecoveredServer(prisma: PrismaClient, config: RecoveryConfig) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await assertRecoveryDatabase(tx, config);
        if (config.mode === 'inspect')
          return { mode: 'inspect', target: config.target, counts: await recoveryCounts(tx) };
        await assertMaintenanceWindow(tx);
        await tx.$executeRaw`SELECT set_config('lock_timeout', '5000', true)`;
        // 同步写入在访问实体前持有此锁；运维不能反向锁住实体后再等待同步提交。
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1936028513, 1)`;
        await lockAdminSecurity(tx);
        // 登录/刷新先锁账号后读代际；按相同方向锁全部账号，再更新 ServerEpoch。
        await tx.$queryRaw`SELECT count(*) FROM (SELECT id FROM users ORDER BY id FOR NO KEY UPDATE) AS locked_users`;
        const counts = await recoveryCounts(tx);
        const now = new Date();
        const operationId = randomUUID();
        await tx.serverEpoch.update({
          where: { id: 0 },
          data: { authGeneration: randomUUID(), idempotencyGeneration: randomUUID(), updatedAt: now },
        });
        // 原生 SQL 只替换绑定代际，保留所有内容时间、实体修订、墓碑与历史事实。
        await tx.$executeRaw`UPDATE ledgers SET sync_id = gen_random_uuid()`;
        await tx.$executeRaw`UPDATE day_books SET sync_id = gen_random_uuid()`;
        await tx.$executeRaw`UPDATE memo_books SET sync_id = gen_random_uuid()`;
        await tx.$executeRaw`UPDATE fitness_spaces SET sync_id = gen_random_uuid()`;
        await tx.refreshToken.updateMany({ where: { revokedAt: null }, data: { revokedAt: now, expiresAt: now } });
        await tx.adminSession.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } });
        await assertMaintenanceWindow(tx);
        await writeAuditLog(tx, {
          actor: 'system',
          action: 'server.recovery_prepared',
          target: { type: 'database', id: config.databaseName },
          requestId: `cli:server-recover:${operationId}`,
          metadata: {
            operator: config.operator,
            reason: config.reason,
            backup_reference: config.backupReference,
            target: config.target,
            counts,
          },
        });
        return {
          mode: 'apply',
          target: config.target,
          operation_id: operationId,
          completed_at: now.toISOString(),
          counts,
        };
      },
      { maxWait: 5_000, timeout: 120_000 },
    );
  } catch (cause) {
    throw new Error('服务器恢复准备失败，事务未完成的改动已回滚', { cause });
  }
}

/** 保留完整错误链用于运维诊断，同时遮蔽连接 URL 中的数据库凭据。 */
function recoveryErrorDetails(error: unknown, depth = 0): string {
  if (depth >= 8) return '错误链过深，已截断';
  if (!(error instanceof Error)) return String(error).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[数据库连接已隐藏]');
  const details = (error.stack ?? error.message).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[数据库连接已隐藏]');
  return error.cause === undefined ? details : `${details}\n原因：${recoveryErrorDetails(error.cause, depth + 1)}`;
}

/** CLI 仅执行检查或恢复后的身份准备，不读取备份、覆盖数据库或自动启动服务。 */
async function main(): Promise<void> {
  let prisma: PrismaClient | undefined;
  try {
    const config = serverRecoveryConfig(process.argv.slice(2), process.env);
    prisma = new PrismaClient({ datasourceUrl: config.databaseUrl });
    const result = await prepareRecoveredServer(prisma, config);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write('服务器恢复准备未完成，请保持停服并检查目标、维护窗口及下方错误日志。\n');
    process.stderr.write(`${recoveryErrorDetails(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (prisma) {
      try {
        await prisma.$disconnect();
      } catch (error) {
        process.stderr.write(`恢复数据库连接关闭失败：${recoveryErrorDetails(error)}\n`);
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
