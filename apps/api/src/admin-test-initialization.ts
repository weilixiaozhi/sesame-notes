import type { PrismaClient } from '@prisma/client';
import { DEFAULT_ADMIN_GROUP_ID, hashAdminPassword, lockAdminSecurity, writeAuditLog } from './modules/admin/index.js';

type TestAdminBootstrapResult =
  { created: true; username: 'superadmin' } | { created: false; reason: 'admin_accounts_not_empty' };

/** 显式测试初始化只能指向专用测试数据库，错误信息不包含连接凭据。 */
export function assertTestBootstrapEnvironment(
  env: Partial<Pick<NodeJS.ProcessEnv, 'SESAME_ENV' | 'DATABASE_URL'>>,
): void {
  if (env.SESAME_ENV !== 'test') throw new Error('测试后台用户初始化要求 SESAME_ENV=test');
  try {
    const database = new URL(env.DATABASE_URL ?? '');
    if (
      !['postgresql:', 'postgres:'].includes(database.protocol) ||
      decodeURIComponent(database.pathname) !== '/sesame_notes_test' ||
      database.hash
    )
      throw new Error('测试数据库地址不符合要求');
  } catch {
    throw new Error('测试后台用户初始化要求 DATABASE_URL 指向 PostgreSQL 数据库 sesame_notes_test');
  }
}

/** 仅在后台账号整表为空时创建测试超管，已有账号的身份、凭据和归属始终保持原样。 */
export async function initializeTestAdmin(prisma: PrismaClient): Promise<TestAdminBootstrapResult> {
  // 密码计算不占用后台安全锁；只有进入受控事务且确认整表为空后才写入账号。
  const passwordHash = await hashAdminPassword('superadmin');
  return prisma.$transaction(
    async (tx): Promise<TestAdminBootstrapResult> => {
      await lockAdminSecurity(tx);
      // 软删除账号同样表示此数据库已经初始化，不能据此补建或恢复默认凭据。
      if ((await tx.adminAccount.count()) !== 0) return { created: false, reason: 'admin_accounts_not_empty' };
      const group = await tx.adminGroup.findUnique({ where: { id: DEFAULT_ADMIN_GROUP_ID } });
      if (!group || group.deletedAt !== null) throw new Error('默认用户组不存在或已删除，请先完成数据库迁移');
      if (!group.isEnabled) throw new Error('默认用户组已停用，请先确认测试数据库的用户组状态');
      const admin = await tx.adminAccount.create({
        data: {
          username: 'superadmin',
          passwordHash,
          displayName: '系统管理员',
          identityType: 'super_admin',
          groupId: DEFAULT_ADMIN_GROUP_ID,
          email: null,
          phone: null,
          isEnabled: true,
          createdBy: '系统初始化',
          updatedBy: '系统初始化',
        },
      });
      await writeAuditLog(tx, {
        actor: 'system',
        action: 'admin.bootstrap',
        target: { type: 'admin_account', id: admin.id },
        requestId: 'cli:test-admin-bootstrap',
        metadata: { identity_type: 'super_admin', is_enabled: true, group_name: group.name },
      });
      return { created: true, username: 'superadmin' };
    },
    { maxWait: 10_000, timeout: 10_000 },
  );
}
