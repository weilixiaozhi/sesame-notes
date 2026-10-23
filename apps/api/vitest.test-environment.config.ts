import { defineConfig } from 'vitest/config';

// 这些测试只解析配置和连接地址，不加载 API 或数据库初始化。
export default defineConfig({
  test: {
    include: ['test/test-environment.test.ts'],
    setupFiles: [],
    sequence: { shuffle: true },
  },
});
