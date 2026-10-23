/** 一代会话只复用本代核对请求，作废时中止旧请求并立即解除单飞引用。 */
export class SessionVerification<T> {
  generation = 0;
  private pending: { generation: number; controller: AbortController; promise: Promise<T | undefined> } | null = null;

  /** 登录、退出或失效建立新代，迟到的旧结果和错误都不进入新会话。 */
  invalidate(): void {
    this.generation += 1;
    this.pending?.controller.abort();
    this.pending = null;
  }

  /** 同代请求单飞；旧代即使无法实际取消网络，也只返回已丢弃状态。 */
  run(load: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (this.pending?.generation === this.generation) return this.pending.promise;
    const generation = this.generation;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const result = await load(controller.signal);
        return generation === this.generation ? result : undefined;
      } catch (error) {
        if (generation !== this.generation) return undefined;
        throw error;
      }
    })().finally(() => {
      // finally 在单飞引用注册后的微任务中清理，同步抛错也不会留下失效的引用。
      if (this.pending?.generation === generation && this.pending.controller === controller) this.pending = null;
    });
    this.pending = { generation, controller, promise };
    return promise;
  }
}

/**
 * 登录和退出的响应正文可能晚于会话切换；仅当前代能够提交成功或失败状态。
 * 失败回调只处理本代错误，已过期的成功、401 正文和网络错误均被丢弃。
 */
export async function performSessionOperation<T, V>(
  gate: SessionVerification<V>,
  operation: () => Promise<T>,
  succeed: (value: T) => void | Promise<void>,
  fail: (error: unknown) => void | Promise<void>,
): Promise<void> {
  const generation = gate.generation;
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    if (generation === gate.generation) await fail(error);
    return;
  }
  if (generation === gate.generation) await succeed(result);
}
