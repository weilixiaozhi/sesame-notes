import type { ApiConfig } from './shared/api-config.js';

// 入口消费方从此处读取配置类型，业务模块直接引用 shared/api-config。
export type { ApiConfig };

// 公开部署模板和测试环境的固定密钥不能用于生产签发登录凭据。
const publicJwtSecrets = new Set([
  'replace-with-the-existing-production-jwt-secret',
  'replace-with-at-least-32-random-bytes',
  'dev-only-secret-that-is-at-least-32-bytes-long',
  'test-only-secret-that-is-at-least-32-bytes',
]);

/** 读取并校验服务端环境变量，避免使用缺失密钥或错误时长启动生产服务。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  try {
    const databaseUrl = env.DATABASE_URL ?? '';
    const deploymentEnvironment = parseDeploymentEnvironment(env.SESAME_ENV);
    if (deploymentEnvironment) {
      let target: URL;
      try {
        target = new URL(databaseUrl);
      } catch {
        throw new Error('DATABASE_URL is invalid for the selected SESAME_ENV');
      }
      if (decodeURIComponent(target.pathname.slice(1)) !== `sesame_notes_${deploymentEnvironment}`)
        throw new Error('DATABASE_URL database does not match SESAME_ENV');
    }
    const jwtSecret = env.JWT_SECRET ?? '';
    const storagePath = env.STORAGE_PATH?.trim() || '';
    if (!databaseUrl) throw new Error('DATABASE_URL 未配置');
    if (!jwtSecret.trim()) throw new Error('JWT_SECRET 未配置，请提供至少 32 字节的随机密钥');
    if (Buffer.byteLength(jwtSecret) < 32) throw new Error('JWT_SECRET 至少需要 32 字节');
    // 任一生产标记都会启用保护，避免遗漏 SESAME_ENV 或误填 NODE_ENV 绕过校验。
    // 仅规范化用于比较的副本，实际签名仍使用原值，保证已有合法密钥继续兼容。
    if (deploymentEnvironment === 'prod' || env.NODE_ENV === 'production') {
      const normalizedSecret = jwtSecret.trim();
      if (Buffer.byteLength(normalizedSecret) < 32)
        throw new Error('生产环境 JWT_SECRET 至少需要 32 字节的有效密钥内容');
      if (publicJwtSecrets.has(normalizedSecret.toLowerCase()))
        throw new Error('生产环境 JWT_SECRET 不能使用公开示例或测试密钥，请配置独立生成的随机密钥');
    }
    if (!storagePath) throw new Error('STORAGE_PATH 未配置');

    const adminSessionTtlSeconds = parsePositiveInteger(env.ADMIN_SESSION_TTL, 28_800, 'ADMIN_SESSION_TTL');
    const adminSessionIdleTtlSeconds = parsePositiveInteger(
      env.ADMIN_SESSION_IDLE_TTL,
      1_800,
      'ADMIN_SESSION_IDLE_TTL',
    );
    if (adminSessionTtlSeconds > 28_800) throw new Error('ADMIN_SESSION_TTL 不得超过 28800 秒');
    if (adminSessionIdleTtlSeconds > Math.min(1_800, adminSessionTtlSeconds))
      throw new Error('ADMIN_SESSION_IDLE_TTL 不得超过 1800 秒或会话绝对有效期');

    return {
      databaseUrl,
      ...(deploymentEnvironment ? { deploymentEnvironment } : {}),
      jwtSecret,
      accessTokenTtlSeconds: parsePositiveInteger(env.ACCESS_TOKEN_TTL, 900, 'ACCESS_TOKEN_TTL'),
      refreshTokenTtlSeconds: parsePositiveInteger(env.REFRESH_TOKEN_TTL, 2_592_000, 'REFRESH_TOKEN_TTL'),
      storagePath,
      exchangeRateUpstream: env.EXCHANGE_RATE_UPSTREAM?.trim() || 'https://api.frankfurter.dev',
      exchangeRateCacheTtlSeconds: parsePositiveInteger(env.EXCHANGE_RATE_CACHE_TTL, 43_200, 'EXCHANGE_RATE_CACHE_TTL'),
      port: parsePositiveInteger(env.PORT, 8080, 'PORT'),
      host: env.HOST?.trim() || '0.0.0.0',
      // CORS 与认证 Cookie 共用来源白名单；同源浏览器也须列入，留空仅支持非 Cookie 客户端。
      corsOrigins: (env.CORS_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
      rateLimitMax: parsePositiveInteger(env.RATE_LIMIT_MAX, 300, 'RATE_LIMIT_MAX'),
      adminOrigins: parseAdminOrigins(
        env.ADMIN_ORIGINS,
        env.NODE_ENV === 'development' && deploymentEnvironment !== 'prod',
      ),
      adminSessionTtlSeconds,
      adminSessionIdleTtlSeconds,
      authRateLimitMax: parsePositiveInteger(env.AUTH_RATE_LIMIT_MAX, 10, 'AUTH_RATE_LIMIT_MAX'),
      // 增量游标有效下限；更旧的 cursor 返回 410，默认 0 不触发过期。
      // 此配置只控制读取边界，不执行历史或墓碑清理。
      syncRetentionMinCursor: parseNonNegativeInteger(env.SYNC_RETENTION_MIN_CURSOR, 0, 'SYNC_RETENTION_MIN_CURSOR'),
      // 更新源只读取显式配置的仓库；私有仓库由服务端附带只读 Token 访问。
      githubReleaseRepository: parseReleaseRepository(env.GITHUB_RELEASE_REPOSITORY),
      githubReleaseToken: env.GITHUB_RELEASE_TOKEN?.trim() || '',
      // 可信代理网段：只信任宿主机反向代理（逗号分隔的 IP/CIDR），
      // 不配置则完全不信任转发头（伪造 X-Forwarded-For 无效）
      trustProxyCidrs: (env.TRUST_PROXY_CIDRS ?? '')
        .split(',')
        .map((cidr) => cidr.trim())
        .filter(Boolean)
        .map((cidr) => {
          if (!/^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(cidr))
            throw new Error(`TRUST_PROXY_CIDRS 包含无效的 IP/CIDR：${cidr}`);
          return cidr;
        }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`服务端配置无效：${detail}`, { cause: error });
  }
}

/** 校验更新仓库的所有者与仓库名，禁止把完整 URL、凭据或额外路径带入 GitHub 请求。 */
function parseReleaseRepository(value: string | undefined): string {
  const repository = value?.trim() ?? '';
  if (!repository) return '';
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[\w.-]{1,100}$/i.test(repository) || /^\.{1,2}$/.test(repository.split('/')[1]!))
    throw new Error('GITHUB_RELEASE_REPOSITORY 必须使用 owner/repo 格式');
  return repository;
}

