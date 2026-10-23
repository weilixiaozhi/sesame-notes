import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { existingTestDatabaseUrl } from './existing-test-database.js';

// Run before suite collection. A separate process keeps Prisma out of the worker's mock cache.
const suite = basename(expect.getState().testPath ?? '');
if (!suite.endsWith('.test.ts') || ['database-initialization.test.ts', 'server-generations.test.ts'].includes(suite))
  throw new Error('Database lifecycle or unidentified suites are forbidden in the existing-database run.');
process.env.DATABASE_URL = existingTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
execFileSync(process.execPath, [fileURLToPath(new URL('./existing-database.preflight.mjs', import.meta.url))], {
  env: process.env,
  encoding: 'utf8',
  timeout: 15_000,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
