import { createHash } from 'node:crypto';
import { mkdir, opendir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';
import type { MemoMedia, PrismaClient } from '@prisma/client';

import { ApiError } from '../../shared/errors.js';
import { sanitizeImage, type ImageContentType } from '../../shared/image-sanitize.js';

/** 原图字节上限：客户端按同一上限压缩后上传。 */
export const MAX_MEMO_IMAGE_BYTES = 8 * 1024 * 1024;
/** 单边像素上限与总像素上限共同构成解压炸弹防护。 */
const MAX_MEMO_IMAGE_DIMENSION = 8192;
const MAX_MEMO_IMAGE_PIXELS = 40_000_000;
/** 输出最长边：正文插图按屏幕阅读需要缩小，服务端保存重编码结果。 */
const MAX_MEMO_IMAGE_OUTPUT_DIMENSION = 2048;
/** 单个账号的图片容量与数量上限，避免无限增长。 */
export const MEMO_MEDIA_ACCOUNT_BYTES = 512 * 1024 * 1024;
export const MEMO_MEDIA_ACCOUNT_COUNT = 2000;
/** Base64 编码长度上限：由字节上限推导，避免两个常量各自维护后漂移。 */
export const MEMO_MEDIA_BASE64_MAX_LENGTH = Math.ceil(MAX_MEMO_IMAGE_BYTES / 3) * 4;
/** 上传路由独立 bodyLimit：容纳原图上限的 Base64 + JSON 开销，不放大全局限制。 */
export const MEMO_MEDIA_UPLOAD_BODY_LIMIT = 12 * 1024 * 1024;
/** 超过宽限期且正文不再引用的图片才回收，避免刚上传尚未推送时被删除。 */
const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60_000;
const FILE_NAME = /^[0-9a-f-]{36}\.(?:png|jpg|webp)$/;

export type MemoMediaMetadata = {
  id: string;
  byte_size: number;
  width: number;
  height: number;
  sha256: string;
};

/** 上传正文的字段定义由路由声明，这里只负责按声明净化图片。 */
export async function sanitizeMemoImage(contentType: ImageContentType, data: string) {
  return sanitizeImage({
    contentType,
    data,
    maxBytes: MAX_MEMO_IMAGE_BYTES,
    maxDimension: MAX_MEMO_IMAGE_DIMENSION,
    maxPixels: MAX_MEMO_IMAGE_PIXELS,
    maxOutputDimension: MAX_MEMO_IMAGE_OUTPUT_DIMENSION,
    quality: 85,
    tooLargeCode: 'MEMO_MEDIA_TOO_LARGE',
    tooLargeMessage: '图片过大，请选择较小的图片',
    invalidCode: 'MEMO_MEDIA_INVALID',
    invalidMessage: '无法识别该图片，请重新选择',
  });
}

/** 移除文件；缺失视为已完成，其他失败只记录等待孤儿清理重试。 */
async function removeFile(path: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn({ err: error, path }, '备忘录图片文件清理失败');
  }
}

/** 媒体文件按账号目录隔离，文件名只由客户端生成的 UUID 与服务端扩展名组成。 */
function mediaDirectory(storagePath: string, userId: string): string {
  return resolve(storagePath, 'memo-media', userId);
}

/** 读取时必须限制在账号目录内，避免损坏的数据库值形成路径穿越。 */
function mediaPath(directory: string, fileName: string): string {
  if (!FILE_NAME.test(fileName)) throw new ApiError(404, 'MEMO_MEDIA_NOT_FOUND', '图片不存在');
  return resolve(directory, fileName);
}

/** 快照字段只暴露协议需要的元数据，不返回归属账号与磁盘文件名。 */
function metadataOf(row: MemoMedia): MemoMediaMetadata {
  return { id: row.id, byte_size: row.byteSize, width: row.width, height: row.height, sha256: row.sha256 };
}

/** 正文引用检查按 JSON 文本匹配媒体标识；墓碑正文不再需要图片，允许回收。 */
async function isReferenced(prisma: PrismaClient, id: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ referenced: boolean }>>`
    SELECT EXISTS(
      SELECT 1 FROM public.memo_entries
      WHERE deleted_at IS NULL AND body::text LIKE ${`%${id}%`}
    ) AS referenced
  `;
  return rows[0]?.referenced === true;
}

/**
 * 保存客户端生成的图片标识：同标识同内容幂等返回，同标识不同内容拒绝覆盖。
 *
 * 上传与配额检查在同一账号锁内串行，避免并发上传绕过容量上限；
 * 文件先落盘再提交元数据，提交失败时补偿删除，元数据不回滚已存在的旧文件。
 */
