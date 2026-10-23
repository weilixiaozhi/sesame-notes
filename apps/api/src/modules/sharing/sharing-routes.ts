import { withSyncTransaction } from '../../shared/sync-transaction.js';
import { createHash, randomBytes } from 'node:crypto';

import type { LedgerMemberRole, PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { createRateLimit } from '../../shared/rate-limit.js';
import { authenticate, currentSessionAccess, requireAuth, requireScopes } from '../auth/index.js';
import { createChange } from '../sync-events/index.js';
import { getLedgerReadAccess, getLedgerWriteAccess, ledgerPayload, registeredMemberId } from '../accounting/index.js';
import { ApiError } from '../../shared/errors.js';
import { executor } from '../../shared/execute.js';
import { AnyUuidSchema, UuidSchema } from '../../shared/contracts/scalars.js';
import { CategorySchema } from '../../shared/contracts/accounting.js';
import { categoryState } from '../../shared/category-version.js';
import { registerMemberStatsRoutes } from './member-stats.js';
import { appendMemberChange, leaveLedgerMember, removeLedgerMember } from './member-service.js';

/** 共享功能共用的 500 失败码，捕获与日志由公共执行器负责。 */
const executeSharing = executor('SHARING_OPERATION_FAILED');

// 成员协作角色只有 owner/editor：邀请即编辑
const RoleSchema = Type.Literal('editor');
const MemberRoleSchema = Type.Union([Type.Literal('owner'), Type.Literal('editor')]);
const MemberStatusSchema = Type.Union([Type.Literal('ACTIVE'), Type.Literal('LEFT'), Type.Literal('REMOVED')]);
const MemberSchema = Type.Object({
  user_id: UuidSchema,
  // canonical 成员 id（UUID v5 派生）、生命周期状态与绑定账号：
  // 本视图只返回已绑定账号的 ACTIVE 成员，三者恒有值，不必按可空处理
  member_id: AnyUuidSchema,
  status: MemberStatusSchema,
  linked_account_id: UuidSchema,
  // 共享协议只暴露芝麻号作为公开编号，绝不返回 account/手机号/性别
  sesame_number: Type.Union([Type.String(), Type.Null()]),
  display_name: Type.Union([Type.String(), Type.Null()]),
  avatar_url: Type.Union([Type.String(), Type.Null()]),
  avatar_version: Type.Integer({ minimum: 0 }),
  role: MemberRoleSchema,
  joined_at: Type.String({ format: 'date-time' }),
});
const InviteSchema = Type.Object({
  id: AnyUuidSchema,
  role: RoleSchema,
  expires_at: Type.String({ format: 'date-time' }),
});
const InvitePreviewSchema = Type.Object({
  ledger_id: AnyUuidSchema,
  ledger_name: Type.String(),
  role: RoleSchema,
  expires_at: Type.String({ format: 'date-time' }),
});
const InviteAcceptSchema = Type.Object({ ledger_id: AnyUuidSchema, ledger_name: Type.String(), role: RoleSchema });

/** 注册共享账本成员与一次性邀请码接口。 */
export function registerSharingRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  // 共享/账本路由按资源校验最小 scope：读 sync:read，写 sync:write
  const secured = { preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write')] };
  const authRateLimited = createRateLimit(config.authRateLimitMax, 60_000);

  registerMemberStatsRoutes(app, prisma, config);

  app.get(
    '/api/v1/ledgers/:ledger_id/shared-resources',
    {
      ...secured,
      schema: {
        tags: ['sharing'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        response: { 200: Type.Object({ owner_user_id: UuidSchema, categories: Type.Array(Type.Ref(CategorySchema)) }) },
      },
    },
    async (request) =>
      executeSharing(request, '读取共享资源', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const { ledger } = await getLedgerReadAccess(prisma, auth.userId, ledgerId, 'editor');
        const categories = await prisma.category.findMany({
          where: { ownerId: ledger.ownerId, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        });
        return {
          owner_user_id: ledger.ownerId,
          // 共享目录与同步目录使用同一权威投影，保留分类版本标识和删除状态字段。
          categories: categories.map(categoryState),
        };
      }),
  );

  app.get(
    '/api/v1/ledgers/:ledger_id/members',
    {
      ...secured,
      schema: {
        tags: ['sharing'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        response: { 200: Type.Array(MemberSchema) },
      },
    },
    async (request) =>
      executeSharing(request, '读取账本成员', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        await getLedgerReadAccess(prisma, auth.userId, ledgerId, 'editor');
        // Owner 与受邀成员都是一等成员行（owner 角色来自成员表）。
        // 本视图是现任成员视图：只返回已绑定账号且 ACTIVE 的成员，响应 status 恒为 ACTIVE。
        // LEFT/REMOVED 保留历史身份但不属于现任成员（其统计见 member-stats），
        // PLACEHOLDER 无绑定账号，由同步成员快照下发，两者都不在本视图返回。
        const members = await prisma.ledgerMember.findMany({
          where: { ledgerId, linkedAccountId: { not: null }, status: 'ACTIVE' },
          include: { linkedAccount: { include: { profile: true } } },
          orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        });
        return members.map(mapMember);
      }),
  );

  app.delete(
    '/api/v1/ledgers/:ledger_id/members/:member_id',
    {
      ...secured,
      schema: {
        tags: ['sharing'],
        params: Type.Object({ ledger_id: AnyUuidSchema, member_id: AnyUuidSchema }),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) =>
      executeSharing(request, '移除账本成员', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId, member_id: memberId } = request.params as {
          ledger_id: string;
          member_id: string;
        };
        await removeLedgerMember(prisma, ledgerId, memberId, auth);
        await reply.status(204).send();
      }),
  );

  app.post(
    '/api/v1/ledgers/:ledger_id/leave',
    {
      ...secured,
      schema: { tags: ['sharing'], params: Type.Object({ ledger_id: AnyUuidSchema }), response: { 204: Type.Null() } },
    },
    async (request, reply) =>
      executeSharing(request, '退出共享账本', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        await leaveLedgerMember(prisma, ledgerId, auth);
        await reply.status(204).send();
      }),
  );

  app.post(
    '/api/v1/ledgers/:ledger_id/invites',
    {
      ...secured,
      schema: {
        tags: ['sharing'],
        params: Type.Object({ ledger_id: AnyUuidSchema }),
        body: Type.Object({
          expires_in_hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })),
        }),
        response: { 201: Type.Intersect([InviteSchema, Type.Object({ code: Type.String() })]) },
      },
    },
    async (request, reply) =>
      executeSharing(request, '创建账本邀请', async () => {
        const auth = requireAuth(request);
        const { ledger_id: ledgerId } = request.params as { ledger_id: string };
        const body = request.body as { expires_in_hours?: number };
        const code = createInviteCode();
        const invite = await prisma.$transaction(async (tx) => {
          // 同一账本串行替换邀请码；失效旧码和创建新码原子提交，失败保留原码。
          await getLedgerWriteAccess(tx, auth.userId, ledgerId, 'owner');
          // 账本锁等待结束后复核会话，撤销设备、停用账号或更换凭据均使排队请求失效。
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          await tx.ledgerInvite.updateMany({
            where: { ledgerId, usedAt: null, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return tx.ledgerInvite.create({
            data: {
              ledgerId,
              createdById: auth.userId,
              codeHash: hashInviteCode(code),
              codePrefix: code.slice(0, 8),
              role: 'editor',
              expiresAt: new Date(Date.now() + (body.expires_in_hours ?? 24) * 3_600_000),
            },
          });
        });
        await reply
          .status(201)
          .send({ id: invite.id, role: invite.role, expires_at: invite.expiresAt.toISOString(), code });
      }),
  );

  app.get(
    '/api/v1/invites/:code',
    {
      schema: {
        tags: ['sharing'],
        params: Type.Object({ code: Type.String({ minLength: 8, maxLength: 32 }) }),
        response: { 200: InvitePreviewSchema },
      },
    },
    async (request) =>
      executeSharing(request, '预览账本邀请', async () => {
        const { code } = request.params as { code: string };
        const invite = await prisma.ledgerInvite.findUnique({
          where: { codeHash: hashInviteCode(code) },
          include: { ledger: true },
        });
        validateInvite(invite);
        return {
          ledger_id: invite!.ledgerId,
          ledger_name: invite!.ledger.name,
          role: invite!.role,
          expires_at: invite!.expiresAt.toISOString(),
        };
      }),
  );

  app.post(
    '/api/v1/invites/:code/accept',
    {
      // 认证、scope 与限流依次执行：先验证身份，再按资源校验，最后按 IP 计数
      preHandler: [authenticate(config, prisma), requireScopes('sync:read', 'sync:write'), authRateLimited],
      schema: {
        tags: ['sharing'],
        params: Type.Object({ code: Type.String({ minLength: 8, maxLength: 32 }) }),
        response: { 200: InviteAcceptSchema },
      },
    },
    async (request) =>
      executeSharing(request, '接受账本邀请', async () => {
        const auth = requireAuth(request);
        const { code } = request.params as { code: string };
        const result = await withSyncTransaction(prisma, async (tx) => {
          // 预读只定位锁资源；授权使用取得账本与邀请行锁后的完整状态。
          const target = await tx.ledgerInvite.findUnique({
            where: { codeHash: hashInviteCode(code) },
            select: { id: true, ledgerId: true },
          });
          if (!target) throw new ApiError(404, 'INVITE_NOT_FOUND', '邀请不存在或已失效');
          // 邀请写入统一按账本再邀请的顺序排队，避免与账本删除或邀请码替换反向持锁。
          await tx.$queryRaw`SELECT "id" FROM "ledgers" WHERE "id" = ${target.ledgerId}::uuid FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "ledger_invites" WHERE "id" = ${target.id}::uuid FOR UPDATE`;
          const invite = await tx.ledgerInvite.findUnique({
            where: { codeHash: hashInviteCode(code) },
            include: { ledger: true },
          });
          validateInvite(invite);
          if (invite!.ledger.ownerId === auth.userId)
            throw new ApiError(409, 'ALREADY_LEDGER_OWNER', '你已经是该账本的 Owner');
          if (!(await currentSessionAccess(tx, auth))) throw new ApiError(401, 'UNAUTHORIZED', '登录状态已失效');
          const now = new Date();
          const claimed = await tx.ledgerInvite.updateMany({
            where: {
              id: invite!.id,
              usedAt: null,
              revokedAt: null,
              expiresAt: { gt: now },
              ledger: { deletedAt: null },
            },
            data: { usedAt: now, usedById: auth.userId },
          });
          if (!claimed.count) throw new ApiError(404, 'INVITE_NOT_FOUND', '邀请不存在或已失效');
          // 接受邀请：按 golden 派生公式 upsert REGISTERED 成员行，display_name 从 User 资料快照
          const invitedUser = await tx.user.findUnique({
            where: { id: auth.userId },
            select: { profile: { select: { displayName: true } } },
          });
          const member = await tx.ledgerMember.upsert({
            where: {
              ledgerId_linkedAccountId: { ledgerId: invite!.ledgerId, linkedAccountId: auth.userId },
            },
            create: {
              id: registeredMemberId(invite!.ledgerId, auth.userId),
              ledgerId: invite!.ledgerId,
              // 邀请与所有者成员使用同一长度口径，避免截断昵称中的代理对。
              displayName: Array.from(invitedUser?.profile?.displayName ?? '成员')
                .slice(0, 64)
                .join(''),
              memberType: 'REGISTERED',
              linkedAccountId: auth.userId,
              role: invite!.role as LedgerMemberRole,
              status: 'ACTIVE',
              updatedAt: now,
              updatedByDeviceId: auth.deviceId,
            },
            update: {
              role: invite!.role as LedgerMemberRole,
              status: 'ACTIVE',
              updatedAt: now,
              updatedByDeviceId: auth.deviceId,
            },
          });
          // 受邀设备可能已越过最初的账本事件，因此先发用户域发现事件，再由
          // 客户端 full 补齐旧游标前的历史；用户域可避免其他成员重复整本同步。
          await createChange(
            tx,
            auth,
            null,
            'ledger',
            invite!.ledgerId,
            'upsert',
            { ...ledgerPayload(invite!.ledger), requires_full: true },
            now,
            auth.userId,
          );
          await appendMemberChange(tx, auth, member);
          return invite!;
        });
        return { ledger_id: result.ledgerId, ledger_name: result.ledger.name, role: result.role };
      }),
  );
}

/** 生成便于手工输入但仍具有足够熵的邀请码。 */
function createInviteCode(): string {
  try {
    return randomBytes(12).toString('base64url').toUpperCase();
  } catch (error) {
    throw new Error('邀请码生成失败', { cause: error });
  }
}

/** 数据库只保存邀请码哈希，泄漏备份时不会暴露有效邀请。 */
function hashInviteCode(code: string): string {
  try {
    return createHash('sha256').update(code.trim().toUpperCase(), 'utf8').digest('hex');
  } catch (error) {
    throw new Error('邀请码哈希失败', { cause: error });
  }
}

/** 验证邀请所属账本存活，且邀请存在、未使用、未撤销、未过期。 */
function validateInvite(
  invite: {
    usedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
    ledger: { deletedAt: Date | null };
  } | null,
): void {
  // 已删除账本的邀请与已使用、已作废或已过期邀请统一隐藏为不存在。
  if (!invite || invite.ledger.deletedAt || invite.usedAt || invite.revokedAt || invite.expiresAt <= new Date())
    throw new ApiError(404, 'INVITE_NOT_FOUND', '邀请不存在或已失效');
}

/**
 * 将成员行 + 绑定账号资料映射为成员响应；Owner 与普通成员共用这一出口。
 *
 * 双标识语义：user_id 是账号域标识（仅 REGISTERED 成员有绑定账号），
 * member_id 是账本内 canonical 成员标识；同时输出生命周期 status
 * 与绑定账号 linked_account_id，展示名与头像取绑定账号的资料。
 */
function mapMember(member: {
  id: string;
  status: string;
  linkedAccountId: string | null;
  displayName: string;
  role: string;
  joinedAt: Date;
  linkedAccount: {
    id: string;
    sesameNumber: string;
    profile: { displayName: string | null; avatarFileId: string | null; avatarVersion: number } | null;
  } | null;
}) {
  // 查询已过滤 linkedAccountId 非空，绑定账号必然存在
  const user = member.linkedAccount!;
  return {
    user_id: user.id,
    member_id: member.id,
    status: member.status,
    linked_account_id: member.linkedAccountId,
    sesame_number: user.sesameNumber,
    display_name: user.profile?.displayName ?? null,
    avatar_url: user.profile?.avatarFileId ? `/api/v1/profile/avatar/${user.id}?v=${user.profile.avatarVersion}` : null,
    avatar_version: user.profile?.avatarVersion ?? 0,
    role: member.role,
    joined_at: member.joinedAt.toISOString(),
  };
}
