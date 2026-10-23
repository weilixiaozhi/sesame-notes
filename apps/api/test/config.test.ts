import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('独立后台来源与会话期限', () => {
  const env = {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    JWT_SECRET: 'explicit-secret-that-is-at-least-32-bytes',
    STORAGE_PATH: '/unused',
  };

  it('未配置后台来源时不继承普通用户来源，默认限制绝对与闲置期限', () => {
    expect(loadConfig({ ...env, CORS_ORIGINS: 'https://app.example.test' })).toMatchObject({
      adminOrigins: [],
      adminSessionTtlSeconds: 28_800,
      adminSessionIdleTtlSeconds: 1_800,
    });
  });

  it.each([
    '*',
    'http://admin.example.test',
    'https://*.example.test',
    'https://admin.example.test/login',
    'https://admin.example.test/',
    'https://name:password@admin.example.test',
    'null',
  ])('拒绝不是精确 HTTPS origin 的后台来源 %s', (origin) => {
    expect(() => loadConfig({ ...env, ADMIN_ORIGINS: origin })).toThrow('ADMIN_ORIGINS');
  });

  it('接受并去重明确后台来源', () => {
    expect(
      loadConfig({ ...env, ADMIN_ORIGINS: 'https://admin.example.test, https://admin.example.test' }).adminOrigins,
    ).toEqual(['https://admin.example.test']);
  });

  it('显式开发进程允许精确localhost HTTP来源并保留Nginx公网HTTPS来源', () => {
    expect(
      loadConfig({
        ...env,
        NODE_ENV: 'development',
        ADMIN_ORIGINS: 'http://localhost:55174,https://admin.example.test',
      }).adminOrigins,
    ).toEqual(['http://localhost:55174', 'https://admin.example.test']);
  });

  it.each([undefined, 'test', 'production'])('非开发进程%s拒绝HTTP localhost', (mode) => {
    expect(() => loadConfig({ ...env, NODE_ENV: mode, ADMIN_ORIGINS: 'http://localhost:55174' })).toThrow(
      'ADMIN_ORIGINS',
    );
  });

  it('生产部署即使误填development也拒绝HTTP localhost', () => {
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: 'development',
        SESAME_ENV: 'prod',
        DATABASE_URL: 'postgresql://unused:unused@localhost:5432/sesame_notes_prod',
        ADMIN_ORIGINS: 'http://localhost:55174',
      }),
    ).toThrow('ADMIN_ORIGINS');
  });

  it.each([
    'http://admin.example.test',
    'http://localhost.example.test:55174',
    'http://localhost:55174/',
    'http://name:password@localhost:55174',
  ])('开发例外拒绝非精确本机来源%s', (origin) => {
    expect(() => loadConfig({ ...env, NODE_ENV: 'development', ADMIN_ORIGINS: origin })).toThrow('ADMIN_ORIGINS');
  });

  it.each([
    { ADMIN_SESSION_TTL: '28801' },
    { ADMIN_SESSION_IDLE_TTL: '1801' },
    { ADMIN_SESSION_TTL: '900', ADMIN_SESSION_IDLE_TTL: '901' },
    { ADMIN_SESSION_TTL: '0' },
    { ADMIN_SESSION_IDLE_TTL: '-1' },
  ])('拒绝放宽或无效的后台会话期限 %j', (value) => {
    expect(() => loadConfig({ ...env, ...value })).toThrow('ADMIN_SESSION');
  });
});

