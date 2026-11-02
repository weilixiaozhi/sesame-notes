import type { Prisma, PrismaClient } from '@prisma/client';

export const BASELINE_MIGRATION: string;
export const CURRENT_HISTORY: ReadonlyArray<{ name: string; checksums: string[] }>;
/** 读取不含环境身份的当前数据库结构对象。 */
export function readCurrentSchemaSnapshot(
  database: PrismaClient | Prisma.TransactionClient,
): Promise<Array<{ kind: string; name: string; definition: string }>>;
/** 为新空库建库或仅重登记已完整就绪的当前数据库迁移元数据。 */
export function prepareCurrentBaseline(prisma: PrismaClient): Promise<{ mode: 'fresh' | 'current' | 'adopted' }>;
