import { PrismaClient } from '@prisma/client';
import { assertExistingTestDatabase, existingTestDatabaseUrl } from './existing-test-database.ts';

let prisma;
try {
  const url = existingTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
  prisma = new PrismaClient({ datasourceUrl: url });
  // This read-only guard also requires server_epochs.id=0 before any application import can upsert it.
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
