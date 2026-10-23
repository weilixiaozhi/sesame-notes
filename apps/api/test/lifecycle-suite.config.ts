import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { lifecycleDatabaseConfig } from './lifecycle-test-database.js';

lifecycleDatabaseConfig(process.env);
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../../Temp/vitest-lifecycle-api', import.meta.url)),
  test: {
    include: ['test/database-initialization.test.ts', 'test/server-generations.test.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    bail: 1,
    sequence: { shuffle: false, concurrent: false },
    hookTimeout: 120_000,
  },
});
