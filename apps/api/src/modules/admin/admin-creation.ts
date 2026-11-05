import type { Prisma, PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { AnyUuidSchema } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';
import { hashAdminPassword, verifyAdminPassword, withAdminMutation } from './admin-security.js';

export const AdminCreationHeadersSchema = Type.Object(
  { 'idempotency-key': Type.Optional(AnyUuidSchema) },
  { additionalProperties: true },
);

/** 对已通过接口校验的 JSON 按对象键排序，消除属性顺序造成的请求指纹差异。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/**
 * 在当前授权事务内保存一次新增意图及其白名单响应。
 *
 * 回执与实体、审计同事务提交；管理员安全锁串行化同键并发。回执长期保留，
 * 使迟到重试也不能重新创建实体。请求指纹使用已有的随机盐、固定成本管理员派生算法，
 * 不依赖会轮换的 JWT 密钥，也不降低包含密码载荷的离线猜测成本。
 */
export async function withAdminCreation<T>(
  prisma: PrismaClient,
  request: FastifyRequest,
  permission: Parameters<typeof withAdminMutation>[2],
  create: Parameters<typeof withAdminMutation<T>>[3],
): Promise<T> {
  try {
    return await withAdminMutation(prisma, request, permission, async (tx, auth) => {
      const header = request.headers['idempotency-key'];
      // 旧管理端可继续单次新增；支持重试恢复的调用者必须为编辑过程保留同一 UUID。
      if (header === undefined) return await create(tx, auth);
      if (typeof header !== 'string' || !Value.Check(AnyUuidSchema, header)) {
        throw new ApiError(400, 'ADMIN_CREATION_KEY_INVALID', '新增请求标识无效，请关闭表单后重新打开');
      }
      const key = header.toLowerCase();
      const fingerprint = canonicalJson({
        method: request.method,
        route: request.routeOptions.url,
        params: request.params ?? null,
        body: request.body ?? null,
      });
      const existing = await tx.adminCreationReceipt.findUnique({
        where: { adminId_key: { adminId: auth.adminId, key } },
      });
      if (existing) {
        if (!(await verifyAdminPassword(fingerprint, existing.requestHash))) {
          throw new ApiError(409, 'ADMIN_CREATION_KEY_REUSED', '此新增请求对应的内容已变化，请先恢复并核对原请求结果');
        }
        return existing.response as T;
      }
      const requestHash = await hashAdminPassword(fingerprint);
      const result = await create(tx, auth);
      // 调用者必须先转换为公开响应，不能把 Prisma 行、密码散列或内部权限上下文保存到回执。
      const response = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonObject;
      if (response === null || typeof response !== 'object' || Array.isArray(response)) {
        throw new Error('管理员新增回执必须是已序列化的响应对象');
      }
      await tx.adminCreationReceipt.create({
        data: { adminId: auth.adminId, key, requestHash, response },
      });
      return response as T;
    });
  } catch (error) {
    if (!(error instanceof ApiError)) {
      request.log.error({ err: error, request_id: request.id }, '管理员新增事务未能确认完成');
    }
    throw error;
  }
}
