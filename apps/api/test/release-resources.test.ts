import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseCache, ReleaseDownloads } from '../src/modules/app-release/testing.js';

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
