import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Prisma, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import { lockAccountSessions, maskPhoneE164, terminateRefreshTokens } from '../auth/index.js';
import {
  adminOperationReason,
  adminPage,
  AdminPageQuery,
  AdminReasonSchema,
  validateAdminPaginationQuery,
  type AdminPageInput,
} from './admin-pagination.js';
import { authenticateAdmin, withAdminMutation, type AdminPermission } from './admin-security.js';
import {
  AdminDeviceListSchema,
  AdminUserDetailSchema,
  AdminUserListSchema,
  AdminUserStateSchema,
} from './admin-user-schemas.js';
import { writeAuditLog } from './audit-log.js';
import { registerAdminUserCredentialRoutes } from './admin-user-credentials.js';
import { registerAdminUserAvatarRoutes } from './admin-user-avatar.js';

/** 读取资料时显式选取白名单，密码、AI 配置和会话材料不会进入路由内存。 */
export const ADMIN_USER_SELECT = {
  id: true,
  phoneE164: true,
  sesameNumber: true,
  isEnabled: true,
  createdAt: true,
  profile: {
    select: {
      displayName: true,
      gender: true,
      avatarFileId: true,
      avatarVersion: true,
      updatedAt: true,
      primaryCurrency: true,
      themePrimaryColor: true,
    },
  },
} satisfies Prisma.UserSelect;

type AdminUserRow = Prisma.UserGetPayload<{ select: typeof ADMIN_USER_SELECT }>;
type UserQuery = AdminPageInput & { search?: string; is_enabled?: boolean };
type UserParams = { user_id: string };
type DeviceParams = UserParams & { device_id: string };

/** 将内部关联资料转换成经过授权的后台展示字段，不输出账号凭据或设备细节。 */
function adminUserResponse(user: AdminUserRow) {
  return {
    id: user.id,
    phone: user.phoneE164,
    phone_masked: maskPhoneE164(user.phoneE164),
    sesame_number: user.sesameNumber,
    display_name: user.profile?.displayName ?? null,
    gender: user.profile?.gender ?? 'UNSPECIFIED',
    // 列表与详情共用后台会话头像地址，版本号使头像更新能触发重新读取。
    avatar_url: user.profile?.avatarFileId
      ? `/api/v1/admin/users/${user.id}/avatar?v=${user.profile.avatarVersion}`
      : null,
    avatar_version: user.profile?.avatarVersion ?? 0,
    is_enabled: user.isEnabled,
    created_at: user.createdAt.toISOString(),
  };
}

/** 搜索只按已确认的手机号和芝麻号匹配，计数和分页读取使用相同筛选条件。 */
export function adminUserWhere(query: UserQuery): Prisma.UserWhereInput {
  const search = query.search?.trim();
  return {
    ...(query.is_enabled === undefined ? {} : { isEnabled: query.is_enabled }),
    ...(search
      ? { OR: [{ phoneE164: { contains: search, mode: 'insensitive' } }, { sesameNumber: { contains: search } }] }
      : {}),
  };
}

/** 从目标用户当前关联读取头像，只允许服务器生成的文件名和受支持的图片类型。 */
export function adminAvatarFile(storagePath: string, fileName: string) {
  const match = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/.exec(fileName);
  if (!match) throw new ApiError(404, 'AVATAR_NOT_FOUND', '头像不存在');
  return {
    path: resolve(storagePath, 'avatars', fileName),
    contentType: match[1] === 'jpg' ? 'image/jpeg' : `image/${match[1]}`,
  };
}

