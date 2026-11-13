import { readFile } from 'node:fs/promises';
import { replaceAvatar } from './avatar-storage.js';
import { extname, resolve } from 'node:path';

import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { UuidSchema } from '../../shared/contracts/scalars.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import { executor } from '../../shared/execute.js';
import { sanitizeImage } from '../../shared/image-sanitize.js';

/** 头像路由共用的 500 失败码，捕获与日志由公共执行器负责。 */
const executeAvatar = executor('AVATAR_OPERATION_FAILED');

/** 原图字节上限：8 MiB（客户端按同一上限校验后上传）。 */
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
/** 单边像素上限：与总像素上限共同构成解压炸弹防护，客户端镜像同一常量缩放。 */
const MAX_AVATAR_DIMENSION = 8192;
/** 总像素上限（约 8192×4883）：超过即拒绝，避免极小体积的极端尺寸图拖垮解码。 */
const MAX_AVATAR_PIXELS = 40_000_000;
/** Base64 编码长度上限：由字节上限推导，避免两个常量各自维护后漂移。 */
export const AVATAR_BASE64_MAX_LENGTH = Math.ceil(MAX_AVATAR_BYTES / 3) * 4;
/** 上传路由独立 bodyLimit：容纳原图上限的 Base64 + JSON 开销，不放大全局限制。 */
export const AVATAR_UPLOAD_BODY_LIMIT = 12 * 1024 * 1024;
export const AvatarContentTypeSchema = Type.Union([
  Type.Literal('image/png'),
  Type.Literal('image/jpeg'),
  Type.Literal('image/webp'),
]);
const AvatarMetadataSchema = Type.Object({
  avatar_url: Type.String(),
  avatar_version: Type.Integer({ minimum: 1 }),
});

export type AvatarContentType = 'image/png' | 'image/jpeg' | 'image/webp';

/** 注册头像上传、下载和删除接口；JSON Base64 让 OpenAPI 客户端无需手写 multipart 适配层。 */
export function registerAvatarRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  // 头像路由按资源校验最小 scope：读 profile:read，写 profile:write
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('profile:read', 'profile:write')] };

  app.put(
    '/api/v1/profile/avatar',
    {
      ...secured,
      // 路由级正文上限容纳 8 MiB 原图的 Base64 编码及 JSON 开销。
      bodyLimit: AVATAR_UPLOAD_BODY_LIMIT,
      schema: {
        tags: ['profile'],
        body: Type.Object({
          content_type: AvatarContentTypeSchema,
          data_base64: Type.String({ pattern: '^[A-Za-z0-9+/]+={0,2}$', maxLength: AVATAR_BASE64_MAX_LENGTH }),
        }),
        response: { 200: AvatarMetadataSchema, 413: Type.Ref(ErrorSchema), 422: Type.Ref(ErrorSchema) },
      },
    },
    async (request) =>
      executeAvatar(request, '上传头像', async () => {
        const auth = requireAuth(request);
        const body = request.body as { content_type: AvatarContentType; data_base64: string };
        const bytes = await decodeAvatar(body.content_type, body.data_base64);
        const profile = await replaceAvatar(
          prisma,
          config.storagePath,
          auth.userId,
          { bytes, extension: extensionFor(body.content_type) },
          request.log,
        );
        if (!profile) throw new Error('头像元数据未保存');
        return {
          avatar_url: `/api/v1/profile/avatar/${auth.userId}?v=${profile.avatarVersion}`,
          avatar_version: profile.avatarVersion,
        };
      }),
  );

  app.get(
    '/api/v1/profile/avatar/:user_id',
    {
      ...secured,
      schema: {
        tags: ['profile'],
        params: Type.Object({ user_id: UuidSchema }),
        // 原始图片字节及全部受支持类型，供 OpenAPI 客户端生成与契约校验。
        response: {
          200: {
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'image/webp': { schema: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
    },
    async (request, reply) =>
      executeAvatar(request, '下载头像', async () => {
        const auth = requireAuth(request);
        const { user_id: userId } = request.params as { user_id: string };
        // 本人始终允许下载；他人只在与请求人共享至少一个 ACTIVE 账本成员关系时允许，
        // 不满足条件统一返回 404，避免用户枚举
        if (auth.userId !== userId) {
          const shared = await prisma.ledgerMember.count({
            where: {
              linkedAccountId: auth.userId,
              memberType: 'REGISTERED',
              status: 'ACTIVE',
              ledger: {
                deletedAt: null,
                members: { some: { linkedAccountId: userId, memberType: 'REGISTERED', status: 'ACTIVE' } },
              },
            },
          });
          if (!shared) throw new ApiError(404, 'AVATAR_NOT_FOUND', '头像不存在');
        }
        const profile = await prisma.userProfile.findUnique({
          where: { userId },
          select: { avatarFileId: true },
        });
        if (!profile?.avatarFileId) throw new ApiError(404, 'AVATAR_NOT_FOUND', '头像不存在');
        const directory = resolve(config.storagePath, 'avatars');
        const bytes = await readFile(resolveAvatarPath(directory, profile.avatarFileId));
        // avatar_url 语义为可直接加载的图片地址：返回原始字节而非 JSON Base64
        return reply.type(contentTypeFor(profile.avatarFileId)).send(bytes);
      }),
  );

  app.delete(
    '/api/v1/profile/avatar',
    {
      ...secured,
      schema: { tags: ['profile'], response: { 204: Type.Null() } },
    },
    async (request, reply) =>
      executeAvatar(request, '删除头像', async () => {
        const auth = requireAuth(request);
        await replaceAvatar(prisma, config.storagePath, auth.userId, null, request.log);
        await reply.status(204).send();
      }),
  );
}

/**
 * 解码并净化头像：完整解码验证、像素上限检查，再统一重编码以剥离
 * EXIF/定位等元数据；头像保留原始尺寸，只做无损/固定质量重编码。
 */
export async function decodeAvatar(contentType: AvatarContentType, data: string): Promise<Buffer> {
  const image = await sanitizeImage({
    contentType,
    data,
    maxBytes: MAX_AVATAR_BYTES,
    maxDimension: MAX_AVATAR_DIMENSION,
    maxPixels: MAX_AVATAR_PIXELS,
    tooLargeCode: 'AVATAR_TOO_LARGE',
    tooLargeMessage: '图片过大，请选择较小的图片',
    invalidCode: 'AVATAR_INVALID',
    invalidMessage: '无法识别该图片，请重新选择',
  });
  return image.bytes;
}

/** 根据受支持的 MIME 类型选择固定扩展名，文件名不接受客户端输入。 */
export function extensionFor(contentType: AvatarContentType): '.png' | '.jpg' | '.webp' {
  return contentType === 'image/png' ? '.png' : contentType === 'image/jpeg' ? '.jpg' : '.webp';
}

/** 从服务端生成的扩展名恢复 MIME 类型，并拒绝数据库中的异常文件名。 */
function contentTypeFor(fileName: string): AvatarContentType {
  const extension = extname(fileName);
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  throw new ApiError(404, 'AVATAR_NOT_FOUND', '头像文件无效');
}

/** 将头像文件限制在指定目录，避免损坏的数据库值形成路径穿越。 */
function resolveAvatarPath(directory: string, fileName: string): string {
  if (!/^[0-9a-f-]{36}\.(?:png|jpg|webp)$/.test(fileName)) throw new ApiError(404, 'AVATAR_NOT_FOUND', '头像文件无效');
  return resolve(directory, fileName);
}
