import { AsyncLocalStorage } from 'node:async_hooks';

type OperationMetric = {
  count: number;
  failed: number;
  total_ms: number;
  max_ms: number;
  lock_wait_ms: number;
  bytes: number;
};
export type OperationMetrics = Partial<Record<'sync_write' | 'snapshot', OperationMetric>>;
const contexts = new AsyncLocalStorage<OperationMetrics>();

declare module 'fastify' {
  interface FastifyRequest {
    operationMetrics: OperationMetrics;
  }
}

/** 为一次 HTTP 请求聚合有界的操作耗时，不保存业务载荷或每条事件明细。 */
export function runWithOperationMetrics(metrics: OperationMetrics, callback: () => void): void {
  try {
    contexts.run(metrics, callback);
  } catch (cause) {
    throw new Error('请求运行指标上下文建立失败', { cause });
  }
}

/** 记录事务/快照的成功、等待与体量，调用方在 finally 中保证失败也可观测。 */
export function recordOperationMetric(
  operation: keyof OperationMetrics,
  durationMs: number,
  succeeded: boolean,
  lockWaitMs = 0,
  bytes = 0,
): void {
  const metrics = contexts.getStore();
  if (!metrics) return;
  const current = (metrics[operation] ??= { count: 0, failed: 0, total_ms: 0, max_ms: 0, lock_wait_ms: 0, bytes: 0 });
  const duration = Math.round(durationMs);
  current.count++;
  current.failed += Number(!succeeded);
  current.total_ms += duration;
  current.max_ms = Math.max(current.max_ms, duration);
  current.lock_wait_ms += Math.round(lockWaitMs);
  current.bytes += bytes;
}
