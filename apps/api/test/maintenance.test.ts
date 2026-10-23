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

it('过期幂等缓存按有限批次清理，关闭后不遗留定时任务', async () => {
  vi.useFakeTimers();
  let start: (() => Promise<void>) | undefined;
  const error = vi.fn();
  const app = {
    addHook: (_name: string, callback: () => Promise<void>) => {
      start = callback;
    },
    log: { error, warn: vi.fn(), info: vi.fn() },
  } as unknown as FastifyInstance;
  const findMany = vi
    .fn()
    .mockResolvedValueOnce([{ id: 1n }])
    .mockResolvedValue([]);
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = { idempotencyKey: { findMany, deleteMany } } as unknown as PrismaClient;
  const stop = registerMaintenance(app, prisma, 'Temp/maintenance-no-files');
  try {
    expect(findMany).not.toHaveBeenCalled();
    await start!();
    // 文件不存在时清理仍继续，等待真实文件系统 Promise 完成而不推进定时器。
    await vi.waitFor(() => expect(deleteMany).toHaveBeenCalledOnce());
    expect(findMany.mock.calls[0]![0]).toMatchObject({ take: 500, where: { expiresAt: { lte: expect.any(Date) } } });
    expect(deleteMany.mock.calls[0]![0]).toMatchObject({
      where: { id: { in: [1n] }, expiresAt: { lte: expect.any(Date) } },
    });
    expect(error).not.toHaveBeenCalled();
  } finally {
    await stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});

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

it('媒体目录失败仅在调度边界记录一次失败，不输出本轮成功', async () => {
  vi.useFakeTimers();
  let start!: () => Promise<void>;
  const failure = new Error('media directory unavailable');
  media.run.mockRejectedValue(failure);
  const app = {
    addHook: (_name: string, callback: () => Promise<void>) => {
      start = callback;
    },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
  const stop = registerMaintenance(app as unknown as FastifyInstance, {} as PrismaClient, 'Temp/maintenance-no-files');
  try {
    await start();
    await vi.waitFor(() => expect(app.log.error).toHaveBeenCalledOnce());
    expect(app.log.error).toHaveBeenCalledWith({ err: failure }, '后台维护失败，将在下一轮重试');
    expect(app.log.info).not.toHaveBeenCalled();
  } catch (cause) {
    throw new Error('维护失败日志边界回归失败', { cause });
  } finally {
    await stop();
  }
});
