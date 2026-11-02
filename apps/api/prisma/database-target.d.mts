import type { Prisma, PrismaClient } from '@prisma/client';

/** 保留部署传输配置，为部署维护创建单连接 URL。 */
export function databaseSetupDatasourceUrl(databaseUrl?: string): string;

/** 部署入口和部署事务在写入前验证真实连接与目标业务库身份。 */
export function assertDatabaseSetupTarget(
  prisma: PrismaClient | Prisma.TransactionClient,
  databaseUrl?: string,
): Promise<{ database: string; username: string; target: string }>;
