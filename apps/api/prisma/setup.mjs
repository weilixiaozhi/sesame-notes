import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { databaseSetupDatasourceUrl } from './database-target.mjs';
import { prepareCurrentBaseline } from './current-baseline.mjs';

const schema = fileURLToPath(new URL('./schema.prisma', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
const initializeTestAccount = process.argv.includes('--test-admin');
const testBootstrap = fileURLToPath(new URL('../src/admin-test-bootstrap.ts', import.meta.url));
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
let prisma;

try {
  // 测试账号入口先核对环境，任何数据库写入都必须晚于目标身份确认。
  if (initializeTestAccount)
    execFileSync(process.execPath, [tsx, testBootstrap, '--check-environment'], { stdio: 'inherit' });
  prisma = new PrismaClient({ datasourceUrl: databaseSetupDatasourceUrl() });
  const result = await prepareCurrentBaseline(prisma);
  await prisma.$disconnect();
  if (result.mode === 'adopted')
    process.stdout.write('已将当前数据库迁移元数据登记为建库基线，业务数据与同步水位保持原值。\n');
  // 存量库已在维护事务登记基线，Prisma不会对已有业务表重放建库语句。
  execFileSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schema], { stdio: 'inherit' });
  await prepareCurrentBaseline(prisma);
  if (initializeTestAccount) execFileSync(process.execPath, [tsx, testBootstrap], { stdio: 'inherit' });
} catch (error) {
  process.stderr.write('数据库准备失败，请核对当前结构、迁移记录和停写状态；详细原因见下方错误日志。\n');
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await prisma?.$disconnect();
  } catch (error) {
    process.stderr.write('关闭数据库准备连接失败。\n');
    console.error(error);
    process.exitCode = 1;
  }
}
