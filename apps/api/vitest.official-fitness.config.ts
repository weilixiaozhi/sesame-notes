import { defineConfig } from 'vitest/config';

// 仅运行内存仓储与纯规则用例，不加载共享测试数据库的清理钩子。
export default defineConfig({
  test: {
    include: [
      'src/modules/fitness/official-fitness.test.ts',
      'src/modules/fitness/official-fitness-media.test.ts',
      'test/fitness-rules.test.ts',
      'test/fitness-plan-generation.test.ts',
    ],
    setupFiles: [],
  },
});
