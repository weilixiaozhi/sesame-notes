import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOwnedFixture, removeOwnedFixture } from '../../../test/owned-fixture-directory.js';
import {
  createFitnessMediaMaintenance,
  fitnessMediaFile,
  fitnessPreviewFile,
  publishFitnessMedia,
} from './fitness-media-storage.js';

const logger = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

/** 用内存事务模拟提交、回滚与共享发布锁，不连接数据库。 */
function repository() {
  const rows = new Set<string>();
  const references = new Set<string>();
  const waiters: Array<() => void> = [];
  let locked = false;
  let readFails = false;
  const db = {
    rows,
    references,
    /** 暴露等待数量作为确定性屏障，避免依赖任意延迟猜测并发顺序。 */
    waitingCount() {
      return waiters.length;
    },
    /** 模拟事务结果不可读取，供失败保留与后续维护恢复验证。 */
    setReadFailure(value: boolean) {
      readFails = value;
    },
    /** 发布锁在提交或回滚后才释放，未提交元数据对其他事务不可见。 */
    async $transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
      let acquired = false;
      const pending = new Set<string>();
      const tx = {
        /** 上传等待发布锁；队首接管释放的锁，不产生空闲抢占窗口。 */
        async $executeRaw() {
          if (locked) await new Promise<void>((resolve) => waiters.push(resolve));
          else locked = true;
          acquired = true;
          return 0;
        },
        /** 维护使用非阻塞锁，其他事务进行中时只能保留文件。 */
        async $queryRaw() {
          if (locked) return [{ locked: false }];
          locked = true;
          acquired = true;
          return [{ locked: true }];
        },
        officialFitnessMedia: {
          /** 返回已提交事实，模拟无法确认提交状态的读取异常。 */
          async findUnique({ where }: { where: { id: string } }) {
            if (readFails) throw new Error('database unavailable');
            return rows.has(where.id) || pending.has(where.id) ? { id: where.id } : null;
          },
          /** 元数据先进入事务缓冲区，只有正常返回才发布。 */
          async upsert({ where }: { where: { id: string } }) {
            pending.add(where.id);
            return { id: where.id };
          },
        },
        officialFitnessContent: {
          /** 包含停用正文引用，不用展示状态裁剪保护范围。 */
          async findFirst({ where }: { where: { content: { equals: string } } }) {
            return references.has(where.content.equals) ? { id: 'exercise' } : null;
          },
        },
      };
      try {
        const value = await operation(tx as unknown as Prisma.TransactionClient);
        for (const id of pending) rows.add(id);
        return value;
      } finally {
        if (acquired) {
          const next = waiters.shift();
          if (next) next();
          else locked = false;
        }
      }
    },
  };
  return db;
}

/** 保存媒体元数据供存储事务验证，其他管理字段不参与这些生命周期测试。 */
async function saveMetadata(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.officialFitnessMedia.upsert({
    where: { id },
    create: { id, fileName: 'test.gif', mimeType: 'image/gif', byteSize: 5, width: 1, height: 1, frames: 1 },
    update: {},
  });
}

/** 使用真实内容哈希生成上传输入，文件内容与路径身份保持一致。 */
function media(value = 'image') {
  const bytes = Buffer.from(value);
  return { id: createHash('sha256').update(bytes).digest('hex'), bytes };
}

/** 在受控测试目录中创建超过宽限期的文件。 */
async function expiredFile(path: string, bytes: Buffer | string = 'cached'): Promise<void> {
  try {
    await writeFile(path, bytes);
    await utimes(path, new Date(0), new Date(0));
  } catch (cause) {
    throw new Error('过期素材夹具创建失败', { cause });
  }
}

