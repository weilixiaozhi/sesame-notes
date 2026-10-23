import { Prisma, type PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import type { ApiConfig } from '../../shared/api-config.js';
import { UuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { execute } from '../../shared/execute.js';
import {
  hashPassword,
  lockAccountSessions,
  maskPhoneE164,
  normalizeE164Phone,
  PhoneInvalidError,
  terminateRefreshTokens,
} from '../auth/index.js';
import { adminOperationReason, AdminReasonSchema } from './admin-pagination.js';
import { authenticateAdmin, withAdminMutation } from './admin-security.js';
import { writeAuditLog } from './audit-log.js';

type UserParams = { user_id: string };
type ChangePhoneBody = { country_code: string; phone: string; current_phone: string; reason: string };
type ResetPasswordBody = { new_password: string; reason: string };

/** 将所有登录入口共用的号码校验错误转换成后台可展示的业务提示。 */
function normalizedPhone(countryCode: string, phone: string): string {
  try {
    return normalizeE164Phone(countryCode, phone);
  } catch (error) {
    if (error instanceof PhoneInvalidError) throw new ApiError(400, 'PHONE_INVALID', '请输入有效的手机号');
    throw error;
  }
}

/** 唯一索引兜底识别并发占用手机号，不将数据库错误或完整号码展示给用户。 */
function phoneAlreadyRegistered(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.some((field) => field === 'phone_e164' || field === 'phoneE164')
  );
}

/** 注册应用用户凭据管理；写入、终止旧会话与审计记录在同一授权事务提交。 */
export function registerAdminUserCredentialRoutes(app: FastifyInstance, prisma: PrismaClient, config: ApiConfig): void {
  app.put(
    '/api/v1/admin/users/:user_id/phone',
    {
      preHandler: [authenticateAdmin(config, prisma, 'users:write')],
      schema: {
        tags: ['admin'],
        params: Type.Object({ user_id: UuidSchema }),
        body: Type.Object(
          {
            country_code: Type.String({ minLength: 2, maxLength: 4 }),
            phone: Type.String({ minLength: 1, maxLength: 32 }),
            current_phone: Type.String({ pattern: '^\\+[1-9]\\d{1,14}$' }),
            reason: AdminReasonSchema,
          },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) =>
      execute(request, '更换用户手机号', async () => {
        const { user_id: userId } = request.params as UserParams;
        const body = request.body as ChangePhoneBody;
        const reason = adminOperationReason(body);
        const phoneE164 = normalizedPhone(body.country_code, body.phone);
        try {
          await withAdminMutation(prisma, request, 'users:write', async (tx, auth) => {
            await lockAccountSessions(tx, userId);
            const user = await tx.user.findUnique({ where: { id: userId }, select: { phoneE164: true } });
            if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
            // 管理员确认的原号码必须仍然有效，避免覆盖其他管理员刚完成的换绑。
            if (user.phoneE164 !== body.current_phone)
              throw new ApiError(409, 'USER_PHONE_CHANGED', '此用户的手机号已更新，请刷新资料后重试');
            if (user.phoneE164 === phoneE164) throw new ApiError(409, 'PHONE_UNCHANGED', '新手机号与当前手机号相同');
            // 与注册入口按同一个号码串行，唯一索引仍负责最终的并发冲突校验。
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${phoneE164}, 0))`;
            const occupied = await tx.user.findUnique({ where: { phoneE164 }, select: { id: true } });
            if (occupied) throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', '该手机号已被其他用户使用');
            await tx.user.update({ where: { id: userId }, data: { phoneE164, credentialVersion: { increment: 1 } } });
            await terminateRefreshTokens(tx, userId);
            await writeAuditLog(tx, {
              actor: `admin:${auth.adminId}`,
              action: 'user.phone.change',
              target: { type: 'user', id: userId },
              requestId: request.id,
              ip: request.ip,
              metadata: {
                reason,
                previous_number: maskPhoneE164(user.phoneE164),
                current_number: maskPhoneE164(phoneE164),
              },
            });
          });
        } catch (error) {
          if (phoneAlreadyRegistered(error))
            throw new ApiError(409, 'PHONE_ALREADY_REGISTERED', '该手机号已被其他用户使用');
          throw error;
        }
        // 仅在事务完成后通知实时连接重验，回滚不会中断用户的现有连接。
        request.realtimeRevalidationUserIds.add(userId);
        return reply.status(204).send();
      }),
  );

  app.post(
    '/api/v1/admin/users/:user_id/reset-password',
    {
      preHandler: [authenticateAdmin(config, prisma, 'users:write')],
      schema: {
        tags: ['admin'],
        params: Type.Object({ user_id: UuidSchema }),
        body: Type.Object(
          { new_password: Type.String({ minLength: 1, maxLength: 128 }), reason: AdminReasonSchema },
          { additionalProperties: false },
        ),
        response: { 204: Type.Null() },
      },
    },
    async (request, reply) =>
      execute(request, '重置用户密码', async () => {
        const { user_id: userId } = request.params as UserParams;
        const body = request.body as ResetPasswordBody;
        const reason = adminOperationReason(body);
        // 普通用户密码保留首尾空格，并在持锁前计算散列，缩短其他登录请求的等待。
        const passwordHash = await hashPassword(body.new_password);
        await withAdminMutation(prisma, request, 'users:write', async (tx, auth) => {
          await lockAccountSessions(tx, userId);
          const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
          if (!user) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在');
          await tx.user.update({ where: { id: userId }, data: { passwordHash, credentialVersion: { increment: 1 } } });
          await terminateRefreshTokens(tx, userId);
          // 审计只保存操作原因，不传入明文密码、散列或其他凭据材料。
          await writeAuditLog(tx, {
            actor: `admin:${auth.adminId}`,
            action: 'user.password.reset',
            target: { type: 'user', id: userId },
            requestId: request.id,
            ip: request.ip,
            metadata: { reason },
          });
        });
        request.realtimeRevalidationUserIds.add(userId);
        return reply.status(204).send();
      }),
  );
}
