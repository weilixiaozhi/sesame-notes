import { defineConfig } from 'vitest/config';
import { adminMigrationTestDatabaseUrl } from './test/admin-migration-test-database.js';

// 迁移用例单独运行；在读取用例前拒绝共享端口、默认测试库和无确认标识的目标。
adminMigrationTestDatabaseUrl();
export default defineConfig({
  test: {
    include: ['test/admin-migration.e2e.test.ts'],
    setupFiles: [],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    bail: 1,
  },
});
