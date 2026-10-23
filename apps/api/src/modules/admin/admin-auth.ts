import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';

import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { createMultiKeyRateLimit } from '../../shared/rate-limit.js';
import { writeAuditLog } from './audit-log.js';
import { AdminSessionSchema } from './admin-schemas.js';
import { normalizeAdminLoginIdentifier } from './admin-identifiers.js';
import {
  ADMIN_FAILED_LOGIN_LIMIT,
  ADMIN_LOCKOUT_MS,
  adminIdentity,
  adminSessionResponse,
  adminLoginIdentifierDigest,
  authenticateAdmin,
  clearAdminSessionCookie,
  createAdminSessionToken,
  dummyAdminPasswordHash,
  hashAdminPassword,
  hashAdminSessionToken,
  lockAdminSecurity,
  readAdminSessionToken,
  requireAdminAuth,
  revokeAdminSessions,
  setAdminNoStore,
  setAdminSessionCookie,
  validateAdminPassword,
  verifyAdminPassword,
  verifyAdminWriteRequest,
  withAdminMutation,
} from './admin-security.js';

type LoginBody = { username: string; password: string };
type PasswordBody = { old_password: string; new_password: string };

/** 保留服务异常详细日志，并向客户端返回可重试的友好错误。 */
function authUnavailable(error: unknown, request: FastifyRequest): never {
  if (error instanceof ApiError) throw error;
  // 后台请求日志统一使用脱敏异常序列化器，保留诊断信息并排除数据库参数。
  request.log.error({ err: error, request_id: request.id }, '后台认证操作暂时不可用');
  throw new ApiError(503, 'ADMIN_AUTH_UNAVAILABLE', '后台登录验证暂时不可用，请稍后重试');
}

