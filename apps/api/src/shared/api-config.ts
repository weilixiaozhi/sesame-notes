/** API 服务配置类型。 类型置于 shared 供业务模块以纯类型依赖引用，避免模块反向依赖入口 config； 环境变量读取与校验逻辑保留在 src/config.ts。 */
export type ApiConfig = {
  deploymentEnvironment?: 'test' | 'prod';
  databaseUrl: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  storagePath: string;
  exchangeRateUpstream: string;
  exchangeRateCacheTtlSeconds: number;
  port: number;
  host: string;
  corsOrigins: string[];
  /** 独立后台浏览器来源白名单；未配置时不开放浏览器后台登录。 */
  adminOrigins?: string[];
  /** 管理员会话服务端绝对有效期；默认 8 小时。 */
  adminSessionTtlSeconds?: number;
  /** 管理员会话闲置有效期；默认 30 分钟。 */
  adminSessionIdleTtlSeconds?: number;
  rateLimitMax: number;
  authRateLimitMax: number;
  syncRetentionMinCursor: number;
  /** 可信反向代理（宿主机 Nginx 等）的 IP/CIDR 列表：限流与审计只信任这些来源的转发头 */
  trustProxyCidrs: string[];
  /** 客户端更新仓库的 owner/repo；未配置时关闭更新入口。 */
  githubReleaseRepository?: string;
  /** 读取私有仓库 Release 附件的只读 Token；公开仓库可留空。 */
  githubReleaseToken: string;
};
