import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { dummyPasswordHash } from '../src/modules/auth/testing.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: '.e2e-storage',
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

/** 生成每次调用唯一且可登录的手机号（+86 区号，11 位） */
function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function api(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
  token?: string,
) {
  const response = await app.inject({
    method,
    url: `${API_BASE}${path}`,
    payload: body,
    headers: {
      ...(token ? bearer(token) : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return {
    status: response.statusCode,
    json: (): unknown => (response.body ? JSON.parse(response.body) : null),
    body: response.body,
  };
}

async function registerUser(): Promise<{ token: string; deviceId: string; userId: string; phone: string }> {
  const phone = uniquePhone();
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone,
    password: 'password-123456',
    device: { installation_id: randomUUID(), name: 'e2e-device', platform: 'e2e' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as { access_token: string; device_id: string; user: { user_id: string } };
  return { token: session.access_token, deviceId: session.device_id, userId: session.user.user_id, phone };
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('切片二：设备、会话与登录防枚举（需求锚点）', () => {
  it('同一 installation 在 A/B 两个账号登录都成功，且返回不同 device id', async () => {
    const installationId = randomUUID();
    const phoneA = uniquePhone();
    const phoneB = uniquePhone();
    const regA = await api('post', '/auth/register', {
      country_code: '+86',
      phone: phoneA,
      password: 'password-123456',
      device: { installation_id: installationId, name: 'e2e', platform: 'e2e' },
    });
    expect(regA.status).toBe(201);
    const deviceA = (regA.json() as { device_id: string }).device_id;

    const regB = await api('post', '/auth/register', {
      country_code: '+86',
      phone: phoneB,
      password: 'password-123456',
      device: { installation_id: installationId, name: 'e2e', platform: 'e2e' },
    });
    expect(regB.status).toBe(201);
    const deviceB = (regB.json() as { device_id: string }).device_id;

    // 同一安装在不同账号下拥有各自的服务端 device，互不冲突
    expect(deviceA).not.toBe(deviceB);
    const rows = await prisma.device.findMany({
      where: { installationId },
      select: { id: true, userId: true },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('同账号同 installation 复用同一 device id', async () => {
    const installationId = randomUUID();
    const phone = uniquePhone();
    const reg = await api('post', '/auth/register', {
      country_code: '+86',
      phone,
      password: 'password-123456',
      device: { installation_id: installationId, name: 'e2e', platform: 'e2e' },
    });
    expect(reg.status).toBe(201);
    const first = (reg.json() as { device_id: string }).device_id;
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(installationId);
    const login = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password: 'password-123456',
      device: { installation_id: installationId, name: 'e2e', platform: 'e2e' },
    });
    expect(login.status).toBe(200);
    expect((login.json() as { device_id: string }).device_id).toBe(first);
    expect(await prisma.device.count({ where: { installationId } })).toBe(1);
  });

  it('不存在手机号、禁用账号与错误密码返回完全一致的响应（防枚举）', async () => {
    const phone = uniquePhone();
    const password = 'password-123456';
    // 先注册一个真实账号再禁用
    await api('post', '/auth/register', {
      country_code: '+86',
      phone,
      password,
      device: { installation_id: randomUUID(), name: 'e2e', platform: 'e2e' },
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { phoneE164: `+86${phone}` } });
    await prisma.user.update({ where: { id: row.id }, data: { isEnabled: false } });

    const device = { installation_id: randomUUID(), name: 'e2e', platform: 'e2e' };
    const [missing, disabled, wrongPw] = await Promise.all([
      api('post', '/auth/login', { country_code: '+86', phone: uniquePhone(), password, device }),
      api('post', '/auth/login', { country_code: '+86', phone, password, device }),
      api('post', '/auth/login', { country_code: '+86', phone, password: 'wrong-password', device }),
    ]);
    for (const response of [missing, disabled, wrongPw]) {
      expect(response.status).toBe(401);
      const body = response.json() as { code: string; message: string };
      expect(body.code).toBe('INVALID_CREDENTIALS');
      expect(body.message).toBe('手机号或密码错误');
    }
  });

  it('dummy scrypt 哈希是合法格式且可被恒定时间校验（登录等成本路径）', async () => {
    const dummy = await dummyPasswordHash();
    // 格式与真实哈希完全一致：scrypt:salt:key
    const parts = dummy.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('scrypt');
    expect(Buffer.from(parts[1]!, 'base64url').length).toBe(16);
    expect(Buffer.from(parts[2]!, 'base64url').length).toBe(64);
    // 同一 dummy 值可重复验证且结果稳定（false），证明比较路径可执行
    const { verifyPassword } = await import('../src/modules/auth/testing.js');
    expect(await verifyPassword('任意密码', dummy)).toBe(false);
    expect(await verifyPassword('任意密码', dummy)).toBe(false);
  });

  it('JWT 载荷不包含手机号、account 占位与任何手机号派生信息', async () => {
    const { token, phone } = await registerUser();
    // 解码 JWT 载荷（不验签，只看声明内容）
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain('mobile:');
    expect(serialized).not.toContain('account');
    expect(payload.sub).toMatch(/^[0-9a-f-]{36}$/);
  });
});
