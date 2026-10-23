// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testEnvironment } from './environment';
import { jwtExpiryMs } from './token-expiry';

const runId = '0123456789abcdef0123456789abcdef';
const confirmedTestApiOrigin = 'http://10.20.30.40:8080';
const artifacts = resolve(import.meta.dirname, '../../../Temp', `web-e2e-${runId}`);
const existing: NodeJS.ProcessEnv = {
  WEB_E2E_MODE: 'existing-backend',
  WEB_E2E_RUN_ID: runId,
  WEB_E2E_ARTIFACTS: artifacts,
  WEB_E2E_BASE_URL: 'http://127.0.0.1:4173',
  WEB_E2E_EXISTING_WEB_ORIGIN: 'http://127.0.0.1:4173',
  WEB_API_TARGET: confirmedTestApiOrigin,
  WEB_E2E_EXISTING_API_ORIGIN: confirmedTestApiOrigin,
  WEB_E2E_EXISTING_BACKEND_CONFIRMED: 'true',
  WEB_E2E_EXPECTED_API_ORIGIN: confirmedTestApiOrigin,
  WEB_E2E_EXPECTED_WEB_ORIGIN: 'http://127.0.0.1:4173',
};
const database = `postgresql://fixture:fixture@127.0.0.1:32001/web_e2e_${runId}`;
const isolated: NodeJS.ProcessEnv = {
  WEB_E2E_RUN_ID: runId,
  WEB_E2E_ARTIFACTS: artifacts,
  WEB_E2E_BASE_URL: 'http://127.0.0.2:32002',
  WEB_API_TARGET: 'http://127.0.0.1:32003',
  DATABASE_URL: database,
  E2E_DATABASE_URL: database,
};

describe('真实 E2E 目标边界', () => {
  it('既有模式只消费已确认 HTTP 目标，完全不读取数据库变量', () => {
    const env = new Proxy(existing, {
      get(target, key) {
        if (String(key).includes('DATABASE')) throw new Error('禁止读取 DB 配置');
        return target[String(key)];
      },
    });
    expect(testEnvironment(env)).toMatchObject({ mode: 'existing-backend', apiOrigin: confirmedTestApiOrigin });
  });
  it.each([
    { WEB_API_TARGET: 'https://api.example.com' },
    { WEB_E2E_EXISTING_BACKEND_CONFIRMED: '' },
    { WEB_E2E_EXPECTED_API_ORIGIN: '' },
    { WEB_E2E_EXPECTED_API_ORIGIN: 'http://10.20.30.41:8080' },
    { WEB_E2E_EXPECTED_WEB_ORIGIN: '' },
    { WEB_E2E_EXISTING_API_ORIGIN: '' },
    { WEB_API_TARGET: `${confirmedTestApiOrigin}/` },
    { WEB_E2E_BASE_URL: 'http://10.20.30.40:4173', WEB_E2E_EXISTING_WEB_ORIGIN: 'http://10.20.30.40:4173' },
    { WEB_E2E_BASE_URL: 'http://10.20.30.41:4173', WEB_E2E_EXISTING_WEB_ORIGIN: 'http://10.20.30.41:4173' },
    { WEB_E2E_BASE_URL: 'http://127.0.0.1:5173', WEB_E2E_EXISTING_WEB_ORIGIN: 'http://127.0.0.1:5173' },
    { WEB_E2E_BASE_URL: 'http://secret@127.0.0.1:4173' },
    { WEB_E2E_BASE_URL: 'http://127.0.0.1:4173/other' },
    { WEB_E2E_EXISTING_WEB_ORIGIN: 'http://10.20.30.40:4173' },
    { WEB_E2E_MODE: 'development' },
    { WEB_E2E_RUN_ID: '' },
    { WEB_E2E_ARTIFACTS: resolve(artifacts, '..') },
  ])('拒绝未确认目标、模式或归属不明的产物目录 %j', (override) => {
    expect(() => testEnvironment({ ...existing, ...override })).toThrow();
  });
  it('保留原隔离模式的随机数据库名、回环端口和连接一致性校验', () => {
    expect(testEnvironment(isolated).mode).toBe('isolated');
    for (const override of [
      { DATABASE_URL: '' },
      {
        DATABASE_URL: database.replace(`web_e2e_${runId}`, 'sesame_notes'),
        E2E_DATABASE_URL: database.replace(`web_e2e_${runId}`, 'sesame_notes'),
      },
      {
        DATABASE_URL: database.replace('127.0.0.1', '10.20.30.40'),
        E2E_DATABASE_URL: database.replace('127.0.0.1', '10.20.30.40'),
      },
      { WEB_API_TARGET: confirmedTestApiOrigin },
    ])
      expect(() => testEnvironment({ ...isolated, ...override })).toThrow();
  });
  it.each(['http://203.0.113.10:8080', 'http://api.example.com:8080', 'http://10.20.30.40:8080/?secret=1'])(
    '即使所有确认参数一致，也拒绝不安全既有目标 %s',
    (origin) => {
      expect(() =>
        testEnvironment({
          ...existing,
          WEB_API_TARGET: origin,
          WEB_E2E_EXISTING_API_ORIGIN: origin,
          WEB_E2E_EXPECTED_API_ORIGIN: origin,
        }),
      ).toThrow();
    },
  );
  it('既有 Web 可以使用本地配置的其他可信回环端口', () => {
    const origin = 'http://localhost:45173';
    expect(
      testEnvironment({
        ...existing,
        WEB_E2E_BASE_URL: origin,
        WEB_E2E_EXISTING_WEB_ORIGIN: origin,
        WEB_E2E_EXPECTED_WEB_ORIGIN: origin,
      }).webOrigin,
    ).toBe(origin);
  });
});

describe('实际签发令牌的到期信息', () => {
  const token = (payload: unknown) => `test.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test`;
  it('按服务端 NumericDate 读取，兼容不同 TTL 而不是写死8秒', () => {
    expect(jwtExpiryMs(token({ exp: 1_790_913_900 }))).toBe(1_790_913_900_000);
  });
  it.each([
    null,
    '',
    'bad',
    'a.bad.c',
    token({}),
    token(null),
    token({ exp: '900' }),
    token({ exp: -1 }),
    token({ exp: 1.5 }),
    token({ exp: Number.MAX_SAFE_INTEGER }),
  ])('拒绝缺失或不可用的到期信息 %j', (input) => {
    expect(() => jwtExpiryMs(input)).toThrow();
  });
});
