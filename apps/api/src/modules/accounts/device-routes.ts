import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { AnyUuidSchema, TimestampSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import {
  authenticate,
  lockAccountSessions,
  requireAuth,
  requireScopes,
  terminateRefreshTokens,
} from '../auth/index.js';

const DeviceSchema = Type.Object({
  id: AnyUuidSchema,
  name: Type.String(),
  platform: Type.String(),
  app_version: Type.Union([Type.String(), Type.Null()]),
  os_version: Type.Union([Type.String(), Type.Null()]),
  device_model: Type.Union([Type.String(), Type.Null()]),
  last_seen_at: TimestampSchema,
  created_at: TimestampSchema,
  revoked_at: Type.Union([TimestampSchema, Type.Null()]),
  current: Type.Boolean(),
});

/** 注册当前账号的登录设备查询与撤销接口。 */
export function registerDeviceRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('profile:read', 'profile:write')] };

  app.get(
    '/api/v1/devices',
    { ...secured, schema: { tags: ['devices'], response: { 200: Type.Array(DeviceSchema) } } },
    async (request) =>
      execute(request, '读取设备列表', async () => {
        const auth = requireAuth(request);
        const devices = await prisma.device.findMany({
          where: { userId: auth.userId },
          orderBy: { lastSeenAt: 'desc' },
        });
        return devices.map((device) => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
          app_version: device.appVersion,
          os_version: device.osVersion,
          device_model: device.deviceModel,
          last_seen_at: device.lastSeenAt.toISOString(),
          created_at: device.createdAt.toISOString(),
          revoked_at: device.revokedAt?.toISOString() ?? null,
          current: device.id === auth.deviceId,
        }));
      }),
  );

  app.delete(
    '/api/v1/devices/:device_id',
    {
      ...secured,
      schema: { tags: ['devices'], params: Type.Object({ device_id: UuidSchema }), response: { 204: Type.Null() } },
    },
    async (request, reply) =>
      execute(request, '撤销设备', async () => {
        const auth = requireAuth(request);
        const { device_id: deviceId } = request.params as { device_id: string };
        await prisma.$transaction(async (tx) => {
          await lockAccountSessions(tx, auth.userId);
          const changed = await tx.device.updateMany({
            where: { id: deviceId, userId: auth.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          if (changed.count === 0) throw new ApiError(404, 'DEVICE_NOT_FOUND', '设备不存在或已下线');
          await terminateRefreshTokens(tx, auth.userId, { deviceId });
        });
        // 设备与刷新令牌同时提交后，响应阶段关闭该账号已失效的实时连接。
        request.realtimeRevalidationUserIds.add(auth.userId);
        await reply.status(204).send();
      }),
  );
}
