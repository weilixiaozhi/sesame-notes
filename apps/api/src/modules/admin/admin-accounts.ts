import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { createMultiKeyRateLimit } from '../../shared/rate-limit.js';
import { writeAuditLog } from './audit-log.js';
import { validateAdminPaginationQuery } from './admin-pagination.js';
import {
  AdminAccountListSchema,
  AdminAccountSchema,
  AdminIdentityTypeSchema,
  AdminPageQueryProperties,
  AdminReasonSchema,
  AdminVersionSchema,
} from './admin-schemas.js';
import { ADMIN_IDENTITIES, DEFAULT_ADMIN_GROUP_ID, parseAdminIdentity } from './admin-policy.js';
import {
  adminAccountResponse,
  adminManagementFailed,
  adminPagination,
  assertAdminVersion,
  normalizedAdminText,
  protectLastSuperAdmin,
  requireAdminGroup,
} from './admin-management.js';
import { registerAdminGroupRoutes } from './admin-groups.js';
import { assertAdminContactsAvailable, normalizeAdminEmail, normalizeAdminPhone } from './admin-identifiers.js';
import {
  adminLoginIdentifierDigest,
  authenticateAdmin,
  hashAdminPassword,
  normalizeAdminUsername,
  revokeAdminSessions,
  validateAdminPassword,
  verifyAdminWriteRequest,
  withAdminMutation,
} from './admin-security.js';

type Params = { admin_id: string };
type AccountQuery = {
  q?: string;
  identity_type?: string;
  group_id?: string;
  is_enabled?: boolean;
  page?: number;
  page_size?: number;
};
const ParamsSchema = Type.Object({ admin_id: UuidSchema });

