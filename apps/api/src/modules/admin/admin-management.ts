import { Prisma, type AdminGroup } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../../shared/errors.js';
import { DEFAULT_ADMIN_GROUP_ID, type AdminAccountWithGroup } from './admin-policy.js';

/** 只输出后台用户页面所需字段，不序列化密码和会话。 */
export function adminAccountResponse(account: AdminAccountWithGroup) {
  return {
    id: account.id,
    username: account.username,
    email: account.email,
    phone: account.phone,
    display_name: account.displayName,
    identity_type: account.identityType,
    group_id: account.groupId,
    group: {
      id: account.group.id,
      name: account.group.name,
      is_enabled: account.group.isEnabled,
      version: account.group.version,
      is_default: account.group.id === DEFAULT_ADMIN_GROUP_ID,
    },
    is_enabled: account.isEnabled,
    version: account.version,
    last_login_at: account.lastLoginAt?.toISOString() ?? null,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
    created_by: account.createdBy,
    updated_by: account.updatedBy,
  };
}

/** 对空白名称和超长说明给出可执行的输入错误。 */
export function normalizedAdminText(value: string, max: number, allowEmpty = false): string {
  const result = value.trim();
  if ((!allowEmpty && !result) || !result.isWellFormed() || [...result].length > max)
    throw new ApiError(400, 'ADMIN_INPUT_INVALID', `请输入${allowEmpty ? '不超过' : '1–'}${max}个字符`);
  return result;
}

/** 在安全事务锁内验证页面读取的对象版本，防止覆盖其他操作者的修改。 */
export function assertAdminVersion(current: number, expected: number): void {
  if (current !== expected) throw new ApiError(409, 'ADMIN_VERSION_CONFLICT', '记录已变化，请刷新后重新核对');
}

/** 所有组关联写入共用校验，停用组可归属，删除组不可归属。 */
export async function requireAdminGroup(tx: Prisma.TransactionClient, groupId: string): Promise<AdminGroup> {
  const group = await tx.adminGroup.findUnique({ where: { id: groupId } });
  if (!group || group.deletedAt !== null)
    throw new ApiError(404, 'ADMIN_GROUP_NOT_FOUND', '用户组不存在或已删除，请重新选择');
  return group;
}

/** 有效超管只取决于身份、账号启用及删除状态，与组配置无关。 */
export async function protectLastSuperAdmin(
  tx: Prisma.TransactionClient,
  current: AdminAccountWithGroup,
  next: { identityType: string; isEnabled: boolean; deletedAt: Date | null },
): Promise<void> {
  if (
    current.identityType !== 'super_admin' ||
    !current.isEnabled ||
    current.deletedAt !== null ||
    (next.identityType === 'super_admin' && next.isEnabled && next.deletedAt === null)
  )
    return;
  const remaining = await tx.adminAccount.count({
    where: { id: { not: current.id }, identityType: 'super_admin', isEnabled: true, deletedAt: null },
  });
  if (remaining === 0) throw new ApiError(409, 'LAST_SUPER_ADMIN', '请先准备另一位已启用的超级管理员');
}

/** 将服务故障保留在结构化日志中，并向页面返回友好说明。 */
export function adminManagementFailed(error: unknown, request: FastifyRequest): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = error.meta?.target;
    const fields = Array.isArray(target) ? target : [target];
    if (fields.includes('email')) throw new ApiError(409, 'ADMIN_EMAIL_EXISTS', '此邮箱已被其他后台用户使用，请更换');
    if (fields.includes('phone')) throw new ApiError(409, 'ADMIN_PHONE_EXISTS', '此手机号已被其他后台用户使用，请更换');
    throw new ApiError(409, 'ADMIN_NAME_EXISTS', '名称或登录账号已存在，请更换');
  }
  request.log.error({ err: error, request_id: request.id }, '后台用户或用户组操作失败');
  throw new ApiError(503, 'ADMIN_AUTH_UNAVAILABLE', '后台管理服务暂时不可用，请稍后重试');
}

/** 在计数结果范围内收敛页码，空集合固定保留第一页。 */
export function adminPagination(total: number, page = 1, pageSize = 10) {
  const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  return { page: currentPage, page_size: pageSize, skip: (currentPage - 1) * pageSize, total };
}
