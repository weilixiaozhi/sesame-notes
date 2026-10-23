import { configDefaults, defineConfig } from 'vitest/config';
import { guardedTestDatabaseUrl } from './test/existing-test-database.js';
import { initializeTestEnvironment } from './test/test-database.js';

let isolatedTarget = false;
try {
  isolatedTarget = /^\/sesame_test_[a-z0-9_]+$/.test(new URL(process.env.E2E_DATABASE_URL ?? '').pathname);
} catch {
  // 无效地址由完整环境校验统一拒绝，避免解析异常暴露连接凭据。
}
try {
  // 收集测试模块前校验目标；常态测试库加载显式配置，隔离库必须通过独立目标守卫。
  if (isolatedTarget) guardedTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
  else initializeTestEnvironment();
} catch (error) {
  throw new Error('API 测试环境校验失败，请核对显式测试配置。', { cause: error });
}

export default defineConfig({
  test: {
    sequence: { shuffle: true },
    // 后台最后超管等用例验证全库不变量，文件之间串行执行，避免其他夹具改变全局计数。
    fileParallelism: false,
    maxWorkers: 1,
    setupFiles: ['./test/setup.ts'],
    // 创建或删除数据库的用例只允许通过专用租约配置执行。
    exclude: [
      ...configDefaults.exclude,
      'test/database-initialization.test.ts',
      'test/server-generations.test.ts',
      'test/admin-migration.e2e.test.ts',
    ],
  },
});