describe('官方媒体发布与回收', () => {
  it('权限事务拒绝发布时不产生永久文件，发布后审计回滚会核查并补偿', async () => {
    const root = await createOwnedFixture('api-fix-media-rollback');
    const db = repository();
    const value = media();
    try {
      await expect(
        publishFitnessMedia(db as unknown as PrismaClient, root, value, logger, async () => {
          throw new Error('permission revoked');
        }),
      ).rejects.toThrow('permission revoked');
      expect(await readdir(resolve(root, 'fitness-media'))).toEqual([]);
      await expect(
        publishFitnessMedia(db as unknown as PrismaClient, root, value, logger, (publish) =>
          db.$transaction(async (tx) => {
            await publish(tx);
            await saveMetadata(tx, value.id);
            throw new Error('audit rejected');
          }),
        ),
      ).rejects.toThrow('audit rejected');
      expect(db.rows.size).toBe(0);
      expect(await readdir(resolve(root, 'fitness-media'))).toEqual([]);
    } catch (cause) {
      throw new Error('媒体权限与回滚补偿回归失败', { cause });
    } finally {
      await removeOwnedFixture(root);
    }
  });

  it('提交确认丢失保留已提交文件，重复上传保持源时间与预览身份', async () => {
    const root = await createOwnedFixture('api-fix-media-commit');
    const db = repository();
    const value = media();
    try {
      await expect(
        publishFitnessMedia(db as unknown as PrismaClient, root, value, logger, async (publish) => {
          await db.$transaction(async (tx) => {
            await publish(tx);
            await saveMetadata(tx, value.id);
          });
          throw new Error('commit acknowledgement lost');
        }),
      ).rejects.toThrow('commit acknowledgement lost');
      const path = fitnessMediaFile(root, value.id);
      expect(await readFile(path)).toEqual(value.bytes);
      await utimes(path, new Date(0), new Date(0));
      const original = await stat(path);
      await publishFitnessMedia(db as unknown as PrismaClient, root, value, logger, (publish) =>
        db.$transaction(async (tx) => {
          await publish(tx);
          await saveMetadata(tx, value.id);
        }),
      );
      const current = await stat(path);
      expect(current.mtimeMs).toBe(original.mtimeMs);
      expect(fitnessPreviewFile(root, value.id, current)).toBe(fitnessPreviewFile(root, value.id, original));
      expect(await readdir(resolve(root, 'fitness-media'))).toEqual([`${value.id}.gif`]);
    } catch (cause) {
      throw new Error('媒体提交不确定与重复上传回归失败', { cause });
    } finally {
      await removeOwnedFixture(root);
    }
  });

  it('同哈希后继上传持锁时，前次失败补偿和维护都不会删除后继使用的文件', async () => {
    const root = await createOwnedFixture('api-fix-media-concurrent');
    const db = repository();
    const value = media();
    const maintenance = createFitnessMediaMaintenance(db as unknown as PrismaClient, root, logger);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstReady!: () => void;
    let secondReady!: () => void;
    const firstPublished = new Promise<void>((resolve) => (firstReady = resolve));
    const secondPublished = new Promise<void>((resolve) => (secondReady = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    let first: Promise<unknown> | undefined;
    let second: Promise<void> | undefined;
    try {
      first = publishFitnessMedia(db as unknown as PrismaClient, root, value, logger, (publish) =>
        db.$transaction(async (tx) => {
          await publish(tx);
          firstReady();
          await firstGate;
          throw new Error('first audit failed');
        }),
      ).catch((error: unknown) => error);
      await firstPublished;
      second = publishFitnessMedia(db as unknown as PrismaClient, root, value, logger, (publish) =>
        db.$transaction(async (tx) => {
          await publish(tx);
          await saveMetadata(tx, value.id);
          secondReady();
          await secondGate;
        }),
      );
      // 第二次调用已排队后再让首次事务失败，确保覆盖共享哈希的接管窗口。
      await vi.waitFor(() => expect(db.waitingCount()).toBe(1));
      releaseFirst();
      await secondPublished;
      expect(await first).toBeInstanceOf(Error);
      const path = fitnessMediaFile(root, value.id);
      await utimes(path, new Date(0), new Date(0));
      await maintenance.run();
      expect(await readFile(path)).toEqual(value.bytes);
      releaseSecond();
      await second;
      await maintenance.run();
      expect(db.rows.has(value.id)).toBe(true);
      expect(await readFile(path)).toEqual(value.bytes);
    } catch (cause) {
      throw new Error('同哈希并发发布与回收回归失败', { cause });
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled([first, second]);
      await maintenance.close();
      await removeOwnedFixture(root);
    }
  });

  it('数据库不可读时保留文件，宽限期后恢复核查才能回收真正孤儿', async () => {
    const root = await createOwnedFixture('api-fix-media-unavailable');
    const db = repository();
    const value = media();
    const maintenance = createFitnessMediaMaintenance(db as unknown as PrismaClient, root, logger);
    const uploadFailure = new Error('database disconnected');
    try {
      db.setReadFailure(true);
      await expect(
        publishFitnessMedia(db as unknown as PrismaClient, root, value, logger, (publish) =>
          db.$transaction(async (tx) => {
            await publish(tx);
            throw uploadFailure;
          }),
        ),
      ).rejects.toBe(uploadFailure);
      const path = fitnessMediaFile(root, value.id);
      expect(await readFile(path)).toEqual(value.bytes);
      db.setReadFailure(false);
      await maintenance.run();
      expect(await readFile(path)).toEqual(value.bytes);
      await utimes(path, new Date(0), new Date(0));
      await maintenance.run();
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } catch (cause) {
      throw new Error('媒体失败保留与延迟回收回归失败', { cause });
    } finally {
      await maintenance.close();
      await removeOwnedFixture(root);
    }
  });

  it('保留未绑定元数据、停用正文引用和当前预览，仅回收过期孤儿与旧缓存', async () => {
    const root = await createOwnedFixture('api-fix-media-retention');
    const db = repository();
    const maintenance = createFitnessMediaMaintenance(db as unknown as PrismaClient, root, logger);
    const saved = media('saved');
    const referenced = media('disabled-content');
    const orphan = media('orphan');
    const fresh = media('fresh');
    try {
      const directory = resolve(root, 'fitness-media');
      const previews = resolve(directory, 'previews-v1');
      await mkdir(previews, { recursive: true });
      db.rows.add(saved.id);
      db.references.add(referenced.id);
      for (const value of [saved, referenced, orphan]) await expiredFile(fitnessMediaFile(root, value.id), value.bytes);
      await writeFile(fitnessMediaFile(root, fresh.id), fresh.bytes);
      const currentPreviewPath = fitnessPreviewFile(root, saved.id, await stat(fitnessMediaFile(root, saved.id)));
      await expiredFile(currentPreviewPath);
      const stale = resolve(previews, `${saved.id}-${'0'.repeat(16)}.webp`);
      const orphanPreview = resolve(previews, `${orphan.id}-${'0'.repeat(16)}.webp`);
      const temporary = resolve(directory, `.${randomUUID()}.tmp`);
      const temporaryPreview = `${stale}.${randomUUID()}.tmp`;
      for (const path of [stale, orphanPreview, temporary, temporaryPreview]) await expiredFile(path);
      await expiredFile(resolve(directory, 'operator-notes.txt'));
      const builtin = fitnessMediaFile(root, 'builtin-0025');
      const builtinBefore = await stat(builtin);
      await maintenance.run();
      expect((await readdir(directory)).sort()).toEqual(
        ['previews-v1', 'operator-notes.txt', `${saved.id}.gif`, `${referenced.id}.gif`, `${fresh.id}.gif`].sort(),
      );
      expect(await readdir(previews)).toEqual([currentPreviewPath.split(/[\\/]/).at(-1)]);
      expect((await stat(builtin)).mtimeMs).toBe(builtinBefore.mtimeMs);
    } catch (cause) {
      throw new Error('媒体保留范围与预览回收回归失败', { cause });
    } finally {
      await maintenance.close();
      await removeOwnedFixture(root);
    }
  });

  it('扫描达到单轮上限后续接目录，调度结束后可释放句柄', async () => {
    const root = await createOwnedFixture('api-fix-media-bounded');
    const db = repository();
    const maintenance = createFitnessMediaMaintenance(db as unknown as PrismaClient, root, logger);
    try {
      const directory = resolve(root, 'fitness-media');
      await mkdir(directory);
      await Promise.all(Array.from({ length: 260 }, () => expiredFile(resolve(directory, `.${randomUUID()}.tmp`))));
      await maintenance.run();
      const remaining = (await readdir(directory)).length;
      expect(remaining).toBeGreaterThanOrEqual(4);
      expect(remaining).toBeLessThan(260);
      for (let round = 0; round < 10 && (await readdir(directory)).length; round++) await maintenance.run();
      expect(await readdir(directory)).toEqual([]);
    } catch (cause) {
      throw new Error('媒体维护有界扫描与关闭回归失败', { cause });
    } finally {
      await maintenance.close();
      await removeOwnedFixture(root);
    }
  });

  it('发布锁失败保留原异常且只清理本请求的临时文件', async () => {
    const root = await createOwnedFixture('api-fix-media-lock');
    const db = repository();
    const failure = new Error('publication lock unavailable');
    try {
      await expect(
        publishFitnessMedia(db as unknown as PrismaClient, root, media(), logger, (publish) =>
          db.$transaction(async (tx) => {
            await publish({ ...tx, $executeRaw: vi.fn().mockRejectedValue(failure) });
          }),
        ),
      ).rejects.toBe(failure);
      expect(db.rows.size).toBe(0);
      expect(await readdir(resolve(root, 'fitness-media'))).toEqual([]);
    } catch (cause) {
      throw new Error('发布锁失败传播回归失败', { cause });
    } finally {
      await removeOwnedFixture(root);
    }
  });

  it('目录扫描失败向维护边界传播，不重复记录主错误', async () => {
    const root = await createOwnedFixture('api-fix-media-directory');
    const log = { warn: vi.fn(), error: vi.fn() };
    const maintenance = createFitnessMediaMaintenance(
      repository() as unknown as PrismaClient,
      root,
      log as unknown as FastifyBaseLogger,
    );
    try {
      await writeFile(resolve(root, 'fitness-media'), 'not a directory');
      await expect(maintenance.run()).rejects.toMatchObject({ code: 'ENOTDIR' });
      expect(log.error).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('素材维护失败边界回归失败', { cause });
    } finally {
      await maintenance.close();
      await removeOwnedFixture(root);
    }
  });
});