/** 后台用户控制面只向超级管理员开放，写入、权限重验和日志共享同一事务。 */
export function registerAdminAccountRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const guarded = {
    onRequest: verifyAdminWriteRequest(config),
    preHandler: authenticateAdmin(config, prisma, 'accounts:manage'),
  };
  const passwordRateLimited = createMultiKeyRateLimit(config.authRateLimitMax, 60_000, (request) =>
    request.adminAuth ? adminLoginIdentifierDigest(request.adminAuth.username) : null,
  );
  registerAdminGroupRoutes(app, prisma, config);
  app.get(
    '/api/v1/admin/identity-types',
    {
      ...guarded,
      schema: {
        tags: ['admin-accounts'],
        response: {
          200: Type.Object({
            items: Type.Array(Type.Object({ value: AdminIdentityTypeSchema, label: Type.String() })),
          }),
        },
      },
    },
    async () => ({ items: ADMIN_IDENTITIES }),
  );
  app.get(
    '/api/v1/admin/accounts',
    {
      ...guarded,
      preValidation: validateAdminPaginationQuery,
      schema: {
        tags: ['admin-accounts'],
        querystring: Type.Object(
          {
            ...AdminPageQueryProperties,
            q: Type.Optional(Type.String({ maxLength: 254 })),
            identity_type: Type.Optional(AdminIdentityTypeSchema),
            group_id: Type.Optional(UuidSchema),
            is_enabled: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: { 200: AdminAccountListSchema },
      },
    },
    async (request) => {
      try {
        const query = request.query as AccountQuery;
        const where: Prisma.AdminAccountWhereInput = {
          deletedAt: null,
          ...(query.identity_type ? { identityType: query.identity_type } : {}),
          ...(query.group_id ? { groupId: query.group_id } : {}),
          ...(query.is_enabled === undefined ? {} : { isEnabled: query.is_enabled }),
          ...(query.q?.trim()
            ? {
                OR: [
                  { username: { contains: query.q.trim(), mode: 'insensitive' } },
                  { displayName: { contains: query.q.trim(), mode: 'insensitive' } },
                  { email: { contains: query.q.trim(), mode: 'insensitive' } },
                  { phone: { contains: query.q.trim() } },
                ],
              }
            : {}),
        };
        return await prisma.$transaction(
          async (tx) => {
            const total = await tx.adminAccount.count({ where });
            const pagination = adminPagination(total, query.page, query.page_size);
            const rows = await tx.adminAccount.findMany({
              where,
              orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
              skip: pagination.skip,
              take: pagination.page_size,
              include: { group: true },
            });
            return {
              items: rows.map(adminAccountResponse),
              page: pagination.page,
              page_size: pagination.page_size,
              total,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        );
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  app.post(
    '/api/v1/admin/accounts',
    {
      ...guarded,
      bodyLimit: 4096,
      preHandler: [guarded.preHandler, passwordRateLimited],
      schema: {
        tags: ['admin-accounts'],
        body: Type.Object(
          {
            username: Type.String({ minLength: 4, maxLength: 32 }),
            password: Type.String({ minLength: 1 }),
            display_name: Type.String({ maxLength: 100 }),
            email: Type.Optional(Type.Union([Type.String({ maxLength: 254 }), Type.Null()])),
            phone: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
            group_id: Type.Optional(UuidSchema),
          },
          { additionalProperties: false },
        ),
        response: { 201: AdminAccountSchema },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as {
          username: string;
          password: string;
          display_name: string;
          email?: string | null;
          phone?: string | null;
          group_id?: string;
        };
        const username = normalizeAdminUsername(body.username);
        const displayName = normalizedAdminText(body.display_name, 100);
        const email = normalizeAdminEmail(body.email);
        const phone = normalizeAdminPhone(body.phone);
        validateAdminPassword(body.password);
        const passwordHash = await hashAdminPassword(body.password);
        const created = await withAdminMutation(prisma, request, 'accounts:manage', async (tx, auth) => {
          const group = await requireAdminGroup(tx, body.group_id ?? DEFAULT_ADMIN_GROUP_ID);
          if (await tx.adminAccount.findUnique({ where: { username }, select: { id: true } }))
            throw new ApiError(409, 'ADMIN_USERNAME_EXISTS', '此登录账号已存在，请更换');
          await assertAdminContactsAvailable(tx, { email, phone });
          const account = await tx.adminAccount.create({
            data: {
              username,
              email,
              phone,
              displayName,
              passwordHash,
              identityType: 'standard_user',
              groupId: group.id,
              createdBy: auth.username,
              updatedBy: auth.username,
            },
            include: { group: true },
          });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.account.create',
            target: { type: 'admin_account', id: account.id },
            requestId: request.id,
            ip: request.ip,
            metadata: { username, group_name: account.group.name, identity_type: account.identityType },
          });
          return account;
        });
        return await reply.code(201).send(adminAccountResponse(created));
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  app.patch(
    '/api/v1/admin/accounts/:admin_id',
    {
      ...guarded,
      schema: {
        tags: ['admin-accounts'],
        params: ParamsSchema,
        body: Type.Object(
          {
            version: AdminVersionSchema,
            display_name: Type.Optional(Type.String({ maxLength: 100 })),
            email: Type.Optional(Type.Union([Type.String({ maxLength: 254 }), Type.Null()])),
            phone: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
            group_id: Type.Optional(UuidSchema),
            is_enabled: Type.Optional(Type.Boolean()),
            reason: Type.Optional(AdminReasonSchema),
          },
          { additionalProperties: false },
        ),
        response: { 200: AdminAccountSchema },
      },
    },
    async (request) => {
      try {
        const body = request.body as {
          version: number;
          display_name?: string;
          email?: string | null;
          phone?: string | null;
          group_id?: string;
          is_enabled?: boolean;
          reason?: string;
        };
        if (
          body.display_name === undefined &&
          body.group_id === undefined &&
          body.is_enabled === undefined &&
          body.email === undefined &&
          body.phone === undefined
        )
          throw new ApiError(400, 'ADMIN_ACCOUNT_UPDATE_EMPTY', '请至少提供一项要修改的内容');
        const reason = body.reason === undefined ? undefined : normalizedAdminText(body.reason, 500);
        const updated = await withAdminMutation(prisma, request, 'accounts:manage', async (tx, auth) => {
          const current = await tx.adminAccount.findUnique({
            where: { id: (request.params as Params).admin_id },
            include: { group: true },
          });
          if (!current || current.deletedAt !== null)
            throw new ApiError(404, 'ADMIN_ACCOUNT_NOT_FOUND', '后台用户不存在或已删除');
          assertAdminVersion(current.version, body.version);
          const nextGroupId = body.group_id ?? current.groupId;
          const email = body.email === undefined ? current.email : normalizeAdminEmail(body.email);
          const phone = body.phone === undefined ? current.phone : normalizeAdminPhone(body.phone);
          const changedCredentials = email !== current.email || phone !== current.phone;
          const group = await requireAdminGroup(tx, nextGroupId);
          const changedAccess =
            nextGroupId !== current.groupId || (body.is_enabled !== undefined && body.is_enabled !== current.isEnabled);
          if ((changedAccess || changedCredentials) && !reason)
            throw new ApiError(400, 'ADMIN_REASON_REQUIRED', '请填写操作原因');
          await assertAdminContactsAvailable(tx, { email, phone }, current.id);
          if (current.id === auth.adminId && body.is_enabled === false)
            throw new ApiError(400, 'CANNOT_DISABLE_SELF', '不能停用当前登录账号');
          await protectLastSuperAdmin(tx, current, {
            identityType: current.identityType,
            isEnabled: body.is_enabled ?? current.isEnabled,
            deletedAt: null,
          });
          const account = await tx.adminAccount.update({
            where: { id: current.id },
            data: {
              ...(body.display_name === undefined ? {} : { displayName: normalizedAdminText(body.display_name, 100) }),
              email,
              phone,
              groupId: nextGroupId,
              ...(body.is_enabled === undefined ? {} : { isEnabled: body.is_enabled }),
              version: { increment: 1 },
              updatedBy: auth.username,
            },
            include: { group: true },
          });
          // 联系方式同时承担登录凭据，改变后撤销旧会话，避免旧身份继续访问。
          if (changedAccess || changedCredentials) await revokeAdminSessions(tx, current.id);
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.account.update',
            target: { type: 'admin_account', id: current.id },
            requestId: request.id,
            ip: request.ip,
            metadata: {
              username: account.username,
              previous_group_name: current.group.name,
              group_name: group.name,
              previous_is_enabled: current.isEnabled,
              is_enabled: account.isEnabled,
              changed_fields: [
                ...(email !== current.email ? ['email'] : []),
                ...(phone !== current.phone ? ['phone'] : []),
              ],
              ...(reason ? { reason } : {}),
            },
          });
          return account;
        });
        return adminAccountResponse(updated);
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  app.put(
    '/api/v1/admin/accounts/:admin_id/identity',
    {
      ...guarded,
      schema: {
        tags: ['admin-accounts'],
        params: ParamsSchema,
        body: Type.Object(
          { version: AdminVersionSchema, identity_type: AdminIdentityTypeSchema, reason: AdminReasonSchema },
          { additionalProperties: false },
        ),
        response: { 200: AdminAccountSchema },
      },
    },
    async (request) => {
      try {
        const body = request.body as { version: number; identity_type: string; reason: string };
        const identityType = parseAdminIdentity(body.identity_type);
        const reason = normalizedAdminText(body.reason, 500);
        const updated = await withAdminMutation(prisma, request, 'accounts:manage', async (tx, auth) => {
          const current = await tx.adminAccount.findUnique({
            where: { id: (request.params as Params).admin_id },
            include: { group: true },
          });
          if (!current || current.deletedAt !== null)
            throw new ApiError(404, 'ADMIN_ACCOUNT_NOT_FOUND', '后台用户不存在或已删除');
          assertAdminVersion(current.version, body.version);
          await protectLastSuperAdmin(tx, current, { identityType, isEnabled: current.isEnabled, deletedAt: null });
          const account = await tx.adminAccount.update({
            where: { id: current.id },
            data: { identityType, version: { increment: 1 }, updatedBy: auth.username },
            include: { group: true },
          });
          if (identityType !== current.identityType) await revokeAdminSessions(tx, current.id);
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.account.identity',
            target: { type: 'admin_account', id: current.id },
            requestId: request.id,
            ip: request.ip,
            metadata: {
              username: current.username,
              identity_type: identityType,
              previous_identity_type: current.identityType,
              reason,
            },
          });
          return account;
        });
        return adminAccountResponse(updated);
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  app.delete(
    '/api/v1/admin/accounts/:admin_id',
    {
      ...guarded,
      schema: {
        tags: ['admin-accounts'],
        params: ParamsSchema,
        body: Type.Object({ version: AdminVersionSchema, reason: AdminReasonSchema }, { additionalProperties: false }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as { version: number; reason: string };
        const reason = normalizedAdminText(body.reason, 500);
        await withAdminMutation(prisma, request, 'accounts:manage', async (tx, auth) => {
          const current = await tx.adminAccount.findUnique({
            where: { id: (request.params as Params).admin_id },
            include: { group: true },
          });
          if (!current || current.deletedAt !== null)
            throw new ApiError(404, 'ADMIN_ACCOUNT_NOT_FOUND', '后台用户不存在或已删除');
          assertAdminVersion(current.version, body.version);
          if (current.id === auth.adminId) throw new ApiError(400, 'CANNOT_DELETE_SELF', '不能删除当前登录账号');
          const deletedAt = new Date();
          await protectLastSuperAdmin(tx, current, { identityType: current.identityType, isEnabled: false, deletedAt });
          await tx.adminAccount.update({
            where: { id: current.id },
            data: {
              deletedAt,
              deletedBy: auth.username,
              isEnabled: false,
              updatedBy: auth.username,
              version: { increment: 1 },
            },
          });
          await revokeAdminSessions(tx, current.id);
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.account.delete',
            target: { type: 'admin_account', id: current.id },
            requestId: request.id,
            ip: request.ip,
            metadata: { username: current.username, reason },
          });
        });
        return await reply.code(204).send();
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  app.post(
    '/api/v1/admin/accounts/:admin_id/reset-password',
    {
      ...guarded,
      bodyLimit: 4096,
      preHandler: [guarded.preHandler, passwordRateLimited],
      schema: {
        tags: ['admin-accounts'],
        params: ParamsSchema,
        body: Type.Object(
          { version: AdminVersionSchema, new_password: Type.String({ minLength: 1 }), reason: AdminReasonSchema },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      try {
        const adminId = (request.params as Params).admin_id;
        const body = request.body as { version: number; new_password: string; reason: string };
        const reason = normalizedAdminText(body.reason, 500);
        const snapshot = await prisma.adminAccount.findUnique({ where: { id: adminId } });
        if (!snapshot || snapshot.deletedAt !== null)
          throw new ApiError(404, 'ADMIN_ACCOUNT_NOT_FOUND', '后台用户不存在或已删除');
        validateAdminPassword(body.new_password);
        const passwordHash = await hashAdminPassword(body.new_password);
        await withAdminMutation(prisma, request, 'accounts:manage', async (tx, auth) => {
          if (adminId === auth.adminId)
            throw new ApiError(400, 'CANNOT_RESET_SELF', '修改本人密码请使用需要验证原密码的改密功能');
          const current = await tx.adminAccount.findUnique({ where: { id: adminId } });
          if (!current || current.deletedAt !== null)
            throw new ApiError(404, 'ADMIN_ACCOUNT_NOT_FOUND', '后台用户不存在或已删除');
          assertAdminVersion(current.version, body.version);
          await tx.adminAccount.update({
            where: { id: adminId },
            data: {
              passwordHash,
              failedLoginAttempts: 0,
              lockedUntil: null,
              version: { increment: 1 },
              updatedBy: auth.username,
            },
          });
          await revokeAdminSessions(tx, adminId);
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.password.reset',
            target: { type: 'admin_account', id: adminId },
            requestId: request.id,
            ip: request.ip,
            metadata: { username: current.username, reason },
          });
        });
        return await reply.code(204).send();
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
}
