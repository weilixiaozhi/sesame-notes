import { defineConfig } from 'vitest/config';

// 本配置只执行注入内存数据仓储的路由测试，不加载环境文件或建立数据库连接。
export default defineConfig({
  test: {
    include: ['src/modules/admin/admin-business.test.ts', 'test/admin-web-compatibility.test.ts'],
    setupFiles: [],
  },
});
