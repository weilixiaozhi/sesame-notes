import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { AnyUuidSchema } from '../../shared/contracts/scalars.js';
import { executor } from '../../shared/execute.js';
import { authenticate, requireAuth, requireScopes } from '../auth/index.js';
import {
  MEMO_MEDIA_BASE64_MAX_LENGTH,
  MEMO_MEDIA_UPLOAD_BODY_LIMIT,
  readMemoMedia,
  sanitizeMemoImage,
  storeMemoMedia,
} from './memo-media-storage.js';

/** 图片路由共用的 500 失败码，捕获与日志由公共执行器负责。 */
const executeMemoMedia = executor('MEMO_MEDIA_OPERATION_FAILED');

const MemoMediaMetadataSchema = Type.Object({
  id: AnyUuidSchema,
  byte_size: Type.Integer({ minimum: 1 }),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
});

const MemoMediaContentTypeSchema = Type.Union([
  Type.Literal('image/png'),
  Type.Literal('image/jpeg'),
  Type.Literal('image/webp'),
]);

/**
 * 注册备忘录内联图片的上传与读取接口。
 *
 * 客户端先生成图片标识并在正文中引用，再上传字节：
 * 上传幂等，重复提交同一标识同一内容返回已有元数据，不同内容拒绝覆盖。
 */
export function registerMemoMediaRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };

  app.put(
    '/api/v1/memo-media/:media_id',
    {
      ...secured,
      // 路由级正文上限容纳 8 MiB 原图的 Base64 编码及 JSON 开销。
      bodyLimit: MEMO_MEDIA_UPLOAD_BODY_LIMIT,
      schema: {
        tags: ['memos'],
        params: Type.Object({ media_id: AnyUuidSchema }),
        body: Type.Object({
          content_type: MemoMediaContentTypeSchema,
          data_base64: Type.String({ pattern: '^[A-Za-z0-9+/]+={0,2}$', maxLength: MEMO_MEDIA_BASE64_MAX_LENGTH }),
        }),
        response: {
          200: MemoMediaMetadataSchema,
          413: Type.Ref(ErrorSchema),
          422: Type.Ref(ErrorSchema),
        },
      },
    },
    async (request) =>
      executeMemoMedia(request, '上传备忘录图片', async () => {
        const auth = requireAuth(request);
        const { media_id: mediaId } = request.params as { media_id: string };
        const body = request.body as { content_type: 'image/png' | 'image/jpeg' | 'image/webp'; data_base64: string };
        const image = await sanitizeMemoImage(body.content_type, body.data_base64);
        return storeMemoMedia(prisma, config.storagePath, auth.userId, { id: mediaId, image }, request.log);
      }),
  );

  app.get(
    '/api/v1/memo-media/:media_id',
    {
      ...secured,
      schema: {
        tags: ['memos'],
        params: Type.Object({ media_id: AnyUuidSchema }),
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
      executeMemoMedia(request, '读取备忘录图片', async () => {
        const auth = requireAuth(request);
        const { media_id: mediaId } = request.params as { media_id: string };
        const media = await readMemoMedia(prisma, config.storagePath, auth.userId, mediaId);
        // 标识与内容一一对应，客户端可按 SHA 做长期不可变缓存。
        return reply
          .type(media.contentType)
          .header('cache-control', 'private, max-age=31536000, immutable')
          .header('etag', `"${media.row.sha256}"`)
          .send(media.bytes);
      }),
  );
}
