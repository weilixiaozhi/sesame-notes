import { Prisma, type AdminGroup, type PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { ApiConfig } from '../../shared/api-config.js';
import { UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { writeAuditLog } from './audit-log.js';
import {
  AdminAccountListSchema,
  AdminGroupListSchema,
  AdminGroupSchema,
  AdminPageQueryProperties,
  AdminReasonSchema,
  AdminVersionSchema,
} from './admin-schemas.js';
import {
  DEFAULT_ADMIN_GROUP_ID,
  ADMIN_BUSINESS_PERMISSIONS,
  ADMIN_IDENTITIES,
  ADMIN_PAGES,
  validateGroupAuthorization,
} from './admin-policy.js';
import {
  adminAccountResponse,
  adminManagementFailed,
  adminPagination,
  assertAdminVersion,
  normalizedAdminText,
  requireAdminGroup,
} from './admin-management.js';
import {
  authenticateAdmin,
  revokeAdminSessions,
  verifyAdminWriteRequest,
  withAdminMutation,
} from './admin-security.js';

type Params = { group_id: string };
type PageQuery = { q?: string; page?: number; page_size?: number };
const ParamsSchema = Type.Object({ group_id: UuidSchema });
const QuerySchema = Type.Object(
  { ...AdminPageQueryProperties, q: Type.Optional(Type.String({ maxLength: 254 })) },
  { additionalProperties: false },
);
const MemberCount = { accounts: { where: { deletedAt: null } } } as const;

/** 成员数只统计未删除账号，来源字段保持真实缺失值。 */
function groupResponse(group: AdminGroup & { _count: { accounts: number } }) {
  return {
    id: group.id,
    is_default: group.id === DEFAULT_ADMIN_GROUP_ID,
    name: group.name,
    description: group.description,
    sort: group.sort,
    is_enabled: group.isEnabled,
    permissions: group.permissions,
    page_ids: group.pageIds,
    version: group.version,
    member_count: group._count.accounts,
    created_at: group.createdAt.toISOString(),
    updated_at: group.updatedAt.toISOString(),
    created_by: group.createdBy,
    updated_by: group.updatedBy,
  };
}

/** 未删除组名称保持唯一，删除后的名称可重新使用，内部引用不复用。 */
async function assertGroupName(tx: Prisma.TransactionClient, name: string, exceptId?: string): Promise<void> {
  if (
    await tx.adminGroup.findFirst({
      where: { name, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    })
  )
    throw new ApiError(409, 'ADMIN_GROUP_NAME_EXISTS', '此用户组名称已存在，请更换');
}

/** 后台组控制面统一使用超管权限与安全事务，业务组无法获得这些管理能力。 */
export function registerAdminGroupRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const guarded = {
    onRequest: verifyAdminWriteRequest(config),
    preHandler: authenticateAdmin(config, prisma, 'groups:manage'),
  };
  app.get(
    '/api/v1/admin/permission-catalog',
    {
      ...guarded,
      schema: {
        tags: ['admin-groups'],
        response: {
          200: Type.Object({
            permissions: Type.Array(
              Type.Object({ id: Type.String(), label: Type.String(), dependencies: Type.Array(Type.String()) }),
            ),
            pages: Type.Array(
              Type.Object({
                id: Type.String(),
                label: Type.String(),
                path: Type.String(),
                required_permissions: Type.Array(Type.String()),
                assignable: Type.Boolean(),
              }),
            ),
            identities: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
          }),
        },
      },
    },
    async () => ({ permissions: ADMIN_BUSINESS_PERMISSIONS, pages: ADMIN_PAGES, identities: ADMIN_IDENTITIES }),
  );
  app.get(
    '/api/v1/admin/groups',
    {
      ...guarded,
      schema: { tags: ['admin-groups'], querystring: QuerySchema, response: { 200: AdminGroupListSchema } },
    },
    async (request) => {
      try {
        const query = request.query as PageQuery;
        const where: Prisma.AdminGroupWhereInput = {
          deletedAt: null,
          ...(query.q?.trim() ? { name: { contains: query.q.trim(), mode: 'insensitive' } } : {}),
        };
        return await prisma.$transaction(
          async (tx) => {
            const pagination = adminPagination(await tx.adminGroup.count({ where }), query.page, query.page_size);
            const rows = await tx.adminGroup.findMany({
              where,
              orderBy: [{ sort: 'asc' }, { id: 'asc' }],
              skip: pagination.skip,
              take: pagination.page_size,
              include: { _count: { select: MemberCount } },
            });
            return {
              items: rows.map(groupResponse),
              page: pagination.page,
              page_size: pagination.page_size,
              total: pagination.total,
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
    '/api/v1/admin/groups',
    {
      ...guarded,
      schema: {
        tags: ['admin-groups'],
        body: Type.Object(
          {
            name: Type.String({ maxLength: 100 }),
            description: Type.Optional(Type.String({ maxLength: 500 })),
            sort: Type.Optional(Type.Integer({ minimum: -1000000, maximum: 1000000 })),
            is_enabled: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: { 201: AdminGroupSchema },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as { name: string; description?: string; sort?: number; is_enabled?: boolean };
        const name = normalizedAdminText(body.name, 100);
        const created = await withAdminMutation(prisma, request, 'groups:manage', async (tx, auth) => {
          await assertGroupName(tx, name);
          const group = await tx.adminGroup.create({
            data: {
              name,
              description: normalizedAdminText(body.description ?? '', 500, true),
              sort: body.sort ?? 0,
              isEnabled: body.is_enabled ?? true,
              createdBy: auth.username,
              updatedBy: auth.username,
            },
            include: { _count: { select: MemberCount } },
          });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.group.create',
            target: { type: 'admin_group', id: group.id },
            requestId: request.id,
            ip: request.ip,
            metadata: { group_name: group.name },
          });
          return group;
        });
        return await reply.code(201).send(groupResponse(created));
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  app.patch(
    '/api/v1/admin/groups/:group_id',
    {
      ...guarded,
      schema: {
        tags: ['admin-groups'],
        params: ParamsSchema,
        body: Type.Object(
          {
            version: AdminVersionSchema,
            name: Type.Optional(Type.String({ maxLength: 100 })),
            description: Type.Optional(Type.String({ maxLength: 500 })),
            sort: Type.Optional(Type.Integer({ minimum: -1000000, maximum: 1000000 })),
            is_enabled: Type.Optional(Type.Boolean()),
            reason: Type.Optional(AdminReasonSchema),
          },
          { additionalProperties: false },
        ),
        response: { 200: AdminGroupSchema },
      },
    },
    async (request) => {
      try {
        const body = request.body as {
          version: number;
          name?: string;
          description?: string;
          sort?: number;
          is_enabled?: boolean;
          reason?: string;
        };
        if ([body.name, body.description, body.sort, body.is_enabled].every((value) => value === undefined))
          throw new ApiError(400, 'ADMIN_GROUP_UPDATE_EMPTY', '请至少提供一项要修改的内容');
        const reason = body.reason === undefined ? undefined : normalizedAdminText(body.reason, 500);
        const updated = await withAdminMutation(prisma, request, 'groups:manage', async (tx, auth) => {
          const current = await requireAdminGroup(tx, (request.params as Params).group_id);
          assertAdminVersion(current.version, body.version);
          const name = body.name === undefined ? current.name : normalizedAdminText(body.name, 100);
          await assertGroupName(tx, name, current.id);
          if (current.id === DEFAULT_ADMIN_GROUP_ID && body.is_enabled === false)
            throw new ApiError(409, 'ADMIN_DEFAULT_GROUP_PROTECTED', '默认分组不能停用');
          const accessChanged = body.is_enabled !== undefined && body.is_enabled !== current.isEnabled;
          if (accessChanged && !reason) throw new ApiError(400, 'ADMIN_REASON_REQUIRED', '请填写操作原因');
          const group = await tx.adminGroup.update({
            where: { id: current.id },
            data: {
              name,
              ...(body.description === undefined
                ? {}
                : { description: normalizedAdminText(body.description, 500, true) }),
              ...(body.sort === undefined ? {} : { sort: body.sort }),
              ...(body.is_enabled === undefined ? {} : { isEnabled: body.is_enabled }),
              version: { increment: 1 },
              updatedBy: auth.username,
            },
            include: { _count: { select: MemberCount } },
          });
          if (accessChanged)
            await tx.adminSession.updateMany({
              where: {
                revokedAt: null,
                admin: { groupId: current.id, identityType: 'standard_user', deletedAt: null },
              },
              data: { revokedAt: new Date() },
            });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.group.update',
            target: { type: 'admin_group', id: group.id },
            requestId: request.id,
            ip: request.ip,
            metadata: {
              group_name: group.name,
              previous_is_enabled: current.isEnabled,
              is_enabled: group.isEnabled,
              ...(reason ? { reason } : {}),
            },
          });
          return group;
        });
        return groupResponse(updated);
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  app.put(
    '/api/v1/admin/groups/:group_id/permissions',
    {
      ...guarded,
      schema: {
        tags: ['admin-groups'],
        params: ParamsSchema,
        body: Type.Object(
          {
            version: AdminVersionSchema,
            permissions: Type.Array(Type.String(), { maxItems: 20, uniqueItems: true }),
            page_ids: Type.Array(Type.String(), { maxItems: 20, uniqueItems: true }),
            reason: AdminReasonSchema,
          },
          { additionalProperties: false },
        ),
        response: { 200: AdminGroupSchema },
      },
    },
    async (request) => {
      try {
        const body = request.body as { version: number; permissions: string[]; page_ids: string[]; reason: string };
        const reason = normalizedAdminText(body.reason, 500);
        validateGroupAuthorization(body.permissions, body.page_ids);
        const updated = await withAdminMutation(prisma, request, 'groups:manage', async (tx, auth) => {
          const current = await requireAdminGroup(tx, (request.params as Params).group_id);
          assertAdminVersion(current.version, body.version);
          const changed =
            JSON.stringify([...current.permissions].sort()) !== JSON.stringify([...body.permissions].sort()) ||
            JSON.stringify([...current.pageIds].sort()) !== JSON.stringify([...body.page_ids].sort());
          const group = await tx.adminGroup.update({
            where: { id: current.id },
            data: {
              permissions: body.permissions,
              pageIds: body.page_ids,
              version: { increment: 1 },
              updatedBy: auth.username,
            },
            include: { _count: { select: MemberCount } },
          });
          if (changed)
            await tx.adminSession.updateMany({
              where: {
                revokedAt: null,
                admin: { groupId: current.id, identityType: 'standard_user', deletedAt: null },
              },
              data: { revokedAt: new Date() },
            });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.group.permissions',
            target: { type: 'admin_group', id: group.id },
            requestId: request.id,
            ip: request.ip,
            metadata: {
              group_name: group.name,
              permissions: group.permissions,
              page_ids: group.pageIds,
              previous_permissions: current.permissions,
              previous_page_ids: current.pageIds,
              reason,
            },
          });
          return group;
        });
        return groupResponse(updated);
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  app.delete(
    '/api/v1/admin/groups/:group_id',
    {
      ...guarded,
      schema: {
        tags: ['admin-groups'],
        params: ParamsSchema,
        body: Type.Object({ version: AdminVersionSchema, reason: AdminReasonSchema }, { additionalProperties: false }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as { version: number; reason: string };
        const reason = normalizedAdminText(body.reason, 500);
        await withAdminMutation(prisma, request, 'groups:manage', async (tx, auth) => {
          const current = await requireAdminGroup(tx, (request.params as Params).group_id);
          assertAdminVersion(current.version, body.version);
          if (current.id === DEFAULT_ADMIN_GROUP_ID)
            throw new ApiError(409, 'ADMIN_DEFAULT_GROUP_PROTECTED', '默认分组不能删除');
          if (await tx.adminAccount.count({ where: { groupId: current.id, deletedAt: null } }))
            throw new ApiError(409, 'ADMIN_GROUP_NOT_EMPTY', '请先将组内后台用户转移至其他用户组');
          await tx.adminGroup.update({
            where: { id: current.id },
            data: {
              deletedAt: new Date(),
              deletedBy: auth.username,
              isEnabled: false,
              version: { increment: 1 },
              updatedBy: auth.username,
            },
          });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.group.delete',
            target: { type: 'admin_group', id: current.id },
            requestId: request.id,
            ip: request.ip,
            metadata: { group_name: current.name, reason },
          });
        });
        return await reply.code(204).send();
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
  for (const mode of ['members', 'candidates'] as const) {
    app.get(
      `/api/v1/admin/groups/:group_id/${mode}`,
      {
        ...guarded,
        schema: {
          tags: ['admin-groups'],
          params: ParamsSchema,
          querystring: QuerySchema,
          response: { 200: AdminAccountListSchema },
        },
      },
      async (request) => {
        try {
          const query = request.query as PageQuery;
          return await prisma.$transaction(
            async (tx) => {
              const group = await requireAdminGroup(tx, (request.params as Params).group_id);
              const where: Prisma.AdminAccountWhereInput = {
                deletedAt: null,
                groupId: mode === 'members' ? group.id : { not: group.id },
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
              const pagination = adminPagination(await tx.adminAccount.count({ where }), query.page, query.page_size);
              const rows = await tx.adminAccount.findMany({
                where,
                orderBy: [{ username: 'asc' }, { id: 'asc' }],
                skip: pagination.skip,
                take: pagination.page_size,
                include: { group: true },
              });
              return {
                items: rows.map(adminAccountResponse),
                page: pagination.page,
                page_size: pagination.page_size,
                total: pagination.total,
              };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
          );
        } catch (error) {
          return adminManagementFailed(error, request);
        }
      },
    );
  }
  app.post(
    '/api/v1/admin/groups/:group_id/members',
    {
      ...guarded,
      bodyLimit: 65536,
      schema: {
        tags: ['admin-groups'],
        params: ParamsSchema,
        body: Type.Object(
          {
            version: AdminVersionSchema,
            members: Type.Array(
              Type.Object(
                {
                  admin_id: UuidSchema,
                  version: AdminVersionSchema,
                  group_id: UuidSchema,
                  group_version: AdminVersionSchema,
                },
                { additionalProperties: false },
              ),
              { minItems: 1, maxItems: 100 },
            ),
            reason: AdminReasonSchema,
          },
          { additionalProperties: false },
        ),
        response: { 200: Type.Object({ transferred: Type.Integer(), self_session_revoked: Type.Boolean() }) },
      },
    },
    async (request) => {
      try {
        const body = request.body as {
          version: number;
          members: { admin_id: string; version: number; group_id: string; group_version: number }[];
          reason: string;
        };
        const reason = normalizedAdminText(body.reason, 500);
        if (new Set(body.members.map((member) => member.admin_id)).size !== body.members.length)
          throw new ApiError(400, 'ADMIN_MEMBERS_DUPLICATE', '所选后台用户不能重复');
        return await withAdminMutation(prisma, request, 'groups:manage', async (tx, auth) => {
          const target = await requireAdminGroup(tx, (request.params as Params).group_id);
          assertAdminVersion(target.version, body.version);
          const accounts = await tx.adminAccount.findMany({
            where: { id: { in: body.members.map((member) => member.admin_id) }, deletedAt: null },
            include: { group: true },
          });
          // 在执行任何更新之前校验完整批次；任一旧状态不匹配都会回滚整笔事务。
          for (const member of body.members) {
            const account = accounts.find((entry) => entry.id === member.admin_id);
            if (
              !account ||
              account.groupId !== member.group_id ||
              account.groupId === target.id ||
              !account.group ||
              account.group.deletedAt !== null
            )
              throw new ApiError(409, 'ADMIN_VERSION_CONFLICT', '所选账号归属或状态已变化，请刷新核对');
            assertAdminVersion(account.version, member.version);
            assertAdminVersion(account.group.version, member.group_version);
          }
          for (const account of accounts) {
            await tx.adminAccount.update({
              where: { id: account.id },
              data: { groupId: target.id, version: { increment: 1 }, updatedBy: auth.username },
            });
            await revokeAdminSessions(tx, account.id);
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: 'admin.group.member.transfer',
              target: { type: 'admin_account', id: account.id },
              requestId: request.id,
              ip: request.ip,
              metadata: {
                username: account.username,
                previous_group_name: account.group.name,
                group_name: target.name,
                reason,
              },
            });
          }
          return {
            transferred: accounts.length,
            self_session_revoked: accounts.some((account) => account.id === auth.adminId),
          };
        });
      } catch (error) {
        return adminManagementFailed(error, request);
      }
    },
  );
}
