import type { Prisma, PrismaClient } from '@prisma/client';

/** 保留部署传输配置，为升级维护创建单连接 URL。 */
export function databaseUpgradeDatasourceUrl(databaseUrl?: string): string;

/** 部署入口和升级事务在写入前验证真实连接与目标业务库身份。 */
export function assertDatabaseUpgradeTarget(
  prisma: PrismaClient | Prisma.TransactionClient,
  databaseUrl?: string,
): Promise<{ database: string; username: string; target: string }>;

/** 自动升级的持久结果；重复部署返回相同切点且 applied 为 false。 */
export type SyncProtocolUpgradeResult = {
  applied: boolean;
  target: string;
  original_cursor: string;
  completed_at: string;
};

/** 在现有部署连接的独占维护事务中完成协议切换，保留已完成的原始切点。 */
export function completeSyncProtocolUpgrade(
  prisma: PrismaClient,
  databaseUrl?: string,
): Promise<SyncProtocolUpgradeResult>;
