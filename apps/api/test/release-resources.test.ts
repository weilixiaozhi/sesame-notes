import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseCache, ReleaseDownloads } from '../src/modules/app-release/testing.js';
import { ApiError } from '../src/shared/errors.js';

afterEach(() => vi.useRealTimers());

describe('发布通道资源边界', () => {
  it('每 IP 与全局名额分别受限，重复释放不会制造额外名额', () => {
    const limiter = new ReleaseDownloads();
    const first = limiter.acquire('one');
    limiter.acquire('one');
    expect(() => limiter.acquire('one')).toThrow('下载请求较多');
    first();
    first();
    limiter.acquire('one');
    expect(() => limiter.acquire('one')).toThrow('下载请求较多');
    for (let i = 0; i < 6; i++) limiter.acquire(`other-${i}`);
    expect(() => limiter.acquire('new')).toThrow('下载请求较多');
  });

  it('多个下载共享发送预算，传输取消后停止发送', async () => {
    const limiter = new ReleaseDownloads();
    const controller = new AbortController();
    /** 创建一块可被限速器拆分的输入，记录取消以验证上游被释放。 */
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new Uint8Array(1024 * 1024));
          stream.close();
        },
      });
    /** 消费完整流并统计字节，验证两条实际下载共享总预算。 */
    const consume = async () => {
      let size = 0;
      for await (const chunk of limiter.transfer(body(), controller.signal)) size += chunk.byteLength;
      return size;
    };
    const started = performance.now();
    expect(await Promise.all([consume(), consume()])).toEqual([1024 * 1024, 1024 * 1024]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(450);
    const one = limiter.transfer(body(), controller.signal);
    await one.next();
    controller.abort();
    await expect(one.next()).rejects.toThrow('安装包传输已停止');
  });

  it('同键请求合并，失败释放名额，不存在结果短暂缓存', async () => {
    const cache = new ReleaseCache();
    const loader = vi.fn(async () => ({ version: 1 }));
    await Promise.all(Array.from({ length: 10 }, () => cache.get('same', loader)));
    expect(loader).toHaveBeenCalledTimes(1);
    const missing = vi.fn(async () => {
      throw new ApiError(404, 'MISSING', '不存在');
    });
    await expect(cache.get('missing', missing)).rejects.toThrow('不存在');
    await expect(cache.get('missing', missing)).rejects.toThrow('不存在');
    expect(missing).toHaveBeenCalledTimes(1);
    await expect(
      cache.get('failure', () => {
        throw new Error('上游中断');
      }),
    ).rejects.toThrow();
    await expect(cache.get('failure', async () => '恢复')).resolves.toBe('恢复');
  });

  it('随机版本查询受到全局频率与并发限制，时间窗口结束可恢复', async () => {
    vi.useFakeTimers();
    const cache = new ReleaseCache();
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    const pending = Array.from({ length: 8 }, (_, i) => cache.get(`pending-${i}`, () => gate));
    await expect(cache.get('overflow', async () => 0)).rejects.toThrow('更新请求较多');
    resolve();
    await Promise.all(pending);
    for (let i = 0; i < 52; i++) await cache.get(`version-${i}`, async () => i);
    await expect(cache.get('extra', async () => 1)).rejects.toThrow('更新请求较多');
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(cache.get('extra', async () => 1)).resolves.toBe(1);
  });
});
