import { describe, expect, it } from 'vitest';
import { initializeTestEnvironment, resolveTestEnvironment, testDatabaseUrl } from './test-database.js';
import { loadTestApiConfig } from './test-api-config.js';
import { loadConfig } from '../src/config.js';

const localUrl = 'postgresql://runner:PRIVATE_SENTINEL@localhost:55432/sesame_notes_test';
const ciUrl = 'postgresql://runner:PRIVATE_SENTINEL@127.0.0.1:5432/sesame_notes_test_ci';
const local = { SESAME_ENV: 'test', DATABASE_URL: localUrl };

/** 模拟未创建本地配置文件的纯进程配置入口。 */
function missingFile(): never {
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
}

describe('explicit test database targets', () => {
  it.each([
    localUrl,
    localUrl.replace('localhost', '127.0.0.1'),
    localUrl.replace('localhost', '[::1]'),
    ciUrl,
    `${localUrl}?schema=public&connection_limit=10&pool_timeout=20&application_name=unit-test`,
  ])('accepts a known local/CI endpoint', (url) => {
    const result = resolveTestEnvironment({ SESAME_ENV: 'test', DATABASE_URL: url });
    expect(result).toEqual({
      SESAME_ENV: 'test',
      NODE_ENV: 'test',
      DATABASE_URL: url,
      E2E_DATABASE_URL: url,
    });
  });

  it.each([
    undefined,
    '',
    'not-a-url-PRIVATE_SENTINEL',
    localUrl.replace('sesame_notes_test', 'sesame_notes'),
    localUrl.replace('sesame_notes_test', 'sesame_notes_prod'),
    localUrl.replace('sesame_notes_test', 'unknown_test'),
    localUrl.replace('55432', '5432'),
    localUrl.replace('55432', '55433'),
    ciUrl.replace('5432', '55432'),
    localUrl.replace('localhost', 'db.prod.example'),
    localUrl.replace('postgresql:', 'https:'),
    localUrl.replace('runner:PRIVATE_SENTINEL@', ''),
    `${localUrl}#PRIVATE_SENTINEL`,
    `${localUrl}?schema=other`,
    `${localUrl}?schema=public&schema=other`,
    `${localUrl}?host=db.prod.example`,
    `${localUrl}?%68ost=db.prod.example`,
    `${localUrl}?options=-csearch_path=other`,
    `${localUrl}?connection_limit=0`,
    `${localUrl}?pool_timeout=-1`,
    `${localUrl}?application_name=contains%20spaces`,
    localUrl.replace('PRIVATE_SENTINEL', '%zz'),
    `${localUrl}\n`,
  ])('rejects unsafe or missing targets without exposing credentials', (url) => {
    try {
      resolveTestEnvironment({ SESAME_ENV: 'test', DATABASE_URL: url });
      expect.fail('an unsafe URL was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('API test environment rejected');
      expect(String(error)).not.toContain('PRIVATE_SENTINEL');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it.each([undefined, '', 'prod', 'dev', ' test'])('requires an explicit test environment', (environment) => {
    expect(() => resolveTestEnvironment({ ...local, SESAME_ENV: environment })).toThrow('SESAME_ENV');
  });

  it('rejects production mode, including a production mode in the file', () => {
    expect(() => resolveTestEnvironment({ ...local, NODE_ENV: 'production' })).toThrow('NODE_ENV');
    expect(() => resolveTestEnvironment({ ...local, NODE_ENV: 'test' }, { ...local, NODE_ENV: 'production' })).toThrow(
      'NODE_ENV',
    );
  });

  it.each([
    ciUrl,
    localUrl.replace('localhost', '127.0.0.1'),
    localUrl.replace('PRIVATE_SENTINEL', 'different'),
    localUrl.replace('runner:', 'different:'),
    '',
  ])('rejects mismatched explicit E2E targets or credentials', (url) => {
    expect(() => resolveTestEnvironment({ ...local, E2E_DATABASE_URL: url })).toThrow('API test environment rejected');
  });

  it('returns the validated canonical URL rather than an ambiguous raw path', () => {
    const url = localUrl.replace('/sesame_notes_test', '/unused/../sesame_notes_test');
    expect(resolveTestEnvironment({ SESAME_ENV: 'test', DATABASE_URL: url }).DATABASE_URL).toBe(localUrl);
  });

  it('allows non-routing pool/application variants for the same target', () => {
    const url = `${localUrl}?schema=public&connection_limit=1&pool_timeout=0&application_name=sync-cursor-test`;
    expect(resolveTestEnvironment({ ...local, E2E_DATABASE_URL: url }).E2E_DATABASE_URL).toBe(url);
  });
});

describe('explicit .env.test loading', () => {
  it('reads only .env.test and leaves live API storage/JWT out of fixtures', () => {
    const environment: NodeJS.ProcessEnv = { JWT_SECRET: 'unit-fixture', STORAGE_PATH: '.unit-storage' };
    const result = initializeTestEnvironment(environment, (file) => {
      expect(file.pathname.endsWith('/.env.test')).toBe(true);
      return [
        'SESAME_ENV=test',
        'NODE_ENV=development',
        `DATABASE_URL="${localUrl}"`,
        'JWT_SECRET=PRIVATE_FILE_TOKEN',
        'STORAGE_PATH=./data',
      ].join('\n');
    });
    expect(environment).toMatchObject(result);
    expect(environment.JWT_SECRET).toBe('unit-fixture');
    expect(environment.STORAGE_PATH).toBe('.unit-storage');
  });

  it('allows explicit CI configuration without a local file', () => {
    const environment = { SESAME_ENV: 'test', DATABASE_URL: ciUrl, E2E_DATABASE_URL: ciUrl };
    expect(initializeTestEnvironment(environment, missingFile).DATABASE_URL).toBe(ciUrl);
  });

  it('rejects a missing file and missing explicit configuration', () => {
    expect(() => initializeTestEnvironment({}, missingFile)).toThrow('SESAME_ENV');
  });

  it('rejects a mislabeled/unsafe file even with safe process overrides', () => {
    expect(() => initializeTestEnvironment({ ...local }, () => `SESAME_ENV=prod\nDATABASE_URL=${localUrl}`)).toThrow(
      'SESAME_ENV',
    );
    expect(() =>
      initializeTestEnvironment({ ...local }, () => `SESAME_ENV=test\nDATABASE_URL=${localUrl.replace('_test', '')}`),
    ).toThrow('API test environment rejected');
  });

  it('rejects unsafe inherited overrides rather than selecting the file silently', () => {
    expect(() =>
      initializeTestEnvironment({ SESAME_ENV: 'prod' }, () => `SESAME_ENV=test\nDATABASE_URL=${localUrl}`),
    ).toThrow('SESAME_ENV');
  });

  it('hides file read/parse diagnostics', () => {
    expect(() =>
      initializeTestEnvironment({}, () => {
        throw new Error('PRIVATE_SENTINEL');
      }),
    ).toThrow('unable to read');
    try {
      initializeTestEnvironment({}, () => {
        throw new Error('PRIVATE_SENTINEL');
      });
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_SENTINEL');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('revalidates later environment changes instead of caching a safe URL', () => {
    const environment = { ...local };
    initializeTestEnvironment(environment, missingFile);
    environment.DATABASE_URL = localUrl.replace('_test', '_prod');
    expect(() => testDatabaseUrl(environment)).toThrow('API test environment rejected');
  });
});

describe('test-only API configuration', () => {
  const fixtures = {
    SESAME_ENV: 'test',
    JWT_SECRET: 'unit-only-secret-that-is-at-least-32-bytes',
    STORAGE_PATH: '.unit-storage',
  };

  it.each([localUrl, ciUrl])('constructs validated local/CI test configuration', (url) => {
    expect(loadTestApiConfig({ ...fixtures, DATABASE_URL: url })).toMatchObject({
      databaseUrl: url,
      deploymentEnvironment: 'test',
    });
  });

  it('refuses a production target before constructing API configuration', () => {
    expect(() => loadTestApiConfig({ ...fixtures, DATABASE_URL: localUrl.replace('_test', '_prod') })).toThrow(
      'API test environment rejected',
    );
  });

  it('测试配置隔离不改写环境，也不放松部署配置的数据库名称校验', () => {
    try {
      const environment = { ...fixtures, DATABASE_URL: ciUrl, E2E_DATABASE_URL: ciUrl };
      const original = { ...environment };
      expect(loadTestApiConfig(environment)).toMatchObject({
        databaseUrl: ciUrl,
        deploymentEnvironment: 'test',
      });
      expect(environment).toEqual(original);
      for (const deploymentEnvironment of ['test', 'prod']) {
        expect(() => loadConfig({ ...environment, SESAME_ENV: deploymentEnvironment })).toThrow(
          'DATABASE_URL database does not match SESAME_ENV',
        );
      }
    } catch (cause) {
      throw new Error('测试与部署配置隔离回归失败', { cause });
    }
  });
});
