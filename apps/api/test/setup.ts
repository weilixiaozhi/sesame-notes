import { basename } from 'node:path';
import { assertLifecycleSuite } from './lifecycle-test-database.js';
import { expect } from 'vitest';
import { existingTestDatabaseUrl, guardedTestDatabaseUrl } from './existing-test-database.js';
import { initializeTestEnvironment } from './test-database.js';
import { testStoragePath } from './test-storage-path.js';

const suite = basename(expect.getState().testPath ?? '');
const databaseSuite =
  suite.endsWith('.e2e.test.ts') ||
  [
    'admin.test.ts',
    'database-initialization.test.ts',
    'database-invariants.test.ts',
    'e2e-db.test.ts',
    'permission-matrix.test.ts',
    'security.test.ts',
    'server-generations.test.ts',
  ].includes(suite);
const hasExistingFlag = [
  process.env.E2E_DATABASE_MODE,
  process.env.E2E_EXCLUSIVE_WINDOW,
  process.env.E2E_EXISTING_SUITE,
].some((value) => value !== undefined);
let namesExistingDatabase = false;
let namesIsolatedDatabase = false;
try {
  const name = new URL(process.env.E2E_DATABASE_URL ?? 'https://invalid').pathname;
  namesExistingDatabase = name === '/sesame_notes';
  namesIsolatedDatabase = /^\/sesame_test_[a-z0-9_]+$/.test(name);
} catch {
  /* 下方统一校验格式错误，不把连接凭据写入日志。 */
}
const lifecycleRequested =
  process.env.E2E_DATABASE_MODE === 'lifecycle-only' ||
  ['E2E_LIFECYCLE_SUITE', 'E2E_LIFECYCLE_RUN_ID', 'E2E_LIFECYCLE_STATE_PATH'].some(
    (key) => process.env[key] !== undefined,
  );
if (lifecycleRequested) {
  assertLifecycleSuite(suite, process.env);
  // 生命周期测试只给实际数据库客户端传递当前租约的临时连接。
  process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/lifecycle_requires_explicit_target';
} else if (hasExistingFlag || namesExistingDatabase) {
  if (process.env.E2E_EXISTING_SUITE !== 'existing-exclusive-v1')
    throw new Error('Use --config test/existing-suite.config.ts for existing-database validation.');
  existingTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
} else if (namesIsolatedDatabase) {
  process.env.DATABASE_URL = guardedTestDatabaseUrl(process.env.E2E_DATABASE_URL, process.env);
} else if (
  databaseSuite ||
  process.env.E2E_DATABASE_URL !== undefined ||
  (process.env.DATABASE_URL !== undefined &&
    process.env.DATABASE_URL !== 'postgresql://unused:unused@127.0.0.1:1/unit_test_requires_explicit_target')
) {
  initializeTestEnvironment();
}

// 无数据库的单元测试使用不可达地址；业务数据库用例必须先通过上述显式目标校验。
process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:1/unit_test_requires_explicit_target';
process.env.JWT_SECRET ??= 'test-only-secret-that-is-at-least-32-bytes';
process.env.STORAGE_PATH ??= testStoragePath(suite.replace(/\.test\.ts$/, '') || 'default');
