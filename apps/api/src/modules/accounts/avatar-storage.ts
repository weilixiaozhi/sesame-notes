import { mkdir, opendir, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../../shared/errors.js';

const AVATAR_FILE = /^[0-9a-f-]{36}\.(?:png|jpg|webp)$/;
const ORPHAN_GRACE_MS = 24 * 60 * 60_000;

type AvatarProfile = { avatarFileId: string | null; avatarVersion: number };
type AvatarReplacement = { previous: string | null; previousVersion: number; profile: AvatarProfile | null };
type AvatarReplacementOptions = {
  expectedVersion?: number;
  /** 允许调用方把授权重验、头像修改及审计放入同一事务。 */
  transaction?: (operation: (tx: Prisma.TransactionClient) => Promise<AvatarReplacement>) => Promise<AvatarReplacement>;
};

/** 文件删除失败保留日志，后续孤立文件清理会重试；缺失文件视为已完成。 */
async function removeFile(path: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn({ err: error, path }, '头像文件清理失败');
  }
}

/** 以账号锁串行替换头像元数据；文件失败补偿与旧文件删除分别在提交前后执行。 */
export async function replaceAvatar(
  prisma: PrismaClient,
  storagePath: string,
  userId: string,
  image: { bytes: Buffer; extension: '.png' | '.jpg' | '.webp' } | null,
  log: FastifyBaseLogger,
  options: AvatarReplacementOptions = {},
): Promise<AvatarProfile | null> {
  const directory = resolve(storagePath, 'avatars');
  const name = image ? `${randomUUID()}${image.extension}` : null;
  let committed = false;
  try {
    if (image && name) {
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, name), image.bytes, { flag: 'wx' });
    }
    const transaction = options.transaction ?? ((operation) => prisma.$transaction(operation));
    const result = await transaction(async (tx) => {
      // 同账号上传与删除使用同一把事务锁，旧文件只来自锁内读取的权威状态。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`avatar:${userId}`}, 0))`;
      // 保持账号存在直到头像事务结束，避免注销与首次创建资料并发时产生失效写入。
      const users = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id = ${userId}::uuid FOR KEY SHARE`;
      if (!users.length) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
      const previous = await tx.userProfile.findUnique({
        where: { userId },
        select: { avatarFileId: true, avatarVersion: true },
      });
      const previousVersion = previous?.avatarVersion ?? 0;
      if (options.expectedVersion !== undefined && previousVersion !== options.expectedVersion) {
        throw new ApiError(409, 'AVATAR_VERSION_CONFLICT', '用户头像已更新，请刷新资料后重试');
      }
      if (!image && !previous?.avatarFileId) return { previous: null, previousVersion, profile: previous };
      const profile = await tx.userProfile.upsert({
        where: { userId },
        create: { userId, avatarFileId: name, avatarVersion: 1 },
        update: { avatarFileId: name, avatarVersion: { increment: 1 } },
        select: { avatarFileId: true, avatarVersion: true },
      });
      return { previous: previous?.avatarFileId ?? null, previousVersion, profile };
    });
    committed = true;
    if (result.previous && AVATAR_FILE.test(result.previous))
      await removeFile(resolve(directory, result.previous), log);
    return result.profile;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('头像保存失败', { cause: error });
  } finally {
    if (!committed && name) {
      try {
        // 连接中断可能发生在数据库已提交、客户端尚未收到确认之后；先查权威引用再补偿。
        const current = await prisma.userProfile.findUnique({ where: { userId }, select: { avatarFileId: true } });
        if (current?.avatarFileId !== name) await removeFile(resolve(directory, name), log);
      } catch (error) {
        // 无法确认提交状态时保留文件，由宽限期后的孤立文件扫描重试。
        log.warn({ err: error, file: name }, '头像提交状态无法确认，保留文件等待核对');
      }
    }
  }
}

/** 批量清理超过宽限期且数据库未引用的文件，恢复进程崩溃或删除失败留下的磁盘空间。 */
export async function cleanupAvatarFiles(
  prisma: PrismaClient,
  storagePath: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const directory = resolve(storagePath, 'avatars');
  try {
    const entries = await opendir(directory, { bufferSize: 256 });
    const cutoff = Date.now() - ORPHAN_GRACE_MS;
    const candidates: string[] = [];
    /** 每批最多查询 256 个过期文件，删除前以权威元数据确认引用。 */
    async function cleanBatch(): Promise<void> {
      if (!candidates.length) return;
      const profiles = await prisma.userProfile.findMany({
        where: { avatarFileId: { in: candidates } },
        select: { avatarFileId: true },
      });
      const referenced = new Set(profiles.map((profile) => profile.avatarFileId));
      for (const name of candidates) if (!referenced.has(name)) await removeFile(resolve(directory, name), log);
      candidates.length = 0;
    }
    // 异步目录迭代器在成功、异常或提前结束时关闭句柄，不把整个目录载入内存。
    for await (const entry of entries) {
      if (!entry.isFile() || !AVATAR_FILE.test(entry.name)) continue;
      try {
        if ((await stat(resolve(directory, entry.name))).mtimeMs < cutoff) candidates.push(entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (candidates.length === 256) await cleanBatch();
    }
    await cleanBatch();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.error({ err: error }, '孤立头像文件清理失败');
  }
}
