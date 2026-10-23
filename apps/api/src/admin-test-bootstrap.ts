import { PrismaClient } from '@prisma/client';
import { assertTestBootstrapEnvironment, initializeTestAdmin } from './admin-test-initialization.js';

let prisma: PrismaClient | undefined;

/** 测试环境初始化入口先核对目标环境，空账号表才创建默认超管。 */
async function main(): Promise<void> {
  assertTestBootstrapEnvironment(process.env);
  if (process.argv.includes('--check-environment')) return;
  prisma = new PrismaClient();
  const result = await initializeTestAdmin(prisma);
  process.stdout.write(
    result.created ? `已创建测试超管 ${result.username}。\n` : '测试库已有后台用户，保留现有账号配置。\n',
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write('测试超管初始化失败，请检查测试环境配置和数据库状态。\n');
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await prisma?.$disconnect();
  } catch (error) {
    process.stderr.write('关闭测试初始化数据库连接失败。\n');
    console.error(error);
    process.exitCode = 1;
  }
}
