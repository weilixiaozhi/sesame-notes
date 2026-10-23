import { createHash, randomUUID } from 'node:crypto';
import type { Dir } from 'node:fs';
import { lstat, mkdir, opendir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../../shared/errors.js';
import builtinMedia from './fitness-media-catalog.json' with { type: 'json' };

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_FILE = /^([a-f0-9]{64})\.gif$/;
const PREVIEW_FILE = /^([a-f0-9]{64}|builtin-[\w-]{1,128})-[a-f0-9]{16}\.webp$/;
const UUID_PART = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const UPLOAD_TEMP = new RegExp(`^\\.${UUID_PART}\\.tmp$`);
const PREVIEW_TEMP = new RegExp(`^(.+\\.webp)\\.${UUID_PART}\\.tmp$`);
const ORPHAN_GRACE_MS = 24 * 60 * 60_000;
const CLEANUP_ENTRY_LIMIT = 256;
const CLEANUP_TIME_MS = 2_000;
const CLEANUP_TRANSACTION_OPTIONS = { maxWait: 1_000, timeout: 5_000 } as const;

/** 路径只由审核清单或内容哈希构造，内置素材不进入可写媒体目录。 */
export function fitnessMediaFile(storagePath: string, id: string): string {
  if (HASH_PATTERN.test(id)) return resolve(storagePath, 'fitness-media', `${id}.gif`);
  const key = id.slice(8);
  const builtin =
    id.startsWith('builtin-') && Object.hasOwn(builtinMedia, key)
      ? (builtinMedia as Record<string, string>)[key]
      : undefined;
  if (!builtin) throw new ApiError(404, 'FITNESS_MEDIA_NOT_FOUND', '动作素材不存在');
  return resolve(import.meta.dirname, '../../../../web/public/fitness/videos', basename(builtin));
}

/** 源文件身份与修订共同决定预览键，读取和回收使用同一份计算。 */
export function fitnessPreviewFile(
  storagePath: string,
  id: string,
  metadata: { size: number; mtimeMs: number },
): string {
  const source = fitnessMediaFile(storagePath, id);
  const revision = createHash('sha256')
    .update(`${source}:${metadata.size}:${metadata.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  return resolve(storagePath, 'fitness-media', 'previews-v1', `${id}-${revision}.webp`);
}

/** 文件缺失视为清理完成，其余异常交给调用方记录并保留重试机会。 */
async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** 只处理真实普通文件，重新读取时间可保护刚被上传恢复的同名文件。 */
async function oldFile(path: string, cutoff: number): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && metadata.mtimeMs < cutoff;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 在同一发布锁内核对权威引用，事务结果不明或仍在提交时只保留文件。 */
async function removeUnreferencedMedia(
  prisma: PrismaClient,
  storagePath: string,
  id: string,
  cutoff: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<[{ locked: boolean }]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`fitness-media:${id}`}, 0)) AS locked
    `;
    // 不等待上传事务，避免后台回收阻塞管理请求；下轮会再次检查。
    if (!lock.locked) return;
    const path = fitnessMediaFile(storagePath, id);
    if (!(await oldFile(path, cutoff))) return;
    const media = await tx.officialFitnessMedia.findUnique({ where: { id }, select: { id: true } });
    // 已上传但尚未绑定正文的元数据仍是有效资料，不能以页面是否展示判断删除。
    if (media) return;
    const referenced = await tx.officialFitnessContent.findFirst({
      where: { kind: 'exercise', content: { path: ['media_id'], equals: id } },
      select: { id: true },
    });
    // 停用内容和历史引用同样保留；数据库核查失败会回滚并留下原文件。
    if (!referenced) await removeFile(path);
  }, CLEANUP_TRANSACTION_OPTIONS);
}

