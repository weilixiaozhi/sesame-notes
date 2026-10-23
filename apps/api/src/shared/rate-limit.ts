import type { FastifyReply, FastifyRequest } from 'fastify';

import { ApiError } from './errors.js';

type RateLimitState = { count: number; resetAt: number };

const MAX_RATE_LIMIT_BUCKETS = 10_000;

/** 基于内存固定窗口的限流 preHandler。 单实例部署下与官方内存存储等价；部署多个 API 副本时命中率按实例分摊， 需提升为共享存储（Redis 等）时再替换实现，接口签名保持不变。 */
export function createRateLimit(max: number, windowMs: number) {
  return createMultiKeyRateLimit(max, windowMs, () => null);
}

/**
 * 多维度限流 preHandler：每个请求同时计入 IP 桶与调用方提供的次级桶
 * （如规范化手机号的不可逆摘要），任一维度超限即返回 429。
 *
 * 设计意图：认证接口必须同时防「单 IP 批量试探」与「单手机号跨 IP 试探」，
 * 次级 key 由调用方以不可逆摘要形式给出，限流 key 与日志都不保存完整手机号。
 */
export function createMultiKeyRateLimit(
  max: number,
  windowMs: number,
  secondaryKeyOf: (request: FastifyRequest) => string | null,
) {
  const hits = new Map<string, RateLimitState>();

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();
    // 固定窗口的到期时间按插入顺序递增，遇到首个活跃桶即可停止清扫。
    for (const [key, entry] of hits) {
      if (entry.resetAt > now) break;
      hits.delete(key);
    }

    const secondary = secondaryKeyOf(request);
    const keys = secondary === null ? [request.ip] : [request.ip, `phone:${secondary}`];
    const newKeyCount = new Set(keys.filter((key) => !hits.has(key))).size;
    if (hits.size + newKeyCount > MAX_RATE_LIMIT_BUCKETS) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(windowMs / 1000))));
      throw new ApiError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    }

    for (const key of keys) {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.delete(key);
        hits.set(key, { count: 1, resetAt: now + windowMs });
        continue;
      }
      entry.count += 1;
      if (entry.count > max) {
        reply.header('retry-after', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
        throw new ApiError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
      }
    }
  };
}
