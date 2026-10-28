import { PrismaClient } from '@prisma/client';
import { assertExistingTestDatabase, existingTestDatabaseUrl } from './existing-test-database.ts';

let prisma;
try {
  const url = existingTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
  prisma = new PrismaClient({ datasourceUrl: url });
  // 现有库验收要求权威代际单例完整，应用读取只消费迁移建立的状态。
  await assertExistingTestDatabase(prisma, url, process.env);
} catch (error) {
  // Do not forward driver error details, environment values, or connection URLs.
  const message =
    error instanceof Error && error.message.startsWith('Existing API ')
      ? error.message
      : 'Existing API read-only preflight failed; no test fixtures were started.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
}
