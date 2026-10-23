import { loadConfig, type ApiConfig } from '../src/config.js';
import { resolveTestEnvironment } from './test-database.js';
import { guardedTestDatabaseUrl } from './existing-test-database.js';

/** 测试连接先通过固定或隔离库守卫，运行时库名规则不应用于临时测试库。 */
export function loadTestApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const configured = environment.E2E_DATABASE_URL === undefined ? resolveTestEnvironment(environment) : environment;
  const databaseUrl = guardedTestDatabaseUrl(configured.E2E_DATABASE_URL, { ...environment, ...configured });
  const config = loadConfig({ ...environment, SESAME_ENV: undefined, DATABASE_URL: databaseUrl });
  return { ...config, databaseUrl, deploymentEnvironment: 'test' };
}