export async function storeMemoMedia(
  prisma: PrismaClient,
  storagePath: string,
  userId: string,
  media: { id: string; image: Awaited<ReturnType<typeof sanitizeMemoImage>> },
  log: FastifyBaseLogger,
): Promise<MemoMediaMetadata> {
  const directory = mediaDirectory(storagePath, userId);
  const sha256 = createHash('sha256').update(media.image.bytes).digest('hex');
  const previous = await prisma.memoMedia.findUnique({ where: { id: media.id } });
  if (previous) {
    if (previous.ownerId !== userId) throw new ApiError(409, 'MEMO_MEDIA_CONFLICT', '图片标识已被占用，请重试');
    if (previous.sha256 === sha256) return metadataOf(previous);
    throw new ApiError(409, 'MEMO_MEDIA_CONFLICT', '图片标识已被占用，请重试');
  }
  const fileName = `${media.id}.${media.image.format === 'jpeg' ? 'jpg' : media.image.format}`;
  const target = mediaPath(directory, fileName);
  await mkdir(directory, { recursive: true });
  await writeFile(target, media.image.bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    // 重试同一标识时文件可能已存在：内容不一致说明该标识已被其他字节占用。
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(target).catch(() => null);
    if (!existing) throw error;
    if (createHash('sha256').update(existing).digest('hex') !== sha256)
      throw new ApiError(409, 'MEMO_MEDIA_CONFLICT', '图片标识已被占用，请重试');
  });
  let committed = false;
  try {
    const row = await prisma.$transaction(async (tx) => {
      // 账号级锁串行化配额统计与写入，避免并发上传同时通过限额检查。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`memo-media:${userId}`}, 0))`;
      const existing = await tx.memoMedia.findUnique({ where: { id: media.id } });
      if (existing) {
        if (existing.ownerId !== userId || existing.sha256 !== sha256)
          throw new ApiError(409, 'MEMO_MEDIA_CONFLICT', '图片标识已被占用，请重试');
        return existing;
      }
      const usage = await tx.memoMedia.aggregate({
        where: { ownerId: userId },
        _sum: { byteSize: true },
        _count: { _all: true },
      });
      const usedBytes = usage._sum.byteSize ?? 0;
      if (
        usedBytes + media.image.bytes.length > MEMO_MEDIA_ACCOUNT_BYTES ||
        usage._count._all >= MEMO_MEDIA_ACCOUNT_COUNT
      )
        throw new ApiError(413, 'MEMO_MEDIA_QUOTA', '图片空间已用尽，请删除部分图片后重试');
      return tx.memoMedia.create({
        data: {
          id: media.id,
          ownerId: userId,
          fileName,
          byteSize: media.image.bytes.length,
          width: media.image.width,
          height: media.image.height,
          sha256,
        },
      });
    });
    committed = true;
    return metadataOf(row);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // 并发上传同一标识时唯一约束先失败：重读权威行，内容一致按幂等成功处理。
    const existing = await prisma.memoMedia.findUnique({ where: { id: media.id } }).catch(() => null);
    if (existing && existing.ownerId === userId && existing.sha256 === sha256) {
      committed = true;
      return metadataOf(existing);
    }
    throw new ApiError(500, 'MEMO_MEDIA_SAVE_FAILED', '图片保存失败，请稍后重试', undefined, { cause: error });
  } finally {
    if (!committed) await removeFile(target, log);
  }
}

/** 读取本人图片字节；缺失元数据或磁盘文件统一按不存在处理。 */
export async function readMemoMedia(
  prisma: PrismaClient,
  storagePath: string,
  userId: string,
  id: string,
): Promise<{ bytes: Buffer; contentType: ImageContentType; row: MemoMedia }> {
  const row = await prisma.memoMedia.findUnique({ where: { id } });
  if (!row || row.ownerId !== userId) throw new ApiError(404, 'MEMO_MEDIA_NOT_FOUND', '图片不存在');
  const contentType: ImageContentType = row.fileName.endsWith('.png')
    ? 'image/png'
    : row.fileName.endsWith('.jpg')
      ? 'image/jpeg'
      : 'image/webp';
  try {
    const bytes = await readFile(mediaPath(mediaDirectory(storagePath, userId), row.fileName));
    return { bytes, contentType, row };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ApiError(404, 'MEMO_MEDIA_NOT_FOUND', '图片不存在');
    throw error;
  }
}

/**
 * 回收超过宽限期且正文不再引用的图片，恢复删除笔记或上传失败留下的磁盘空间。
 *
 * 逐批核对权威引用后才删除，避免计时与刚推送的正文竞争；
 * 文件先于元数据删除，删除失败时保留元数据等待下一轮重试。
 */
export async function cleanupMemoMediaFiles(
  prisma: PrismaClient,
  storagePath: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const root = resolve(storagePath, 'memo-media');
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  const candidates: Array<{ userId: string; fileName: string; id: string }> = [];
  try {
    const directories = await opendir(root, { bufferSize: 64 });
    for await (const entry of directories) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      const files = await opendir(resolve(root, entry.name), { bufferSize: 256 });
      for await (const file of files) {
        if (!file.isFile() || !FILE_NAME.test(file.name)) continue;
        try {
          if ((await stat(resolve(root, entry.name, file.name))).mtimeMs >= cutoff) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        candidates.push({ userId: entry.name, fileName: file.name, id: file.name.replace(/\.[^.]+$/, '') });
        if (candidates.length >= 200) await cleanBatch(prisma, root, candidates, log);
      }
    }
    await cleanBatch(prisma, root, candidates, log);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.error({ err: error }, '备忘录图片清理失败');
  }
}

/** 每批最多核对 200 个文件，逐项确认引用与归属后删除。 */
async function cleanBatch(
  prisma: PrismaClient,
  root: string,
  candidates: Array<{ userId: string; fileName: string; id: string }>,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!candidates.length) return;
  const batch = candidates.splice(0);
  const rows = await prisma.memoMedia.findMany({
    where: { id: { in: batch.map((candidate) => candidate.id) } },
    select: { id: true, ownerId: true, fileName: true },
  });
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const candidate of batch) {
    const row = rowsById.get(candidate.id);
    // 归属目录与元数据不一致说明文件不是本账号写入的，保留给人工核对。
    if (row && (row.ownerId !== candidate.userId || row.fileName !== candidate.fileName)) continue;
    if (await isReferenced(prisma, candidate.id)) continue;
    const path = resolve(root, candidate.userId, candidate.fileName);
    try {
      await removeFile(path, log);
      if (row) await prisma.memoMedia.deleteMany({ where: { id: candidate.id, ownerId: candidate.userId } });
    } catch (error) {
      log.warn({ err: error, path }, '备忘录图片孤儿清理失败，将在下一轮重试');
    }
  }
}
