import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import sharp from 'sharp';
import { ApiError } from '../../shared/errors.js';

export const MAX_BANNER_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'webp']);

/** 上传必须是完整可解码的单帧位图，标准化后移除元数据并以最终字节生成不可变身份。 */
export async function validateBannerImage(filename: string, encoded: string) {
  try {
    if (
      !/\.(?:png|jpe?g|webp)$/i.test(filename) ||
      basename(filename) !== filename ||
      /[/\\]/.test(filename) ||
      [...filename].some((character) => character.charCodeAt(0) < 32)
    )
      throw new ApiError(400, 'BANNER_MEDIA_FILENAME', '请选择 PNG、JPEG 或 WebP 图片');
    const source = Buffer.from(encoded, 'base64');
    if (!source.length || source.length > MAX_BANNER_BYTES || source.toString('base64') !== encoded)
      throw new ApiError(400, 'BANNER_MEDIA_SIZE', '图片无效或超过 8 MB');
    const isPng = source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = source[0] === 255 && source[1] === 216 && source[2] === 255;
    const isWebp =
      source.subarray(0, 4).toString('ascii') === 'RIFF' && source.subarray(8, 12).toString('ascii') === 'WEBP';
    // 在调用图片解码器前核对二进制签名，SVG 等文档格式不会进入其解析器。
    if (!isPng && !isJpeg && !isWebp)
      throw new ApiError(400, 'BANNER_MEDIA_FORMAT', '文件内容必须是 PNG、JPEG 或 WebP 图片');
    const decoder = sharp(source, { animated: true, failOn: 'warning', limitInputPixels: MAX_PIXELS });
    const metadata = await decoder.metadata();
    if (!IMAGE_FORMATS.has(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
      throw new ApiError(400, 'BANNER_MEDIA_FORMAT', '请选择单帧 PNG、JPEG 或 WebP 图片');
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096 ||
      metadata.width * metadata.height > MAX_PIXELS
    )
      throw new ApiError(400, 'BANNER_MEDIA_DIMENSIONS', '图片边长不能超过 4096 像素，总像素不能超过 1600 万');
    // 自动旋转像素后重新编码，不保留 EXIF、脚本、动画或其他原始附加数据。
    const { data: bytes, info } = await decoder.rotate().webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
    if (bytes.length > MAX_BANNER_BYTES) throw new ApiError(400, 'BANNER_MEDIA_SIZE', '处理后的图片超过 8 MB');
    return { bytes, id: createHash('sha256').update(bytes).digest('hex'), width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'BANNER_MEDIA_DECODE', '图片无法完整读取，请更换图片后重试', undefined, { cause: error });
  }
}

/** 文件名只由严格验证的内容摘要组成，调用方不能通过路径访问其他文件。 */
export function bannerMediaFile(storagePath: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new ApiError(404, 'BANNER_MEDIA_NOT_FOUND', 'Banner 图片不存在');
  return resolve(storagePath, 'banner-media', `${id}.webp`);
}

/** 只忽略已不存在的精确文件，其余文件系统错误必须交给错误边界记录。 */
async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** 原子发布完整图片；权限重验、文件发布、元数据和审计均位于同一次安全事务。 */
export async function publishBannerMedia(
  prisma: PrismaClient,
  storagePath: string,
  media: { id: string; bytes: Buffer },
  logger: FastifyBaseLogger,
  commit: (publish: (tx: Prisma.TransactionClient) => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = resolve(storagePath, 'banner-media');
  const temporary = resolve(directory, `.${randomUUID()}.tmp`);
  const target = bannerMediaFile(storagePath, media.id);
  let published = false;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, media.bytes, { flag: 'wx' });
    await commit(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`banner-media:${media.id}`}, 0))`;
      try {
        const metadata = await lstat(target);
        if (!metadata.isFile()) throw new Error('Banner 图片目标不是普通文件');
        const existing = await readFile(target);
        if (createHash('sha256').update(existing).digest('hex') !== media.id)
          throw new Error('Banner 图片内容摘要不匹配');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await rename(temporary, target);
        published = true;
      }
    });
  } catch (error) {
    if (published) {
      try {
        // 提交确认丢失时先重新取得同一把锁，只有数据库确认无元数据才删除本次新文件。
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`banner-media:${media.id}`}, 0))`;
          if (!(await tx.appBannerMedia.findUnique({ where: { id: media.id } }))) await removeFile(target);
        });
      } catch (cleanupError) {
        logger.error({ err: cleanupError, media_id: media.id }, 'Banner 上传提交状态无法确认，保留文件等待核对');
      }
    }
    throw error;
  } finally {
    try {
      await removeFile(temporary);
    } catch (error) {
      logger.error({ err: error }, '清理 Banner 上传临时文件失败');
    }
  }
}
