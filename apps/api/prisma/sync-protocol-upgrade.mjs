/** 连接池、超时和 TLS 参数不改变业务库身份，沿用部署环境的合法连接设置。 */
function allowedConnectionParameter(key, value) {
  if (key === 'schema') return value === 'public';
  if (key === 'connection_limit') return /^[1-9]\d*$/.test(value);
  if (
    [
      'pool_timeout',
      'connect_timeout',
      'socket_timeout',
      'statement_cache_size',
      'max_connection_lifetime',
      'max_idle_connection_lifetime',
    ].includes(key)
  )
    return /^\d+$/.test(value);
  if (key === 'pgbouncer') return ['true', 'false'].includes(value);
  if (key === 'sslmode') return ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(value);
  if (key === 'sslaccept') return ['strict', 'accept_invalid_certs'].includes(value);
  return ['sslcert', 'sslidentity', 'sslpassword', 'application_name'].includes(key) && value.length > 0;
}

/** 解析部署连接的公开身份，拒绝管理库、其他 schema 与改变连接身份的附加选项。 */
function databaseIdentity(raw) {
  try {
    if (typeof raw !== 'string' || !raw || raw.trim() !== raw) throw new Error('必须提供 DATABASE_URL');
    const url = new URL(raw);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      !['postgresql:', 'postgres:'].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      url.hash ||
      !/^\w[\w.-]{0,62}$/.test(database) ||
      ['postgres', 'template0', 'template1'].includes(database) ||
      [...url.searchParams].some(([key, value]) => !allowedConnectionParameter(key, value)) ||
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length > 1)
    )
      throw new Error('升级目标必须是明确业务库与 public schema，附加参数仅支持连接池、超时和 TLS 传输配置');
    return {
      database,
      username: decodeURIComponent(url.username),
      target: `${url.hostname}:${url.port || '5432'}/${database}`,
    };
  } catch (cause) {
    throw new Error('同步协议升级数据库配置无效', { cause });
  }
}

/** 升级维护只占用一个连接，保留原有超时和 TLS 设置，原部署 URL 不会被改写。 */
export function databaseUpgradeDatasourceUrl(databaseUrl = process.env.DATABASE_URL) {
  try {
    databaseIdentity(databaseUrl);
    const url = new URL(databaseUrl);
    url.searchParams.set('connection_limit', '1');
    return url.toString();
  } catch (cause) {
    throw new Error('数据库升级连接配置准备失败', { cause });
  }
}

/** 在任何升级准备写入前核对实际连接身份，配置声明不能代替数据库返回的事实。 */
async function verifyDatabaseIdentity(prisma, identity) {
  try {
    const [actual] = await prisma.$queryRaw`
      SELECT current_database() AS database, current_schema() AS schema, current_user AS username
    `;
    if (
      !actual ||
      actual.database !== identity.database ||
      actual.schema !== 'public' ||
      actual.username !== identity.username
    )
      throw new Error('实际数据库、schema 或连接账号与部署目标不一致');
    return identity;
  } catch (cause) {
    throw new Error('数据库升级目标身份核验失败', { cause });
  }
}

/** 部署入口和各升级事务共用业务库及 public schema 目标核验。 */
export async function assertDatabaseUpgradeTarget(prisma, databaseUrl = process.env.DATABASE_URL) {
  return verifyDatabaseIdentity(prisma, databaseIdentity(databaseUrl));
}

/** 核对持久切点的完整性，允许未升级的双空状态，拒绝损坏或缺失的单例。 */
async function readCutover(tx) {
  try {
    const [row] = await tx.$queryRaw`
      SELECT sync_cutover_cursor AS cursor, sync_cutover_at AS completed_at
      FROM public.server_epochs WHERE id = 0
    `;
    if (
      !row ||
      (row.cursor === null) !== (row.completed_at === null) ||
      (row.cursor !== null && (typeof row.cursor !== 'bigint' || row.cursor < 0n)) ||
      (row.completed_at !== null &&
        (!(row.completed_at instanceof Date) || !Number.isFinite(row.completed_at.getTime())))
    )
      throw new Error('server_epochs 同步切点缺失或不完整，请核对数据库迁移结果');
    return row;
  } catch (cause) {
    throw new Error('同步协议升级状态读取失败', { cause });
  }
}

