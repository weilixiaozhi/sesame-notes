import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_ADMIN_GROUP_ID,
  assertAdminContactsAvailable,
  hashAdminPassword,
  lockAdminSecurity,
  normalizeAdminEmail,
  normalizeAdminPhone,
  normalizeAdminUsername,
  validateAdminPassword,
  writeAuditLog,
} from './modules/admin/index.js';

const prisma = new PrismaClient();

/** 可信部署入口只创建首个独立超级管理员；重复执行不重置凭据，也不提升已有账号。 */
async function main(): Promise<void> {
  if (process.env.SEED_CONFIRM !== 'CREATE_ADMIN')
    throw new Error('必须显式设置 SEED_CONFIRM=CREATE_ADMIN 才能创建后台用户');
  if (process.env.SEED_ADMIN_COUNTRY_CODE !== undefined)
    throw new Error('请将国际区号直接填写在 SEED_ADMIN_PHONE 中，并移除 SEED_ADMIN_COUNTRY_CODE');
  if (!process.env.SEED_ADMIN_USERNAME?.trim()) throw new Error('SEED_ADMIN_USERNAME 未配置');
  const username = normalizeAdminUsername(process.env.SEED_ADMIN_USERNAME);
  const email = normalizeAdminEmail(process.env.SEED_ADMIN_EMAIL);
  const phone = normalizeAdminPhone(process.env.SEED_ADMIN_PHONE);
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) throw new Error('SEED_ADMIN_PASSWORD 未配置');
  const groupId = process.env.SEED_ADMIN_GROUP_ID?.trim() || DEFAULT_ADMIN_GROUP_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(groupId))
    throw new Error('SEED_ADMIN_GROUP_ID 必须为所选用户组的稳定内部引用');
  validateAdminPassword(password);
  // 哈希在事务外计算，避免占用后台安全锁和数据库连接进行昂贵的密码运算。
  const passwordHash = await hashAdminPassword(password);

  const created = await prisma.$transaction(async (tx) => {
    await lockAdminSecurity(tx);
    if (await tx.adminAccount.findUnique({ where: { username } })) return false;
    if (await tx.adminAccount.count({ where: { identityType: 'super_admin' } }))
      throw new Error('已存在超级管理员；新增后台用户请通过后台用户管理，凭据恢复请使用受控恢复命令');
    await assertAdminContactsAvailable(tx, { email, phone });
    const group = await tx.adminGroup.findUnique({ where: { id: groupId } });
    if (!group || group.deletedAt !== null) throw new Error('所选用户组不存在或已删除，请确认数据库迁移已完成');
    if (!group.isEnabled) throw new Error('所选用户组已停用，请选择已启用的用户组进行初始化');
    const admin = await tx.adminAccount.create({
      data: {
        username,
        email,
        phone,
        displayName: '系统管理员',
        passwordHash,
        identityType: 'super_admin',
        groupId,
        createdBy: '系统初始化',
        updatedBy: '系统初始化',
        isEnabled: true,
      },
    });
    await writeAuditLog(tx, {
      actor: 'system',
      action: 'admin.bootstrap',
      target: { type: 'admin_account', id: admin.id },
      requestId: 'cli:admin-bootstrap',
    });
    return true;
  });
  process.stdout.write(
    created
      ? `已创建独立后台用户 ${username}（超级管理员），可使用所设密码直接登录。\n`
      : `后台用户 ${username} 已存在，未修改密码、状态、身份或用户组。\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `后台用户创建失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
