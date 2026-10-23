import type { Prisma, PrismaClient } from '@prisma/client';

import { ApiError } from './errors.js';
import { SYNC_TRANSACTION_TIMEOUT_MS, TRANSACTION_WAIT_MS } from './operation-budgets.js';
import { recordOperationMetric } from './operation-metrics.js';

declare const syncTransaction: unique symbol;

/** 已在业务读写前取得同步提交锁的事务，事件写入只接受此类型。 */
export type SyncTransaction = Prisma.TransactionClient & { readonly [syncTransaction]: true };

/**
 * 同步写事务的排队与执行窗口：全局提交锁下等待时间算在事务执行窗口内，
 * 连接池偏小或写入突发时排队等待，而不是在默认 2s / 5s 直接失败。
 */
const SYNC_TRANSACTION_OPTIONS = { maxWait: TRANSACTION_WAIT_MS, timeout: SYNC_TRANSACTION_TIMEOUT_MS } as const;

/** 现有事务先取得同步提交锁，再读取业务行；原始数据库异常交给调用方识别与记录。 */
export async function acquireSyncTransactionLock(tx: Prisma.TransactionClient): Promise<SyncTransaction> {
  // 两个 int 键与账号、手机号的单 bigint 锁分属不同键空间，所有写入都先取得同步锁。
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1936028513, 1)`;
  return tx as SyncTransaction;
}

/** 在同一数据库事务内按提交顺序分配同步序号，锁一直持有到提交或回滚。 */
export async function withSyncTransaction<T>(
  prisma: PrismaClient,
  operation: (tx: SyncTransaction) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let succeeded = false;
  let lockWaitMs = 0;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const waiting = performance.now();
      let locked: SyncTransaction;
      try {
        locked = await acquireSyncTransactionLock(tx);
      } finally {
        lockWaitMs = performance.now() - waiting;
      }
      return operation(locked);
    }, SYNC_TRANSACTION_OPTIONS);
    succeeded = true;
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // 路由错误边界记录带请求上下文的完整 cause，并返回友好错误。
    throw new Error('同步写事务失败', { cause: error });
  } finally {
    recordOperationMetric('sync_write', performance.now() - started, succeeded, lockWaitMs);
  }
}