/** 注册用户资料、设备和启停操作；所有写入复用同一管理授权与事务锁。 */
export function registerAdminUserRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  registerAdminUserCredentialRoutes(app, prisma, config);
  registerAdminUserAvatarRoutes(app, prisma, config);
  /** 每个入口显式声明动作权限，供启动期路由策略核验。 */
  const secured = (permission: AdminPermission) => ({ preHandler: [authenticateAdmin(config, prisma, permission)] });

  app.get(
    '/api/v1/admin/users',
    {
      ...secured('users:read'),
      preValidation: validateAdminPaginationQuery,
      schema: {
        tags: ['admin'],
        querystring: Type.Object({
          ...AdminPageQuery,
          search: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          is_enabled: Type.Optional(Type.Boolean()),
        }),
        response: { 200: AdminUserListSchema },
      },
    },
    async (request) =>
      execute(request, '查询应用用户', async () => {
        const query = request.query as UserQuery;
        const where = adminUserWhere(query);
        // 同一可重复读快照确保 total、修正后的页码和页面记录来自相同数据状态。
        return prisma.$transaction(
          async (tx) => {
            const page = adminPage(query, await tx.user.count({ where }));
            const rows = await tx.user.findMany({
              where,
              select: ADMIN_USER_SELECT,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              skip: page.skip,
              take: page.page_size,
            });
            return {
              items: rows.map(adminUserResponse),
              page: page.page,
              page_size: page.page_size,
              total: page.total,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
      }),
  );

  app.get(
    '/api/v1/admin/users/:user_id',
    {
      ...secured('users:read'),
      schema: {
        tags: ['admin'],
        params: Type.Object({ user_id: UuidSchema }),
        response: { 200: AdminUserDetailSchema },
      },
    },
    async (request) =>
      execute(request, '读取应用用户资料', async () => {
        const { user_id: userId } = request.params as UserParams;
        const user = await prisma.user.findUnique({ where: { id: userId }, select: ADMIN_USER_SELECT });
        if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
        return {
          ...adminUserResponse(user),
          profile_updated_at: user.profile?.updatedAt.toISOString() ?? null,
          primary_currency: user.profile?.primaryCurrency ?? null,
          theme_primary_color: user.profile?.themePrimaryColor ?? null,
        };
      }),
  );

  app.get(
    '/api/v1/admin/users/:user_id/avatar',
    {
      ...secured('users:read'),
      schema: {
        tags: ['admin'],
        params: Type.Object({ user_id: UuidSchema }),
        querystring: Type.Object({ v: Type.Optional(Type.Integer({ minimum: 0 })) }),
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
      execute(request, '读取用户头像', async () => {
        const { user_id: userId } = request.params as UserParams;
        const profile = await prisma.userProfile.findUnique({ where: { userId }, select: { avatarFileId: true } });
        if (!profile?.avatarFileId) throw new ApiError(404, 'AVATAR_NOT_FOUND', '头像不存在');
        const file = adminAvatarFile(config.storagePath, profile.avatarFileId);
        try {
          const bytes = await readFile(file.path);
          return reply.header('x-content-type-options', 'nosniff').type(file.contentType).send(bytes);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new ApiError(404, 'AVATAR_NOT_FOUND', '头像不存在');
          throw error;
        }
      }),
  );

  app.get(
    '/api/v1/admin/users/:user_id/devices',
    {
      ...secured('devices:read'),
      schema: {
        tags: ['admin'],
        params: Type.Object({ user_id: UuidSchema }),
        querystring: Type.Object(AdminPageQuery),
        response: { 200: AdminDeviceListSchema },
      },
    },
    async (request) =>
      execute(request, '读取用户设备', async () => {
        const { user_id: userId } = request.params as UserParams;
        return prisma.$transaction(
          async (tx) => {
            const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
            if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
            const page = adminPage(request.query as AdminPageInput, await tx.device.count({ where: { userId } }));
            const devices = await tx.device.findMany({
              where: { userId },
              select: {
                id: true,
                name: true,
                platform: true,
                appVersion: true,
                osVersion: true,
                deviceModel: true,
                lastIp: true,
                createdAt: true,
                lastSeenAt: true,
                revokedAt: true,
              },
              orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
              skip: page.skip,
              take: page.page_size,
            });
            return {
              items: devices.map((device) => ({
                id: device.id,
                name: device.name,
                platform: device.platform,
                app_version: device.appVersion,
                os_version: device.osVersion,
                device_model: device.deviceModel,
                last_ip: device.lastIp,
                created_at: device.createdAt.toISOString(),
                last_seen_at: device.lastSeenAt.toISOString(),
                revoked_at: device.revokedAt?.toISOString() ?? null,
              })),
              page: page.page,
              page_size: page.page_size,
              total: page.total,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
      }),
  );

  for (const enabled of [false, true]) {
    app.patch(
      `/api/v1/admin/users/:user_id/${enabled ? 'enable' : 'disable'}`,
      {
        ...secured('users:write'),
        schema: {
          tags: ['admin'],
          params: Type.Object({ user_id: UuidSchema }),
          body: Type.Object({ reason: AdminReasonSchema }, { additionalProperties: false }),
          response: { 200: AdminUserStateSchema },
        },
      },
      async (request) =>
        execute(request, enabled ? '启用应用用户' : '禁用应用用户', async () => {
          const { user_id: userId } = request.params as UserParams;
          const reason = adminOperationReason(request.body);
          const user = await withAdminMutation(prisma, request, 'users:write', async (tx, auth) => {
            await lockAccountSessions(tx, userId);
            const current = await tx.user.findUnique({
              where: { id: userId },
              select: { id: true, phoneE164: true, isEnabled: true },
            });
            if (!current) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
            await tx.user.update({ where: { id: userId }, data: { isEnabled: enabled } });
            if (!enabled) await terminateRefreshTokens(tx, userId);
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: enabled ? 'user.enable' : 'user.disable',
              target: { type: 'user', id: userId },
              requestId: request.id,
              ip: request.ip,
              metadata: { reason, previous_is_enabled: current.isEnabled, is_enabled: enabled },
            });
            return current;
          });
          if (!enabled) request.realtimeRevalidationUserIds.add(userId);
          return { id: user.id, phone_masked: maskPhoneE164(user.phoneE164), is_enabled: enabled };
        }),
    );
  }

  /** 单设备撤销在锁内校验归属，状态、登录令牌和审计必须共同提交。 */
  const revokeDevice = async (request: FastifyRequest, reply: FastifyReply) =>
    execute(request, '撤销用户设备', async () => {
      const { user_id: userId, device_id: deviceId } = request.params as DeviceParams;
      const reason = adminOperationReason(request.body);
      await withAdminMutation(prisma, request, 'devices:revoke', async (tx, auth) => {
        await lockAccountSessions(tx, userId);
        const device = await tx.device.findFirst({
          where: { id: deviceId, userId },
          select: { id: true, revokedAt: true },
        });
        if (!device) throw new ApiError(404, 'DEVICE_NOT_FOUND', '设备不存在');
        if (device.revokedAt) throw new ApiError(409, 'DEVICE_ALREADY_REVOKED', '此设备的登录已撤销，请刷新设备列表');
        await tx.device.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
        await terminateRefreshTokens(tx, userId, { deviceId });
        await writeAuditLog(tx, {
          actor: `admin:${auth.adminId}`,
          action: 'device.revoke',
          target: { type: 'device', id: deviceId },
          requestId: request.id,
          ip: request.ip,
          metadata: { reason },
        });
      });
      request.realtimeRevalidationUserIds.add(userId);
      return reply.status(204).send();
    });
  app.post(
    '/api/v1/admin/users/:user_id/devices/:device_id/revoke',
    {
      ...secured('devices:revoke'),
      schema: {
        tags: ['admin'],
        params: Type.Object({ user_id: UuidSchema, device_id: UuidSchema }),
        body: Type.Object({ reason: AdminReasonSchema }, { additionalProperties: false }),
        response: { 204: Type.Null() },
      },
    },
    revokeDevice,
  );
}
