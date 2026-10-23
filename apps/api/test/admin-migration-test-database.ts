import { testFixtureDatabaseUrl } from './existing-test-database.js';

/** 后台迁移验收仅允许显式隔离副本，不能在共享服务或既有数据库入口创建临时库。 */
export function adminMigrationTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const value = testFixtureDatabaseUrl(env);
    const target = new URL(value);
    if (
      env.E2E_ADMIN_MIGRATION_SUITE !== 'isolated-clone-only-v1' ||
      env.E2E_DATABASE_MODE !== undefined ||
      env.E2E_EXCLUSIVE_WINDOW !== undefined ||
      env.E2E_EXISTING_SUITE !== undefined ||
      !/^\/sesame_test_[a-z0-9_]+$/.test(target.pathname) ||
      target.port === '55432'
    )
      throw new Error('后台迁移验收需要独立副本和专用确认配置');
    return value;
  } catch {
    throw new Error('后台迁移验收仅支持独立副本，请使用专用配置并显式指定隔离数据库');
  }
}
