import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { cleanupAvatarFiles } from './modules/accounts/index.js';
import { createFitnessMediaMaintenance } from './modules/fitness/index.js';

/** 仅在实际监听后执行有界维护；关闭时等待本轮完成，避免与数据库断开竞争。 */
export function registerMaintenance(
  app: FastifyInstance,
  prisma: PrismaClient,
  storagePath: string,
): () => Promise<void> {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const mediaMaintenance = createFitnessMediaMaintenance(prisma, storagePath, app.log);

  /** 逐批删除失效缓存，不触碰同步事件、业务墓碑或审计历史。 */
  async function cleanExpiredRows(): Promise<number> {
    const now = new Date();
    let removed = 0;
    for (let batch = 0; batch < 10; batch++) {
      if (stopped) break;
      const keys = await prisma.idempotencyKey.findMany({
        where: { expiresAt: { lte: now } },
        select: { id: true },
        take: 500,
      });
      if (!keys.length) break;
      const result = await prisma.idempotencyKey.deleteMany({
        where: { id: { in: keys.map((key) => key.id) }, expiresAt: { lte: now } },
      });
      removed += result.count;
    }
    if (removed >= 5000) app.log.warn({ removed }, '幂等回执清理达到本轮上限，请检查维护积压');
    return removed;
  }

  /** 同一进程不重叠执行维护，任何失败记录日志后在下一轮重试。 */
  function tick(): void {
    if (running || stopped) return;
    running = (async () => {
      const started = performance.now();
      try {
        await cleanupAvatarFiles(prisma, storagePath, app.log);
        await mediaMaintenance.run();
        const removed = await cleanExpiredRows();
        app.log.info({ removed, duration_ms: Math.round(performance.now() - started) }, '后台维护完成');
      } catch (error) {
        app.log.error({ err: error }, '后台维护失败，将在下一轮重试');
      } finally {
        running = undefined;
      }
    })();
  }

  app.addHook('onListen', async () => {
    tick();
    timer = setInterval(tick, 60 * 60_000);
    timer.unref();
  });
  return async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    await running;
    await mediaMaintenance.close();
  };
}
