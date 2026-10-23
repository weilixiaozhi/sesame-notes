import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const origin = 'http://localhost:5173';
const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'device-metadata-fixture-secret-at-least-32-bytes',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: fileURLToPath(new URL('../../../Temp/device-metadata-fixtures/', import.meta.url)),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [origin],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};
let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;
const ownedUsers: string[] = [];
type Session = { refresh_token: string; device_id: string; user: { user_id: string } };

/** 每个夹具使用独立安装和手机号，只追踪本文件创建的账号用于精确清理。 */
async function registerFixture(browser = false) {
  try {
    const installation = randomUUID();
    const phone = `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
    const credentials = { country_code: '+86', phone, password: 'metadata-test-password' };
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/auth${browser ? '/browser' : ''}/register`,
      headers: browser ? { origin } : {},
      payload: {
        ...credentials,
        device: {
          installation_id: installation,
          name: 'device-metadata-fixture',
          platform: browser ? 'web' : 'flutter',
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const session = response.json<Session>();
    ownedUsers.push(session.user.user_id);
    return { session, installation, credentials, cookie: response.cookies[0] };
  } catch (cause) {
    throw new Error('设备资料测试夹具创建失败', { cause });
  }
}

/** 刷新正文不携带设备身份，服务端必须从已有刷新凭据确定更新目标。 */
async function refresh(token: string, device?: unknown) {
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: token, ...(device ? { device } : {}) },
    });
    expect(response.statusCode).toBe(200);
    return response.json<Session>();
  } catch (cause) {
    throw new Error('设备资料刷新测试失败', { cause });
  }
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  try {
    // 仅删除该文件通过注册响应确认的夹具账号，保留共享测试库中的其他记录。
    if (ownedUsers.length) await prisma.user.deleteMany({ where: { id: { in: ownedUsers } } });
  } finally {
    await app.close();
  }
});

describe('真实设备资料认证链路', () => {
  it('旧设备在刷新时补齐资料，安装和账号归属保持一致，夹具初始资料为空', async () => {
    const fixture = await registerFixture();
    const before = await prisma.device.findUniqueOrThrow({ where: { id: fixture.session.device_id } });
    expect([before.appVersion, before.osVersion, before.deviceModel]).toEqual([null, null, null]);
    const updated = await refresh(fixture.session.refresh_token, {
      platform: 'android',
      app_version: '1.4.6+24',
      os_version: 'Android 16 (API 36)',
      device_model: 'test-system-model',
    });
    expect(updated.device_id).toBe(fixture.session.device_id);
    const device = await prisma.device.findUniqueOrThrow({ where: { id: updated.device_id } });
    expect(device).toMatchObject({
      userId: fixture.session.user.user_id,
      installationId: fixture.installation,
      name: before.name,
      platform: 'android',
      appVersion: '1.4.6+24',
      osVersion: 'Android 16 (API 36)',
      deviceModel: 'test-system-model',
    });
  });

  it('已有设备再次登录更新真实版本，后续空值和无资料刷新保留已有值', async () => {
    const fixture = await registerFixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        ...fixture.credentials,
        device: {
          installation_id: fixture.installation,
          name: 'device-metadata-fixture',
          platform: 'ios',
          app_version: '1.5.0+25',
          os_version: 'iOS 26.0',
          device_model: 'test-machine-code',
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const login = response.json<Session>();
    expect(login.device_id).toBe(fixture.session.device_id);
    const blank = await refresh(login.refresh_token, {
      platform: ' ',
      app_version: '',
      os_version: '\t',
      device_model: '  ',
    });
    await refresh(blank.refresh_token);
    expect(await prisma.device.findUniqueOrThrow({ where: { id: login.device_id } })).toMatchObject({
      platform: 'ios',
      appVersion: '1.5.0+25',
      osVersion: 'iOS 26.0',
      deviceModel: 'test-machine-code',
    });
  });

  it('伪造设备和安装字段不能修改另一账号设备或转移当前安装', async () => {
    const owner = await registerFixture();
    const other = await registerFixture();
    const updated = await refresh(owner.session.refresh_token, {
      platform: 'android',
      device_model: 'current-session-model',
      device_id: other.session.device_id,
      installation_id: other.installation,
      user_id: other.session.user.user_id,
    });
    expect(updated.device_id).toBe(owner.session.device_id);
    const current = await prisma.device.findUniqueOrThrow({ where: { id: owner.session.device_id } });
    expect(current).toMatchObject({
      userId: owner.session.user.user_id,
      installationId: owner.installation,
      deviceModel: 'current-session-model',
    });
    expect(await prisma.device.findUniqueOrThrow({ where: { id: other.session.device_id } })).toMatchObject({
      userId: other.session.user.user_id,
      installationId: other.installation,
      platform: 'flutter',
      deviceModel: null,
    });
  });

  it('旧请求的任意device内容保持兼容，非法字段不能清空已有资料', async () => {
    const fixture = await registerFixture();
    let session = await refresh(fixture.session.refresh_token, {
      platform: 'android',
      device_model: 'known-system-model',
    });
    for (const legacy of [
      'legacy-client-field',
      123,
      [],
      { platform: 123, device_model: 'x'.repeat(129), os_version: false },
    ]) {
      session = await refresh(session.refresh_token, legacy);
    }
    expect(await prisma.device.findUniqueOrThrow({ where: { id: session.device_id } })).toMatchObject({
      platform: 'android',
      deviceModel: 'known-system-model',
      osVersion: null,
    });
  });

  it('浏览器刷新可补实际已知资料，缺失型号保持为空，仍使用Cookie确定设备', async () => {
    const fixture = await registerFixture(true);
    expect(fixture.cookie).toBeDefined();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/browser/refresh',
      headers: { origin, cookie: `${fixture.cookie!.name}=${fixture.cookie!.value}` },
      payload: { device: { platform: 'web', app_version: '1.4.6' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ device_id: string }>().device_id).toBe(fixture.session.device_id);
    expect(await prisma.device.findUniqueOrThrow({ where: { id: fixture.session.device_id } })).toMatchObject({
      platform: 'web',
      appVersion: '1.4.6',
      osVersion: null,
      deviceModel: null,
    });
    expect(response.json()).not.toHaveProperty('refresh_token');
  });
});
