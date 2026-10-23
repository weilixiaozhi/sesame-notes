import { defineConfig } from 'vitest/config';

// 时间口径与事件采集使用内存替身，不加载数据库清理或环境初始化钩子。
export default defineConfig({ test: { include: ['src/modules/analytics/*.test.ts'], setupFiles: [] } });