/** 维护事务仅允许自己的连接；外部写入者和管理工具必须先退出，不主动终止会话。 */
async function requireStoppedWriters(tx) {
  try {
    const [row] = await tx.$queryRaw`
      SELECT count(*) AS clients FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()
    `;
    if (!row || row.clients !== 0n) throw new Error('目标数据库仍有其他连接，请停止 API、后台任务并关闭数据库管理工具');
  } catch (cause) {
    throw new Error('同步协议自动升级需要独占停写窗口', { cause });
  }
}

/** 返回已持久化的原始切点；重跑只读取结果，不推进水位或重复写入审计。 */
function upgradeResult(identity, row, applied) {
  return {
    applied,
    target: identity.target,
    original_cursor: row.cursor.toString(),
    completed_at: row.completed_at.toISOString(),
  };
}

/**
 * 在数据库部署链中完成一次性协议升级，连接生命周期由 setup 管理。
 * 只设置同步切点与审计，不改变用户内容、历史事件、认证代际或同步绑定身份。
 */
export async function completeSyncProtocolUpgrade(prisma, databaseUrl = process.env.DATABASE_URL) {
  try {
    const identity = databaseIdentity(databaseUrl);
    return await prisma.$transaction(
      async (tx) => {
        await verifyDatabaseIdentity(tx, identity);
        const [schema] = await tx.$queryRaw`
          SELECT to_regclass('public.sync_changes') IS NOT NULL AS initialized,
            (SELECT count(*) = 2 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'server_epochs'
             AND column_name IN ('sync_cutover_cursor', 'sync_cutover_at')) AS installed
        `;
        if (!schema?.installed || !schema.initialized) throw new Error('同步切换结构尚未安装，请先完成数据库迁移');
        const current = await readCutover(tx);
        if (current.cursor !== null) return upgradeResult(identity, current, false);

        await requireStoppedWriters(tx);
        await tx.$executeRaw`SELECT set_config('lock_timeout', '5000', true)`;
        // 与同步业务事务保持相同锁顺序，先等待已开始的同步提交完成。
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1936028513, 1)`;
        // 表锁同时阻止不使用应用约定锁的旧写入者修改事件流或切点。
        await tx.$executeRaw`LOCK TABLE public.sync_changes, public.server_epochs IN SHARE ROW EXCLUSIVE MODE`;
        await requireStoppedWriters(tx);
        const locked = await readCutover(tx);
        if (locked.cursor !== null) return upgradeResult(identity, locked, false);
        const [watermark] = await tx.$queryRaw`
          SELECT COALESCE(MAX(change_id), 0)::bigint AS cursor FROM public.sync_changes
        `;
        if (typeof watermark?.cursor !== 'bigint' || watermark.cursor < 0n)
          throw new Error('当前同步水位无效，无法完成协议升级');
        const completedAt = new Date();
        const affected = await tx.$executeRaw`
          UPDATE public.server_epochs
          SET sync_cutover_cursor = ${watermark.cursor}, sync_cutover_at = ${completedAt}
          WHERE id = 0 AND sync_cutover_cursor IS NULL AND sync_cutover_at IS NULL
        `;
        if (affected !== 1) throw new Error('同步切点状态发生变化，升级事务已停止');
        const target = JSON.stringify({ type: 'database', id: identity.database });
        const metadata = JSON.stringify({
          mode: 'automatic_upgrade',
          source: 'db-init',
          target: identity.target,
          original_cursor: watermark.cursor.toString(),
          result_cursor: watermark.cursor.toString(),
          completed_at: completedAt.toISOString(),
        });
        await tx.$executeRaw`
          INSERT INTO public.audit_logs (actor, action, target, request_id, metadata)
          VALUES ('system', 'sync.protocol_cutover', ${target}::json,
                  'setup:sync-protocol-upgrade', ${metadata}::json)
        `;
        await requireStoppedWriters(tx);
        return upgradeResult(identity, { cursor: watermark.cursor, completed_at: completedAt }, true);
      },
      { maxWait: 5_000, timeout: 120_000 },
    );
  } catch (cause) {
    throw new Error('同步协议自动升级未完成，请保持停写并检查数据库迁移日志；未完成事务已回滚', { cause });
  }
}
