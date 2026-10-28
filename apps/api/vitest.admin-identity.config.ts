import { defineConfig } from 'vitest/config';

// 身份策略和脚本测试仅使用内存替身，不读取环境文件或连接数据库。
export default defineConfig({
  test: {
    include: [
      'src/modules/admin/admin-policy.test.ts',
      'src/modules/admin/admin-password.test.ts',
      'test/seed.test.ts',
      'test/auth-failure.test.ts',
      'test/admin-route-policy.test.ts',
      'test/admin-request-logging.test.ts',
    ],
    setupFiles: [],
  },
});
