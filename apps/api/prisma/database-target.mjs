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
      throw new Error('部署目标必须是明确业务库与 public schema，附加参数仅支持连接池、超时和 TLS 传输配置');
    return {
      database,
      username: decodeURIComponent(url.username),
      target: `${url.hostname}:${url.port || '5432'}/${database}`,
    };
  } catch (cause) {
    // URL解析异常会把带凭据的原始输入保存在input属性中，日志仅保留安全的错误说明。
    const details = cause instanceof TypeError ? new Error('DATABASE_URL格式无法解析') : cause;
    throw new Error('数据库部署连接配置无效', { cause: details });
  }
}

/** 部署维护只占用一个连接，保留原有超时和 TLS 设置，原部署 URL 不会被改写。 */
export function databaseSetupDatasourceUrl(databaseUrl = process.env.DATABASE_URL) {
  try {
    databaseIdentity(databaseUrl);
    const url = new URL(databaseUrl);
    url.searchParams.set('connection_limit', '1');
    return url.toString();
  } catch (cause) {
    throw new Error('数据库部署连接配置准备失败', { cause });
  }
}

/** 在任何部署准备写入前核对实际连接身份，配置声明不能代替数据库返回的事实。 */
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
    throw new Error('数据库部署目标身份核验失败', { cause });
  }
}

/** 部署入口和各部署事务共用业务库及 public schema 目标核验。 */
export async function assertDatabaseSetupTarget(prisma, databaseUrl = process.env.DATABASE_URL) {
  return verifyDatabaseIdentity(prisma, databaseIdentity(databaseUrl));
}
