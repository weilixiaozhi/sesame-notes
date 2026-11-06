import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerMaintenance } from '../src/maintenance.js';

const media = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock('../src/modules/fitness/index.js', () => ({ createFitnessMediaMaintenance: () => media }));

beforeEach(() => {
  media.run.mockReset().mockResolvedValue(undefined);
  media.close.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

it('调度器合并重叠轮次，停止时等待媒体工作结束再释放目录', async () => {
  vi.useFakeTimers();
  let start!: () => Promise<void>;
  let finish!: () => void;
  media.run.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  const app = {
    addHook: (_name: string, callback: () => Promise<void>) => {
      start = callback;
    },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
  const prisma = { idempotencyKey: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaClient;
  const stop = registerMaintenance(app as unknown as FastifyInstance, prisma, 'Temp/maintenance-no-files');
  try {
    await start();
    await vi.waitFor(() => expect(media.run).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(media.run).toHaveBeenCalledOnce();
    const stopping = stop();
    expect(media.close).not.toHaveBeenCalled();
    finish();
    await stopping;
    expect(media.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(media.run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } catch (cause) {
    throw new Error('维护调度生命周期回归失败', { cause });
  } finally {
    finish?.();
    await stop();
  }
});
