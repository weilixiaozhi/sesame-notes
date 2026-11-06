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
});
