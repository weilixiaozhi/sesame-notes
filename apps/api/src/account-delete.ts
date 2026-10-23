import { PrismaClient } from '@prisma/client';
import { deleteAccount } from './modules/accounts/index.js';
import { ANY_UUID_PATTERN } from './shared/contracts/scalars.js';

/** 运维显式入口：目标与确认值必须完全一致，不加载默认环境文件或推断待删除账号。 */
async function main(): Promise<void> {
  let prisma: PrismaClient | undefined;
  try {
    const userId = process.env.DELETE_ACCOUNT_ID;
    if (!userId || !new RegExp(ANY_UUID_PATTERN).test(userId)) throw new Error('DELETE_ACCOUNT_ID 必须是有效账号 UUID');
    if (process.env.DELETE_ACCOUNT_CONFIRM !== userId)
      throw new Error('DELETE_ACCOUNT_CONFIRM 必须与目标账号 UUID 完全相同');
    if (!process.env.DATABASE_URL) throw new Error('必须显式设置 DATABASE_URL');
    prisma = new PrismaClient();
    const result = await deleteAccount(prisma, userId);
    process.stdout.write(`${JSON.stringify({ user_id: userId, ...result })}\n`);
  } catch (error) {
    process.stderr.write('账号删除未完成，请检查账号共享关系与数据库状态。\n');
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (prisma) {
      try {
        await prisma.$disconnect();
      } catch (error) {
        console.error('账号删除连接关闭失败', error);
        process.exitCode = 1;
      }
    }
  }
}

await main();
