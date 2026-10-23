import type { Prisma } from '@prisma/client';

import { ApiError } from './errors.js';
import { currentIdempotencyGeneration } from './server-generations.js';

/** 幂等键有效期：成功响应只在一天内可重放，避免缓存无限增长。 */
const IDEMPOTENCY_TTL_MS = 86_400_000;

/**
 * 读取幂等键的既有响应。
 *
 * generation 语义：只有「当前 generation 写入」的键才命中重放；generation 轮换后旧键失效，
 * 重放的旧请求必须按新请求处理。同一键配不同请求体是客户端错误，直接 409 而不是静默返回旧结果。
 * 返回 null 表示未命中（无键、已过期或旧 generation），此时旧键已被删除，调用方按新请求继续。
 */
export async function findIdempotentReplay<T>(
  tx: Prisma.TransactionClient,
  userId: string,
  key: string,
  requestHash: string,
  now: Date,
): Promise<T | null> {
  // 协议保留前缀不能由 HTTP 调用者占用，永久同步身份存储在独立表中。
  if (key.startsWith('category-source:'))
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', '该幂等键前缀保留给同步协议');
  const currentGeneration = await currentIdempotencyGeneration(tx);
  const existing = await tx.idempotencyKey.findFirst({ where: { userId, key } });
  if (existing && existing.generation === currentGeneration && existing.expiresAt > now) {
    if (existing.requestHash !== requestHash)
      throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', '该幂等键已用于不同请求');
    return existing.response as T;
  }
  if (existing) await tx.idempotencyKey.delete({ where: { id: existing.id } });
  return null;
}

/** 首次成功响应写入幂等键；与业务写入同一事务提交，两者要么同时可见要么同时回滚。 */
export async function storeIdempotentResult(
  tx: Prisma.TransactionClient,
  userId: string,
  key: string,
  requestHash: string,
  response: unknown,
  now: Date,
  expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
): Promise<void> {
  await tx.idempotencyKey.create({
    data: {
      userId,
      key,
      requestHash,
      response: response as Prisma.InputJsonValue,
      expiresAt,
      generation: await currentIdempotencyGeneration(tx),
    },
  });
}
