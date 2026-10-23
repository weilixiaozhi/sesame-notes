import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { authenticateAdmin, verifyAdminWriteRequest, withAdminMutation, writeAuditLog } from '../admin/index.js';
import { FitnessMediaResponseSchema } from './official-fitness-schemas.js';
import { fitnessMediaFile, fitnessPreviewFile, publishFitnessMedia } from './fitness-media-storage.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 100_000_000;
const previewTasks = new Map<string, Promise<Buffer>>();
const mediaParams = Type.Object({
  media_id: Type.String({ pattern: '^(?:[a-f0-9]{64}|builtin-[a-zA-Z0-9_-]{1,128})$' }),
});
const mediaQuery = Type.Object({ preview: Type.Optional(Type.Literal('1')) }, { additionalProperties: false });

/** 严格解码并实际读取 GIF 帧，防止伪扩展名、损坏文件和解码资源耗尽。 */
export async function validateFitnessGif(filename: string, encoded: string) {
  if (
    !/\.gif$/i.test(filename) ||
    basename(filename) !== filename ||
    /[/\\]/.test(filename) ||
    [...filename].some((character) => character.charCodeAt(0) < 32)
  )
    throw new ApiError(400, 'FITNESS_MEDIA_FILENAME', '请选择 GIF 格式的动作素材');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== encoded)
    throw new ApiError(400, 'FITNESS_MEDIA_SIZE', 'GIF 文件无效或超过 10 MB');
  if (!['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')))
    throw new ApiError(400, 'FITNESS_MEDIA_FORMAT', '素材内容必须是真实 GIF 图片');
  try {
    const decoder = sharp(bytes, { animated: true, failOn: 'error', limitInputPixels: MAX_PIXELS });
    const metadata = await decoder.metadata();
    const width = metadata.width ?? 0;
    const frames = metadata.pages ?? 1;
    const height = metadata.pageHeight ?? metadata.height ?? 0;
    if (
      metadata.format !== 'gif' ||
      !width ||
      !height ||
      width > 2048 ||
      height > 2048 ||
      frames > 1000 ||
      width * height * frames > MAX_PIXELS
    )
      throw new ApiError(400, 'FITNESS_MEDIA_DIMENSIONS', 'GIF 尺寸、帧数或解码容量超过限制');
    await decoder.stats();
    return { bytes, id: createHash('sha256').update(bytes).digest('hex'), width, height, frames };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'FITNESS_MEDIA_DECODE', 'GIF 无法完整解码，请更换素材');
  }
}

/** 仅解码首帧并原子写入静态预览缓存，清理错误会保留详细日志。 */
async function createFitnessPreview(source: string, target: string, logger: FastifyBaseLogger): Promise<Buffer> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const bytes = await sharp(source, {
      page: 0,
      pages: 1,
      animated: false,
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
    })
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
    return bytes;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') logger.error({ err: error }, '清理动作预览临时文件失败');
    });
  }
}