describe('运行时配置不接受测试默认值', () => {
  it.each(['production', 'development', 'test', undefined])('环境 %s 缺少配置时拒绝启动', (nodeEnv) => {
    const env = {
      NODE_ENV: nodeEnv,
      DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
      JWT_SECRET: 'explicit-secret-that-is-at-least-32-bytes',
      STORAGE_PATH: '/unused',
    };
    expect(() => loadConfig({ ...env, DATABASE_URL: undefined })).toThrow('DATABASE_URL');
    expect(() => loadConfig({ ...env, JWT_SECRET: undefined })).toThrow('JWT_SECRET');
    expect(() => loadConfig({ ...env, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
    expect(() => loadConfig({ ...env, STORAGE_PATH: undefined })).toThrow('STORAGE_PATH');
    expect(loadConfig(env)).toMatchObject({ databaseUrl: env.DATABASE_URL, jwtSecret: env.JWT_SECRET });
  });
});

describe('生产 JWT 密钥校验', () => {
  const env = {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/sesame_notes_prod',
    JWT_SECRET: 'W8m!jS9r-aP3u#nR5vB7kT2qE6yD4zX1c',
    STORAGE_PATH: '/unused',
  };
  const publicSecrets = [
    'replace-with-the-existing-production-jwt-secret',
    'replace-with-at-least-32-random-bytes',
    'dev-only-secret-that-is-at-least-32-bytes-long',
    'test-only-secret-that-is-at-least-32-bytes',
  ];

  it.each([
    { SESAME_ENV: 'prod' },
    { NODE_ENV: 'production' },
    { SESAME_ENV: 'prod', NODE_ENV: 'development' },
    { SESAME_ENV: 'test', NODE_ENV: 'production' },
  ])('任一生产标记都拒绝公开配置中的密钥：%j', (mode) => {
    const databaseUrl = `postgresql://unused:unused@localhost:5432/sesame_notes_${mode.SESAME_ENV ?? 'prod'}`;
    for (const secret of publicSecrets) {
      for (const value of [secret, `  ${secret.toUpperCase()}  `]) {
        expect(() => loadConfig({ ...env, ...mode, DATABASE_URL: databaseUrl, JWT_SECRET: value })).toThrow(
          '生产环境 JWT_SECRET 不能使用公开示例或测试密钥',
        );
      }
    }
  });

  it.each([undefined, '', ' '.repeat(64), 'short', ` short${' '.repeat(64)}`])(
    '生产环境拒绝缺失、空白、过短或空格填充的密钥',
    (secret) => {
      expect(() => loadConfig({ ...env, SESAME_ENV: 'prod', JWT_SECRET: secret })).toThrow('JWT_SECRET');
    },
  );

  it.each([env.JWT_SECRET, `  ${env.JWT_SECRET}  `, '生产部署自行提供的足够长度密钥', 'x'.repeat(32)])(
    '已有合法密钥保留原始字节，不强制更换编码或格式',
    (secret) => {
      expect(loadConfig({ ...env, SESAME_ENV: 'prod', JWT_SECRET: secret }).jwtSecret).toBe(secret);
    },
  );

  it('非生产测试环境继续接受原有测试密钥和局域网监听', () => {
    expect(
      loadConfig({
        ...env,
        SESAME_ENV: 'test',
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://unused:unused@localhost:5432/sesame_notes_test',
        JWT_SECRET: 'dev-only-secret-that-is-at-least-32-bytes-long',
      }),
    ).toMatchObject({ jwtSecret: 'dev-only-secret-that-is-at-least-32-bytes-long', host: '0.0.0.0' });
  });

  it('配置错误与原因不回显无效密钥', () => {
    const secret = 'PRIVATE_SENTINEL';
    try {
      loadConfig({ ...env, NODE_ENV: 'production', JWT_SECRET: secret });
      expect.unreachable('无效密钥必须拒绝启动');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('服务端配置无效：JWT_SECRET');
      expect(String(error)).not.toContain(secret);
      expect(String((error as Error).cause)).not.toContain(secret);
    }
  });
});

describe('显式更新仓库配置', () => {
  const env = {
    DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
    JWT_SECRET: 'explicit-secret-that-is-at-least-32-bytes',
    STORAGE_PATH: '/unused',
  };

  it('未配置仓库时不选择默认更新源', () => {
    expect(loadConfig(env).githubReleaseRepository).toBe('');
  });

  it('接受部署者选择的仓库，公开仓库无需凭据', () => {
    expect(loadConfig({ ...env, GITHUB_RELEASE_REPOSITORY: ' example-owner/mobile.release ' })).toMatchObject({
      githubReleaseRepository: 'example-owner/mobile.release',
      githubReleaseToken: '',
    });
  });

  it.each([
    'https://github.com/owner/repo',
    'owner/repo/extra',
    'owner/..',
    'owner/repo?token=PRIVATE_SENTINEL',
    'owner/repo#tag',
    'owner/%2e%2e',
  ])('拒绝非法仓库标识且不回显输入：%s', (repository) => {
    expect(() => loadConfig({ ...env, GITHUB_RELEASE_REPOSITORY: repository })).toThrow(
      '服务端配置无效：GITHUB_RELEASE_REPOSITORY 必须使用 owner/repo 格式',
    );
  });
});

describe('explicit deployment environment', () => {
  const base = {
    JWT_SECRET: 'explicit-secret-that-is-at-least-32-bytes',
    STORAGE_PATH: '/unused',
  };

  it.each(['test', 'prod'] as const)('accepts the matching %s database', (environment) => {
    expect(
      loadConfig({
        ...base,
        SESAME_ENV: environment,
        DATABASE_URL: `postgresql://user:password@postgres:5432/sesame_notes_${environment}`,
      }).deploymentEnvironment,
    ).toBe(environment);
  });

  it.each(['test', 'prod'] as const)(
    'rejects a different database for %s without exposing credentials',
    (environment) => {
      const url = 'postgresql://user:PRIVATE_SENTINEL@postgres:5432/sesame_notes';
      expect(() => loadConfig({ ...base, SESAME_ENV: environment, DATABASE_URL: url })).toThrow(
        'does not match SESAME_ENV',
      );
      try {
        loadConfig({ ...base, SESAME_ENV: environment, DATABASE_URL: url });
      } catch (error) {
        expect(String(error)).not.toContain('PRIVATE_SENTINEL');
      }
    },
  );

  it('rejects unknown environment names', () => {
    expect(() => loadConfig({ ...base, SESAME_ENV: 'dev', DATABASE_URL: 'postgresql://unused/unused' })).toThrow(
      'SESAME_ENV',
    );
  });
});