/** 三种登录标识只查询 AdminAccount，并建立独立的 AdminSession。 */
export function registerAdminAuthRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  const rateLimited = createMultiKeyRateLimit(config.authRateLimitMax, 60_000, (request) => {
    const body = request.body as { username?: unknown } | undefined;
    const identifier =
      typeof body?.username === 'string' ? normalizeAdminLoginIdentifier(body.username) : request.adminAuth?.username;
    return identifier ? adminLoginIdentifierDigest(JSON.stringify(identifier)) : null;
  });
  const verifyWrite = verifyAdminWriteRequest(config);

  app.post(
    '/api/v1/admin/auth/login',
    {
      bodyLimit: 4096,
      onRequest: verifyAdminWriteRequest(config, { allowCliLogin: true }),
      preHandler: rateLimited,
      schema: {
        tags: ['admin-auth'],
        body: Type.Object(
          {
            username: Type.String({ minLength: 1, maxLength: 254 }),
            password: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        response: { 200: AdminSessionSchema },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as LoginBody;
        const identifier = normalizeAdminLoginIdentifier(body.username);
        const identifierHash = adminLoginIdentifierDigest(JSON.stringify(identifier ?? body.username));
        const snapshot = identifier ? await prisma.adminAccount.findUnique({ where: identifier }) : null;
        // 密码计算在锁外；不存在、禁用和锁定账号也完成相同成本的校验。
        const passwordOk = await verifyAdminPassword(body.password, snapshot?.passwordHash ?? dummyAdminPasswordHash());
        const token = createAdminSessionToken();
        const previousToken = readAdminSessionToken(request);
        const session = await prisma.$transaction(
          async (tx) => {
            await lockAdminSecurity(tx);
            // 再用同一标识查找，防止锁外验密期间联系方式被解绑或移交。
            const current = identifier ? await tx.adminAccount.findUnique({ where: identifier }) : null;
            const now = new Date();
            const locked =
              current?.lockedUntil !== null && current?.lockedUntil !== undefined && current.lockedUntil > now;
            const accepted =
              current !== null &&
              snapshot !== null &&
              current.id === snapshot.id &&
              current.passwordHash === snapshot.passwordHash &&
              current.isEnabled &&
              current.deletedAt === null &&
              !locked &&
              passwordOk;
            if (!accepted || !current) {
              if (current && !locked) {
                const attempts =
                  current.lockedUntil !== null && current.lockedUntil <= now
                    ? 1
                    : Math.min(current.failedLoginAttempts + 1, ADMIN_FAILED_LOGIN_LIMIT);
                await tx.adminAccount.update({
                  where: { id: current.id },
                  data: {
                    failedLoginAttempts: attempts,
                    lockedUntil:
                      attempts >= ADMIN_FAILED_LOGIN_LIMIT ? new Date(now.getTime() + ADMIN_LOCKOUT_MS) : null,
                  },
                });
              }
              await writeAuditLog(tx, {
                actor: current ? `admin:${current.id}` : 'anonymous',
                action: 'admin.login.failed',
                target: { type: 'admin_login', id: identifierHash },
                requestId: request.id,
                ip: request.ip,
              });
              // 在事务外抛认证错误，保证失败计数、锁定和审计真正提交。
              return null;
            }
            await tx.adminAccount.update({
              where: { id: current.id },
              data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
            });
            if (previousToken) {
              await tx.adminSession.updateMany({
                where: { tokenHash: hashAdminSessionToken(previousToken), revokedAt: null },
                data: { revokedAt: now },
              });
            }
            const created = await tx.adminSession.create({
              data: {
                adminId: current.id,
                tokenHash: hashAdminSessionToken(token),
                createdAt: now,
                lastSeenAt: now,
                expiresAt: new Date(now.getTime() + (config.adminSessionTtlSeconds ?? 28_800) * 1000),
                ip: request.ip.slice(0, 64),
                userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
              },
              include: { admin: { include: { group: true } } },
            });
            await writeAuditLog(tx, {
              actor: `admin:${current.id}`,
              action: 'admin.login',
              target: { type: 'admin_account', id: current.id },
              requestId: request.id,
              ip: request.ip,
            });
            return created;
          },
          { maxWait: 10_000, timeout: 10_000 },
        );
        if (!session) throw new ApiError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
        setAdminSessionCookie(reply, token, session.expiresAt);
        return adminSessionResponse(session, config);
      } catch (error) {
        return authUnavailable(error, request);
      }
    },
  );

  app.get(
    '/api/v1/admin/auth/me',
    {
      onRequest: async (_request, reply) => setAdminNoStore(reply),
      preHandler: authenticateAdmin(config, prisma, undefined),
      schema: { tags: ['admin-auth'], response: { 200: AdminSessionSchema } },
    },
    async (request) => {
      const auth = requireAdminAuth(request);
      return { admin: adminIdentity(auth), expires_at: auth.expiresAt.toISOString() };
    },
  );

  app.post(
    '/api/v1/admin/auth/password',
    {
      bodyLimit: 4096,
      onRequest: verifyWrite,
      preHandler: [authenticateAdmin(config, prisma, 'auth:password'), rateLimited],
      schema: {
        tags: ['admin-auth'],
        body: Type.Object(
          {
            old_password: Type.String({ minLength: 1 }),
            new_password: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) => {
      try {
        const auth = requireAdminAuth(request);
        const body = request.body as PasswordBody;
        validateAdminPassword(body.new_password);
        const snapshot = await prisma.adminAccount.findUnique({ where: { id: auth.adminId } });
        const passwordOk = await verifyAdminPassword(
          body.old_password,
          snapshot?.passwordHash ?? dummyAdminPasswordHash(),
        );
        if (!snapshot || !passwordOk) {
          throw new ApiError(400, 'ADMIN_PASSWORD_MISMATCH', '原密码不正确');
        }
        const passwordHash = await hashAdminPassword(body.new_password);
        await withAdminMutation(prisma, request, 'auth:password', async (tx, currentAuth) => {
          const current = await tx.adminAccount.findUnique({ where: { id: currentAuth.adminId } });
          if (!current || current.passwordHash !== snapshot.passwordHash) {
            throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '后台账号已变更，请重新登录');
          }
          await tx.adminAccount.update({
            where: { id: current.id },
            data: {
              passwordHash,
              failedLoginAttempts: 0,
              lockedUntil: null,
              version: { increment: 1 },
              updatedBy: currentAuth.username,
            },
          });
          await revokeAdminSessions(tx, current.id);
          await writeAuditLog(tx, {
            actor: `admin:${currentAuth.adminId}`,
            action: 'admin.password.change',
            target: { type: 'admin_account', id: current.id },
            requestId: request.id,
            ip: request.ip,
          });
        });
        clearAdminSessionCookie(reply);
        return await reply.status(204).send();
      } catch (error) {
        return authUnavailable(error, request);
      }
    },
  );

  app.post(
    '/api/v1/admin/auth/logout',
    {
      onRequest: verifyWrite,
      preHandler: authenticateAdmin(config, prisma, 'auth:logout'),
      schema: { tags: ['admin-auth'], response: { 204: Type.Null() } },
    },
    async (request, reply) => {
      try {
        await withAdminMutation(prisma, request, 'auth:logout', async (tx, auth) => {
          await tx.adminSession.update({ where: { id: auth.sessionId }, data: { revokedAt: new Date() } });
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'admin.logout',
            target: { type: 'admin_account', id: auth.adminId },
            requestId: request.id,
            ip: request.ip,
          });
        });
        clearAdminSessionCookie(reply);
        return await reply.status(204).send();
      } catch (error) {
        return authUnavailable(error, request);
      }
    },
  );
}
