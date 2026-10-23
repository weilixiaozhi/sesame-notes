import type { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { UuidSchema } from '../../shared/contracts/scalars.js';
import { executor } from '../../shared/execute.js';
import {
  AVATAR_BASE64_MAX_LENGTH,
  AVATAR_UPLOAD_BODY_LIMIT,
  AvatarContentTypeSchema,
  decodeAvatar,
  extensionFor,
  replaceAvatar,
  type AvatarContentType,
} from '../accounts/index.js';
import { adminOperationReason, AdminReasonSchema } from './admin-pagination.js';
import { authenticateAdmin, withAdminMutation } from './admin-security.js';
import { writeAuditLog } from './audit-log.js';

const executeAvatar = executor('AVATAR_OPERATION_FAILED');
const AvatarVersionSchema = Type.Integer({ minimum: 0 });
type AvatarMutationBody = { avatar_version: number; reason: string };
type AvatarUploadBody = AvatarMutationBody & { content_type: AvatarContentType; data_base64: string };

/** 后台头像更新与原因审计在同一授权事务内提交，文件补偿覆盖整个事务的失败。 */
async function mutateAdminAvatar(
  request: FastifyRequest,
  prisma: PrismaClient,
  config: ApiConfig,
  image: { bytes: Buffer; extension: '.png' | '.jpg' | '.webp' } | null,
) {
  try {
    const { user_id: userId } = request.params as { user_id: string };
    const body = request.body as AvatarMutationBody;
    const reason = adminOperationReason(body);
    return await replaceAvatar(prisma, config.storagePath, userId, image, request.log, {
      expectedVersion: body.avatar_version,
      transaction: (operation) =>
        withAdminMutation(prisma, request, 'users:write', async (tx, auth) => {
          // 共享头像操作持有账号头像锁，读到的版本同时用于冲突判断和审计快照。
          const result = await operation(tx);
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: image ? 'user.avatar.update' : 'user.avatar.delete',
            target: { type: 'user', id: userId },
            requestId: request.id,
            ip: request.ip,
            metadata: {
              reason,
              previous_avatar_version: result.previousVersion,
              avatar_version: result.profile?.avatarVersion ?? 0,
            },
          });
          return result;
        }),
    });
  } catch (error) {
    // 日志只记录用户标识与异常；请求体包含图片内容，不得写入日志或审计。
    request.log.error({ err: error, request_id: request.id, user_id: request.params }, '后台用户头像保存失败');
    throw error;
  }
}

/** 注册管理员替换及删除应用用户头像接口，图片校验复用个人资料上传规则。 */
export function registerAdminUserAvatarRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  try {
    app.put(
      '/api/v1/admin/users/:user_id/avatar',
      {
        preHandler: [authenticateAdmin(config, prisma, 'users:write')],
        bodyLimit: AVATAR_UPLOAD_BODY_LIMIT,
        schema: {
          tags: ['admin'],
          params: Type.Object({ user_id: UuidSchema }),
          body: Type.Object(
            {
              content_type: AvatarContentTypeSchema,
              data_base64: Type.String({ pattern: '^[A-Za-z0-9+/]+={0,2}$', maxLength: AVATAR_BASE64_MAX_LENGTH }),
              avatar_version: AvatarVersionSchema,
              reason: AdminReasonSchema,
            },
            { additionalProperties: false },
          ),
          response: {
            200: Type.Object({ avatar_url: Type.String(), avatar_version: Type.Integer({ minimum: 1 }) }),
            409: Type.Ref(ErrorSchema),
            413: Type.Ref(ErrorSchema),
            422: Type.Ref(ErrorSchema),
          },
        },
      },
      async (request) =>
        executeAvatar(request, '设置用户头像', async () => {
          const body = request.body as AvatarUploadBody;
          const bytes = await decodeAvatar(body.content_type, body.data_base64);
          const profile = await mutateAdminAvatar(request, prisma, config, {
            bytes,
            extension: extensionFor(body.content_type),
          });
          if (!profile) throw new Error('头像元数据未保存');
          const { user_id: userId } = request.params as { user_id: string };
          return {
            avatar_url: `/api/v1/admin/users/${userId}/avatar?v=${profile.avatarVersion}`,
            avatar_version: profile.avatarVersion,
          };
        }),
    );
    app.delete(
      '/api/v1/admin/users/:user_id/avatar',
      {
        preHandler: [authenticateAdmin(config, prisma, 'users:write')],
        schema: {
          tags: ['admin'],
          params: Type.Object({ user_id: UuidSchema }),
          body: Type.Object(
            { avatar_version: AvatarVersionSchema, reason: AdminReasonSchema },
            { additionalProperties: false },
          ),
          response: { 204: Type.Null(), 409: Type.Ref(ErrorSchema) },
        },
      },
      async (request, reply) =>
        executeAvatar(request, '删除用户头像', async () => {
          await mutateAdminAvatar(request, prisma, config, null);
          return reply.status(204).send();
        }),
    );
  } catch (cause) {
    throw new Error('后台用户头像接口注册失败', { cause });
  }
}
