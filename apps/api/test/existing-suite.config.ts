import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { existingTestDatabaseUrl } from './existing-test-database.js';

// This explicit entry point cannot silently fall back to a different database.
existingTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../../Temp/vitest-existing-api', import.meta.url)),
  test: {
    env: { E2E_EXISTING_SUITE: 'existing-exclusive-v1' },
    include: ['test/*.test.ts'],
    exclude: [
      'test/database-initialization.test.ts',
      'test/server-generations.test.ts',
      'test/admin-migration.e2e.test.ts',
    ],
    setupFiles: ['./test/setup.ts', './test/existing-database.setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { shuffle: true, concurrent: false, setupFiles: 'list' },
  },
});