/** 源文件变化时切换缓存键；命中时只读缩略图，同一文件并发请求共用一次解码。 */
async function readFitnessPreview(
  storagePath: string,
  id: string,
  source: string,
  logger: FastifyBaseLogger,
): Promise<Buffer> {
  const metadata = await stat(source);
  const directory = resolve(storagePath, 'fitness-media', 'previews-v1');
  const target = fitnessPreviewFile(storagePath, id, metadata);
  try {
    return await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pending = previewTasks.get(target);
  if (pending) return pending;
  // 在创建目录前登记任务，避免并发请求各自启动图片解码。
  const task = mkdir(directory, { recursive: true }).then(() => createFitnessPreview(source, target, logger));
  previewTasks.set(target, task);
  try {
    return await task;
  } finally {
    previewTasks.delete(target);
  }
}

/** GIF 上传保留原始动画；数据库事务内重验权限，只有已保存引用可被匿名读取。 */
export function registerOfficialFitnessMediaRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  config: ApiConfig,
): void {
  app.post(
    '/api/v1/admin/fitness/media',
    {
      onRequest: verifyAdminWriteRequest(config),
      preHandler: authenticateAdmin(config, prisma, 'fitness:write'),
      bodyLimit: Math.ceil((MAX_BYTES * 4) / 3) + 4096,
      schema: {
        tags: ['admin-fitness'],
        operationId: 'uploadOfficialFitnessMedia',
        body: Type.Object(
          {
            filename: Type.String({ minLength: 1, maxLength: 200 }),
            data_base64: Type.String({ maxLength: Math.ceil((MAX_BYTES * 4) / 3) }),
          },
          { additionalProperties: false },
        ),
        response: { 201: FitnessMediaResponseSchema },
      },
    },
    async (request, reply) =>
      execute(request, '上传动作素材', async () => {
        const body = request.body as { filename: string; data_base64: string };
        const media = await validateFitnessGif(body.filename, body.data_base64);
        await publishFitnessMedia(prisma, config.storagePath, media, request.log, (publish) =>
          withAdminMutation(prisma, request, 'fitness:write', async (tx, auth) => {
            // 权限重验后发布完整文件；同内容回收与上传共用锁直到元数据、审计提交。
            await publish(tx);
            await tx.officialFitnessMedia.upsert({
              where: { id: media.id },
              create: {
                id: media.id,
                fileName: body.filename,
                mimeType: 'image/gif',
                byteSize: media.bytes.length,
                width: media.width,
                height: media.height,
                frames: media.frames,
                createdBy: auth.username,
              },
              update: {},
            });
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: 'fitness.media.upload',
              target: { type: 'fitness_media', id: media.id },
              requestId: request.id,
              ip: request.ip,
              metadata: { file_name: body.filename, byte_size: media.bytes.length },
            });
          }),
        );
        return reply.code(201).send({
          id: media.id,
          url: `/api/v1/admin/fitness/media/${media.id}`,
          width: media.width,
          height: media.height,
          frames: media.frames,
          byte_size: media.bytes.length,
        });
      }),
  );
  for (const admin of [false, true]) {
    app.get(
      `/api/v1/${admin ? 'admin/' : ''}fitness/media/:media_id`,
      {
        ...(admin
          ? {
              onRequest: verifyAdminWriteRequest(config),
              preHandler: authenticateAdmin(config, prisma, 'fitness:read'),
            }
          : {}),
        schema: {
          tags: [admin ? 'admin-fitness' : 'fitness'],
          params: mediaParams,
          querystring: mediaQuery,
          response: { 200: Type.String({ format: 'binary' }), 304: Type.Null() },
        },
      },
      async (request, reply) =>
        execute(request, '读取动作素材', async () => {
          const { media_id: id } = request.params as { media_id: string };
          const preview = (request.query as { preview?: '1' }).preview === '1';
          if (/^[a-f0-9]{64}$/.test(id)) {
            const media = await prisma.officialFitnessMedia.findUnique({ where: { id } });
            const referenced =
              admin ||
              (await prisma.officialFitnessContent.findFirst({
                where: { kind: 'exercise', content: { path: ['media_id'], equals: id } },
                select: { id: true },
              }));
            if (!media || !referenced) throw new ApiError(404, 'FITNESS_MEDIA_NOT_FOUND', '动作素材不存在');
          }
          const path = fitnessMediaFile(config.storagePath, id);
          let bytes: Buffer;
          try {
            bytes = preview
              ? await readFitnessPreview(config.storagePath, id, path, request.log)
              : await readFile(path);
          } catch (error) {
            request.log.error({ err: error, media_id: id }, '读取动作素材文件失败');
            if (preview && (error as NodeJS.ErrnoException).code !== 'ENOENT')
              throw new ApiError(500, 'FITNESS_MEDIA_PREVIEW_FAILED', '动作预览暂时不可用，请稍后重试');
            throw new ApiError(404, 'FITNESS_MEDIA_NOT_FOUND', '动作素材暂时不可用');
          }
          reply
            .header('content-type', preview ? 'image/webp' : 'image/gif')
            .header('x-content-type-options', 'nosniff');
          reply.header('cache-control', admin ? 'no-store' : 'public, max-age=86400');
          if (preview) {
            const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
            reply.header('etag', etag);
            const matches = request.headers['if-none-match']?.split(',').some((value) => {
              const candidate = value.trim().replace(/^W\//, '');
              return candidate === '*' || candidate === etag;
            });
            if (matches) return reply.code(304).send();
          }
          return reply.send(bytes);
        }),
    );
  }
}
