import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ADMIN_IDENTITY_MIGRATION, prepareLegacyAdminIdentity } from './admin-identity-upgrade.mjs';
import {
  assertDatabaseUpgradeTarget,
  completeSyncProtocolUpgrade,
  databaseUpgradeDatasourceUrl,
} from './sync-protocol-upgrade.mjs';

const schema = fileURLToPath(new URL('./schema.prisma', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
const migrations = fileURLToPath(new URL('./migrations', import.meta.url));
const initializeTestAccount = process.argv.includes('--test-admin');
const testBootstrap = fileURLToPath(new URL('../src/admin-test-bootstrap.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));

/** 核对数据库中已成功应用的迁移，阻止历史文件被修改或遗失后继续部署。 */
async function verifyAppliedMigrations() {
  const prisma = new PrismaClient({ datasourceUrl: databaseUpgradeDatasourceUrl() });
  try {
    // 在读取历史或准备任何升级数据前，确认连接身份与显式业务库和 public schema 一致。
    await assertDatabaseUpgradeTarget(prisma);
    const [table] = await prisma.$queryRaw`SELECT to_regclass('public._prisma_migrations')::text AS name`;
    if (!table?.name) return;
    const applied = await prisma.$queryRaw`
      SELECT migration_name, checksum FROM public._prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    const directories = new Set(
      readdirSync(migrations, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    for (const migration of applied) {
      if (!directories.has(migration.migration_name))
        throw new Error(`已应用迁移文件缺失：${migration.migration_name}`);
      const content = readFileSync(join(migrations, migration.migration_name, 'migration.sql'), 'utf8');
      // Git 在不同平台可能转换行尾；只允许行尾等价，不忽略 SQL 或注释内容变化。
      const normalized = content.replaceAll('\r\n', '\n');
      const hashes = [content, normalized, normalized.replaceAll('\n', '\r\n')].map((value) =>
        createHash('sha256').update(value).digest('hex'),
      );
      if (!hashes.includes(migration.checksum)) throw new Error(`已应用迁移校验和不匹配：${migration.migration_name}`);
    }
  } catch (error) {
    throw new Error('历史迁移完整性校验失败', { cause: error });
  } finally {
    await prisma.$disconnect();
  }
}

/** 在历史迁移执行前自动准备旧后台账号，保留已有的显式授权清单。 */
async function prepareDatabaseUpgrade() {
  const prisma = new PrismaClient({ datasourceUrl: databaseUpgradeDatasourceUrl() });
  try {
    if (!existsSync(join(migrations, ADMIN_IDENTITY_MIGRATION, 'migration.sql'))) return;
    let result = await prepareLegacyAdminIdentity(prisma);
    if (result.retry) {
      // 只恢复校验和相同、未执行步骤且整个事务已回滚的身份迁移，随后仍执行完整 SQL。
      execFileSync(
        process.execPath,
        [cli, 'migrate', 'resolve', '--rolled-back', ADMIN_IDENTITY_MIGRATION, '--schema', schema],
        { stdio: 'inherit' },
      );
      result = await prepareLegacyAdminIdentity(prisma);
      if (result.retry) throw new Error('身份迁移失败状态再次变化，请停止其他部署后重试');
    }
    if (result.accounts > 0)
      process.stdout.write(
        `已自动准备 ${result.accounts} 个旧后台账号；超级管理员身份保留，普通账号业务权限由超级管理员配置。\n`,
      );
  } catch (cause) {
    throw new Error('数据库自动升级准备失败', { cause });
  } finally {
    await prisma.$disconnect();
  }
}

/** 在结构迁移完成后收敛同步协议切点，历史版本夹具只执行其目录声明的迁移。 */
async function completeDatabaseUpgrade() {
  const prisma = new PrismaClient({ datasourceUrl: databaseUpgradeDatasourceUrl() });
  try {
    if (!existsSync(join(migrations, '20261020000000_sync_protocol_cutover', 'migration.sql'))) return;
    const result = await completeSyncProtocolUpgrade(prisma);
    if (result.applied) process.stdout.write('数据库同步协议自动升级完成。\n');
  } catch (cause) {
    throw new Error('数据库同步协议自动升级失败，请保持服务停止并核对详细日志', { cause });
  } finally {
    await prisma.$disconnect();
  }
}

try {
  // 测试初始化在迁移前核对环境，避免默认账号流程触及其他数据库。
  if (initializeTestAccount)
    execFileSync(process.execPath, [tsx, testBootstrap, '--check-environment'], { stdio: 'inherit' });
  await verifyAppliedMigrations();
  await prepareDatabaseUpgrade();
  // 完整性校验通过后，只执行尚未应用的迁移；具体数据转换以每个迁移 SQL 为准。
  execFileSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schema], { stdio: 'inherit' });
  await completeDatabaseUpgrade();
  if (initializeTestAccount) execFileSync(process.execPath, [tsx, testBootstrap], { stdio: 'inherit' });
} catch (error) {
  const status = typeof error?.status === 'number' ? `退出码 ${error.status}` : String(error);
  process.stderr.write(`数据库升级失败：${status}。请查看详细错误日志，核对连接配置、迁移结果和停写状态。\n`);
  console.error(error);
  process.exitCode = 1;
}
