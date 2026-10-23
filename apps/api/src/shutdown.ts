import type { FastifyInstance } from 'fastify';
import { SHUTDOWN_GRACE_MS } from './shared/operation-budgets.js';

type SignalSource = Pick<NodeJS.Process, 'on' | 'off'>;
type ShutdownOptions = { signals?: SignalSource; forceExit?: (code: number) => void; timeoutMs?: number };

/** 接管进程退出信号，停止接收请求并等待应用关闭；超过排空期限时记录失败并强制退出。 */
export function registerShutdown(app: FastifyInstance, options: ShutdownOptions = {}): void {
  const signals = options.signals ?? process;
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  let closing = false;

  /** 清理信号监听器，避免关闭后的应用继续持有进程资源。 */
  function detach(): void {
    signals.off('SIGTERM', shutdown);
    signals.off('SIGINT', shutdown);
  }

  /** 多次信号共用一次关闭过程；定时器保持存活以兜底挂起的数据库或连接。 */
  function shutdown(): void {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => {
      app.log.error('服务关闭超时，强制退出');
      forceExit(1);
    }, options.timeoutMs ?? SHUTDOWN_GRACE_MS);
    void (async () => {
      try {
        app.log.info('正在停止服务并排空请求');
        await app.close();
      } catch (error) {
        app.log.error({ err: error }, '服务关闭失败');
        forceExit(1);
      } finally {
        clearTimeout(timer);
        detach();
      }
    })();
  }

  try {
    signals.on('SIGTERM', shutdown);
    signals.on('SIGINT', shutdown);
    app.addHook('onClose', async () => {
      // 信号发起的关闭要等完整 close Promise 结束后再移除监听，排空期间的第二次信号仍应合并。
      if (!closing) detach();
    });
  } catch (error) {
    detach();
    throw new Error('进程退出处理器注册失败', { cause: error });
  }
}
