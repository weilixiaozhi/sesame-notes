import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

import { ApiError } from '../../shared/errors.js';

/** 单实例下载预算：每 IP 两路、全局八路，共享每秒 4 MiB 的发送预算。 */
export class ReleaseDownloads {
  private readonly clients = new Map<string, number>();
  private active = 0;
  private nextSendAt = 0;

  /** 分配连接名额，返回可重复调用的释放函数；拒绝请求不会打开上游连接。 */
  acquire(ip: string): () => void {
    const count = this.clients.get(ip) ?? 0;
    if (count >= 2 || this.active >= 8) {
      throw new ApiError(429, 'APP_DOWNLOAD_BUSY', '下载请求较多，请稍后重试');
    }
    this.clients.set(ip, count + 1);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.clients.get(ip) ?? 1) - 1;
      if (remaining === 0) this.clients.delete(ip);
      else this.clients.set(ip, remaining);
      this.active--;
    };
  }

  /** 小块按全局时间预算发送，背压限制预读；取消时中止等待并关闭上游读取器。 */
  async *transfer(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of body) {
        for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
          signal.throwIfAborted();
          const part = chunk.subarray(offset, offset + 64 * 1024);
          const now = performance.now();
          // 所有连接共享同一预算，不能通过同时打开多路下载提高总发送速率。
          this.nextSendAt = Math.max(now, this.nextSendAt) + (part.byteLength * 1000) / (4 * 1024 * 1024);
          await delay(Math.max(1, Math.ceil(this.nextSendAt - now)), undefined, { signal });
          signal.throwIfAborted();
          yield part;
        }
      }
    } catch (error) {
      throw new Error('安装包传输已停止', { cause: error });
    }
  }
}

type CacheEntry = { expiresAt: number; value?: unknown; error?: ApiError };

/** 发布数据的小容量缓存：合并同键请求，限制上游并发及全局每分钟查询量。 */
export class ReleaseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private windowEnd = 0;
  private requests = 0;

  /** 缓存成功值和不存在结果；临时故障不缓存，调用方可在上游恢复后重试。 */
  async get<T>(key: string, loader: () => Promise<T>): Promise<T> {
    try {
      const now = Date.now();
      for (const [entryKey, entry] of this.entries) {
        if (entry.expiresAt <= now) this.entries.delete(entryKey);
      }
      const cached = this.entries.get(key);
      if (cached?.error) throw cached.error;
      if (cached) return cached.value as T;
      const existing = this.pending.get(key);
      if (existing) return (await existing) as T;
      if (now >= this.windowEnd) {
        this.windowEnd = now + 60_000;
        this.requests = 0;
      }
      if (this.pending.size >= 8 || this.requests >= 60) {
        throw new ApiError(429, 'APP_RELEASE_BUSY', '更新请求较多，请稍后重试');
      }
      this.requests++;
      const operation = this.load(key, loader);
      this.pending.set(key, operation);
      return await operation;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error('读取发布缓存失败', { cause: error });
    }
  }

  /** 上游结果最多保存六十秒和六十四项，异常路径也必须释放并发名额。 */
  private async load<T>(key: string, loader: () => Promise<T>): Promise<T> {
    try {
      const value = await Promise.resolve().then(loader);
      this.save(key, { value, expiresAt: Date.now() + 60_000 });
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        this.save(key, { error, expiresAt: Date.now() + 60_000 });
      }
      throw error;
    } finally {
      this.pending.delete(key);
    }
  }

  /** 删除最早插入项后保存新值，保持缓存占用有界。 */
  private save(key: string, entry: CacheEntry): void {
    if (this.entries.size >= 64) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }
}
