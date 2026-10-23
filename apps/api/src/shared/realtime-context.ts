import { AsyncLocalStorage } from 'node:async_hooks';

declare module 'fastify' {
  interface FastifyRequest {
    syncChangeIds: Set<bigint>;
    realtimeRevalidationUserIds: Set<string>;
  }
}

const changeIdsByRequest = new AsyncLocalStorage<Set<bigint>>();

/** 在 Fastify 请求生命周期内绑定同步事件集合，并把上下文传给后续异步调用。 */
export function runWithRealtimeContext(changeIds: Set<bigint>, callback: () => void): void {
  changeIdsByRequest.run(changeIds, callback);
}

/** 记录本请求尝试创建的同步事件；响应阶段再查数据库过滤已回滚的事件。 */
export function recordSyncChangeId(changeId: bigint): void {
  changeIdsByRequest.getStore()?.add(changeId);
}