/** 把正整数环境变量转为数字，并在信任边界拒绝模糊或越界输入。 */
function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

/** 解析允许为零的整数配置，拒绝负数和非整数。 */
function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} 必须是非负整数`);
  return parsed;
}

/** 部署身份只接受 test 或 prod，空值留给显式配置的工具和隔离测试。 */
function parseDeploymentEnvironment(value: string | undefined): ApiConfig['deploymentEnvironment'] {
  const parsed = value?.trim();
  if (!parsed) return undefined;
  if (parsed === 'test' || parsed === 'prod') return parsed;
  throw new Error('SESAME_ENV must be test or prod');
}

/** 公网后台使用 HTTPS 来源；显式开发进程可以精确列出 localhost 的 HTTP 来源。 */
function parseAdminOrigins(value: string | undefined, allowLocalHttp: boolean): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('ADMIN_ORIGINS 必须是完整的来源地址');
    }
    const localDevelopment = allowLocalHttp && parsed.protocol === 'http:' && parsed.hostname === 'localhost';
    if (
      (!localDevelopment && parsed.protocol !== 'https:') ||
      parsed.origin !== origin ||
      parsed.hostname.includes('*')
    )
      throw new Error('ADMIN_ORIGINS 必须是不含路径、凭据或通配符的 HTTPS 来源；开发模式可配置 HTTP localhost');
  }
  return [...new Set(origins)];
}