/** 在权限事务内发布完整文件；失败时先核对提交状态，不能直接删除共享哈希路径。 */
export async function publishFitnessMedia(
  prisma: PrismaClient,
  storagePath: string,
  media: { id: string; bytes: Buffer },
  log: FastifyBaseLogger,
  commit: (publish: (tx: Prisma.TransactionClient) => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = resolve(storagePath, 'fitness-media');
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  let publicationStarted = false;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, media.bytes, { flag: 'wx' });
    await commit(async (tx) => {
      // 校验入口已从图片字节生成哈希；发布锁覆盖文件与元数据的完整提交窗口。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`fitness-media:${media.id}`}, 0))`;
      publicationStarted = true;
      const target = fitnessMediaFile(storagePath, media.id);
      try {
        const metadata = await lstat(target);
        if (!metadata.isFile()) throw new Error('动作素材目标不是普通文件');
        // 内容哈希身份不变时复用完整文件，保留 mtime 及其预览缓存键。
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await rename(temporary, target);
      }
    });
  } catch (error) {
    if (publicationStarted) {
      try {
        // 提交确认可能丢失；只有重新取得锁且确认元数据与正文均无引用才补偿。
        await removeUnreferencedMedia(prisma, storagePath, media.id, Number.POSITIVE_INFINITY);
      } catch (cleanupError) {
        log.warn({ err: cleanupError, media_id: media.id }, '动作素材提交状态无法确认，保留文件等待维护核对');
      }
    }
    throw error;
  } finally {
    await removeFile(temporary).catch((error) => log.error({ err: error }, '清理动作素材临时文件失败'));
  }
}

/** 判断预览是否仍匹配当前源文件，缺失源或淘汰的内置身份都可按缓存回收。 */
async function currentPreview(storagePath: string, id: string, path: string): Promise<boolean> {
  try {
    const metadata = await stat(fitnessMediaFile(storagePath, id));
    return path === fitnessPreviewFile(storagePath, id, metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof ApiError && error.statusCode === 404))
      return false;
    throw error;
  }
}

/** 每轮限定扫描数量与时间，保留目录游标避免大量有效文件使后续孤儿永久饥饿。 */
export function createFitnessMediaMaintenance(prisma: PrismaClient, storagePath: string, log: FastifyBaseLogger) {
  const directories = [resolve(storagePath, 'fitness-media'), resolve(storagePath, 'fitness-media', 'previews-v1')];
  let directory: Dir | undefined;
  let index = 0;

  /** 目录迭代器跨轮复用，完成一轮或服务关闭时明确释放句柄。 */
  async function closeDirectory(): Promise<void> {
    const opened = directory;
    directory = undefined;
    await opened?.close();
  }

  /** 只读取当前媒体目录及预览目录中的已知文件形态，不递归触碰内置素材。 */
  async function cleanEntry(name: string, cutoff: number): Promise<void> {
    const path = resolve(directories[index]!, name);
    if (!(await oldFile(path, cutoff))) return;
    if (index === 0) {
      const media = MEDIA_FILE.exec(name);
      if (media) await removeUnreferencedMedia(prisma, storagePath, media[1]!, cutoff);
      else if (UPLOAD_TEMP.test(name)) await removeFile(path);
      return;
    }
    const preview = PREVIEW_FILE.exec(name);
    if (preview) {
      if (!(await currentPreview(storagePath, preview[1]!, path))) await removeFile(path);
    } else {
      const temporary = PREVIEW_TEMP.exec(name);
      if (temporary && PREVIEW_FILE.test(temporary[1]!)) await removeFile(path);
    }
  }

  /** 顺序处理有限文件，单文件失败只记录诊断并保留该文件供下一轮重试。 */
  async function scan(): Promise<void> {
    const started = performance.now();
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    try {
      for (let count = 0; count < CLEANUP_ENTRY_LIMIT && performance.now() - started < CLEANUP_TIME_MS;) {
        if (!directory) {
          try {
            directory = await opendir(directories[index]!, { bufferSize: 256 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        const entry = await directory?.read();
        if (!entry) {
          await closeDirectory();
          index += 1;
          if (index === directories.length) {
            index = 0;
            break;
          }
          continue;
        }
        count += 1;
        if (!entry.isFile()) continue;
        try {
          await cleanEntry(entry.name, cutoff);
        } catch (error) {
          log.warn({ err: error, file: entry.name }, '动作素材维护核查失败，保留文件等待重试');
        }
      }
    } catch (error) {
      await closeDirectory().catch((cause) => log.warn({ err: cause }, '动作素材目录句柄关闭失败'));
      index = 0;
      // 目录级失败交给维护调度边界记录，不能被当作本轮成功完成。
      throw error;
    }
  }

  return {
    // 调度器负责单轮串行及停服排空，这里只维护跨轮目录游标。
    run: scan,
    /** 调度器等待本轮结束后释放目录句柄，关闭失败单独记录且不遮蔽主错误。 */
    async close(): Promise<void> {
      await closeDirectory().catch((error) => log.warn({ err: error }, '动作素材目录句柄关闭失败'));
    },
  };
}
