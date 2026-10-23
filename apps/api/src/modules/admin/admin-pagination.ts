import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';

import { ApiError } from '../../shared/errors.js';

export const AdminPageQuery = {
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  page_size: Type.Optional(Type.Union([Type.Literal(10), Type.Literal(20), Type.Literal(50), Type.Literal(100)])),
};

export type AdminPageInput = { page?: number; page_size?: number };

/** 页码分页入口显式校验游标参数，避免 Schema 清理额外字段后改变请求的读取位置。 */
export async function validateAdminPaginationQuery(request: FastifyRequest): Promise<void> {
  try {
    const query = request.query as Record<string, unknown>;
    if (Object.hasOwn(query, 'limit') || Object.hasOwn(query, 'cursor')) {
      throw new ApiError(400, 'ADMIN_PAGINATION_INVALID', '请使用页码分页，并刷新页面后重新查询');
    }
  } catch (error) {
    request.log.warn({ err: error }, '后台分页查询校验失败');
    throw error;
  }
}

/** 按同一事务内取得的总数修正越界页码，空列表仍返回第一页。 */
export function adminPage(query: AdminPageInput, total: number) {
  const pageSize = query.page_size ?? 10;
  const page = Math.min(query.page ?? 1, Math.max(1, Math.ceil(total / pageSize)));
  return { page, page_size: pageSize, total, skip: (page - 1) * pageSize };
}

export const AdminReasonSchema = Type.String({ minLength: 1, maxLength: 500 });

/** 写操作原因必须为有界非空文本，空白与无效 Unicode 文本不能进入审计记录。 */
export function adminOperationReason(body: unknown): string {
  const value = body && typeof body === 'object' && 'reason' in body ? body.reason : undefined;
  if (typeof value !== 'string' || !value.isWellFormed() || value.trim().length === 0 || [...value].length > 500) {
    throw new ApiError(400, 'ADMIN_REASON_INVALID', '请填写 1–500 个字符的操作原因');
  }
  return value.trim();
}
