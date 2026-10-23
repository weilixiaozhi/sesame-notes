import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { registerAvatarRoutes } from './avatar-routes.js';
import { registerDeviceRoutes } from './device-routes.js';
import { registerProfileRoutes } from './profile-routes.js';

export { deleteAccount } from './account-deletion.js';
export {
  AVATAR_BASE64_MAX_LENGTH,
  AVATAR_UPLOAD_BODY_LIMIT,
  AvatarContentTypeSchema,
  decodeAvatar,
  extensionFor,
  type AvatarContentType,
} from './avatar-routes.js';
export { cleanupAvatarFiles, replaceAvatar } from './avatar-storage.js';

/** 注册账号资源接口：个人资料、头像与登录设备。 */
export function registerAccountRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  try {
    registerAvatarRoutes(app, prisma, config);
    registerProfileRoutes(app, prisma, config);
    registerDeviceRoutes(app, prisma, config);
  } catch (cause) {
    throw new Error('账号资源接口注册失败', { cause });
  }
}
