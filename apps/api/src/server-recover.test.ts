import { describe, expect, it } from 'vitest';
import { serverRecoveryConfig } from './server-recover.js';

const database = 'postgresql://sesame:private-value@127.0.0.1:5400/sesame_test_recovery?schema=public';
const target = '127.0.0.1:5400/sesame_test_recovery';
const applyEnvironment = {
  DATABASE_URL: database,
  SERVER_RECOVERY_CONFIRM: target,
  SERVER_RECOVERY_MAINTENANCE: 'API_STOPPED',
  SERVER_RECOVERY_OPERATOR: '恢复值班员',
  SERVER_RECOVERY_REASON: '隔离备份恢复演练',
  SERVER_RECOVERY_BACKUP_REFERENCE: 'fixture-backup-20261013',
};

describe('服务器恢复显式目标', () => {
  it('只读检查可以生成不含凭据的目标，连接固定单一客户端', () => {
    const result = serverRecoveryConfig(['--inspect'], { DATABASE_URL: database });
    expect(result.target).toBe(target);
    expect(result.target).not.toContain('private-value');
    expect(new URL(result.databaseUrl).searchParams.get('connection_limit')).toBe('1');
  });

  it('应用必须同时明确目标、停服窗口、操作者、原因和备份引用', () => {
    expect(serverRecoveryConfig(['--apply'], applyEnvironment).mode).toBe('apply');
    for (const key of [
      'DATABASE_URL',
      'SERVER_RECOVERY_CONFIRM',
      'SERVER_RECOVERY_MAINTENANCE',
      'SERVER_RECOVERY_OPERATOR',
      'SERVER_RECOVERY_REASON',
      'SERVER_RECOVERY_BACKUP_REFERENCE',
    ]) {
      expect(() => serverRecoveryConfig(['--apply'], { ...applyEnvironment, [key]: undefined }), key).toThrow();
    }
    expect(() =>
      serverRecoveryConfig(['--apply'], { ...applyEnvironment, SERVER_RECOVERY_CONFIRM: 'another:5432/db' }),
    ).toThrow();
  });

  it('拒绝隐式模式、管理数据库、非public schema和附加连接行为', () => {
    for (const args of [[], ['--apply', '--inspect'], ['--force'], ['--apply', '--yes']]) {
      expect(() => serverRecoveryConfig(args, applyEnvironment)).toThrow();
    }
    for (const url of [
      'postgresql://sesame:private-value@127.0.0.1:5400/postgres',
      'postgresql://sesame:private-value@127.0.0.1:5400/template1',
      `${database}&options=-csearch_path%3Dother`,
      database.replace('schema=public', 'schema=private'),
      'https://127.0.0.1:5400/sesame_test_recovery',
    ])
      expect(() => serverRecoveryConfig(['--inspect'], { DATABASE_URL: url })).toThrow();
  });
});
