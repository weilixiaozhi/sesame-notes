import { PrismaClient } from '@prisma/client';
import {
  hashAdminPassword,
  lockAdminSecurity,
  normalizeAdminUsername,
  revokeAdminSessions,
  validateAdminPassword,
  writeAuditLog,
} from './modules/admin/index.js';

const prisma = new PrismaClient();

/** 受控服务器恢复流程：只重置已启用后台用户的密码，不新建账号、不改变身份、用户组或解除禁用。 */
async function main(): Promise<void> {
  if (process.env.ADMIN_RECOVERY_CONFIRM !== 'RESET_ADMIN_PASSWORD')
    throw new Error('必须显式设置 ADMIN_RECOVERY_CONFIRM=RESET_ADMIN_PASSWORD');
  if (!process.env.ADMIN_USERNAME?.trim()) throw new Error('ADMIN_USERNAME 未配置');
  const username = normalizeAdminUsername(process.env.ADMIN_USERNAME);
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD 未配置');
  validateAdminPassword(password);
  const passwordHash = await hashAdminPassword(password);

  await prisma.$transaction(async (tx) => {
    await lockAdminSecurity(tx);
    const admin = await tx.adminAccount.findUnique({ where: { username } });
    if (!admin) throw new Error('后台账号不存在；恢复命令不会创建账号');
    if (admin.deletedAt !== null) throw new Error('后台账号已删除，不能恢复');
    if (!admin.isEnabled) throw new Error('后台账号已禁用；密码恢复不会自动解除禁用');
    await tx.adminAccount.update({
      where: { id: admin.id },
      data: {
        passwordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
        version: { increment: 1 },
        updatedBy: '系统恢复',
      },
    });
    await revokeAdminSessions(tx, admin.id);
    await writeAuditLog(tx, {
      actor: 'system',
      action: 'admin.password_recovered',
      target: { type: 'admin_account', id: admin.id },
      requestId: 'cli:admin-recover',
    });
  });
  process.stdout.write(`后台账号 ${username} 的密码已重置，全部旧会话已撤销；可使用新密码直接登录。\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `后台密码恢复失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
