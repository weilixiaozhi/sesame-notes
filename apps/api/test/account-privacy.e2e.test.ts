import { accountingRequestFixturePath } from './accounting-request-fixture.js';
import { testStoragePath } from './test-storage-path.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { MAX_AVATAR_BYTES } from '../src/modules/accounts/testing.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('account-privacy'),
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
  method: 'get' | 'post' | 'patch' | 'delete' | 'put',
  path: string,
  body?: Record<string, unknown>,
  token?: string,
) {
  const response = await app.inject({
    method,
    url: await accountingRequestFixturePath(
      app,
      method,
      `${API_BASE}${path}`,
      token ? { authorization: `Bearer ${token}` } : {},
    ),
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

/** 最小合法 PNG（1×1 透明像素），仅用于头像链路的 MIME/体积行为验证 */
const MINI_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('切片三：共享资料隐私与头像授权（需求锚点）', () => {
  it('共享成员响应不含 account/phone/gender，包含 sesame_number', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ledgerId = randomUUID();
    const create = await api('post', '/ledgers', { id: ledgerId, name: '隐私账本' }, owner.token);
    expect(create.status).toBe(201);
    const invite = await api('post', `/ledgers/${ledgerId}/invites`, { role: 'editor' }, owner.token);
    const code = (invite.json() as { code: string }).code;
    await api('post', `/invites/${code}/accept`, {}, member.token);

    const members = await api('get', `/ledgers/${ledgerId}/members`, undefined, owner.token);
    expect(members.status).toBe(200);
    const list = members.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    for (const entry of list) {
      expect(Object.keys(entry)).not.toContain('account');
      expect(Object.keys(entry)).not.toContain('phone');
      expect(Object.keys(entry)).not.toContain('phone_e164');
      expect(Object.keys(entry)).not.toContain('gender');
      expect(entry.sesame_number).toMatch(/^[1-9]\d{8}$/);
    }
  });

  it('member-stats 响应不含 account，包含 sesame_number', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const ledgerId = randomUUID();
    const create = await api('post', '/ledgers', { id: ledgerId, name: '统计隐私' }, owner.token);
    expect(create.status).toBe(201);
    const invite = await api('post', `/ledgers/${ledgerId}/invites`, { role: 'editor' }, owner.token);
    const code = (invite.json() as { code: string }).code;
    await api('post', `/invites/${code}/accept`, {}, member.token);
    // member 记一笔支出，让统计项非空
    await api(
      'post',
      `/ledgers/${ledgerId}/transactions`,
      {
        id: randomUUID(),
        tx_type: 'expense',
        amount: '30',
        happened_at: '2026-08-19T10:00:00.000Z',
        currency_code: 'CNY',
        native_amount: '30',
      },
      member.token,
    );

    const stats = await api('get', `/ledgers/${ledgerId}/member-stats?scope=all`, undefined, owner.token);
    expect(stats.status).toBe(200);
    const items = (stats.json() as { items: Array<Record<string, unknown>> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item)).not.toContain('account');
      expect(Object.keys(item)).not.toContain('phone');
      expect(Object.keys(item)).not.toContain('gender');
      if (item.user_id) expect(item.sesame_number).toMatch(/^[1-9]\d{8}$/);
    }
  });

  it('头像授权三方矩阵：本人/共同账本成员可下载，陌生用户统一 404', async () => {
    const owner = await registerUser();
    const peer = await registerUser();
    const stranger = await registerUser();
    const ledgerId = randomUUID();
    const create = await api('post', '/ledgers', { id: ledgerId, name: '头像授权' }, owner.token);
    expect(create.status).toBe(201);
    const invite = await api('post', `/ledgers/${ledgerId}/invites`, { role: 'editor' }, owner.token);
    const code = (invite.json() as { code: string }).code;
    await api('post', `/invites/${code}/accept`, {}, peer.token);

    // owner 上传头像
    const upload = await api(
      'put',
      '/profile/avatar',
      { content_type: 'image/png', data_base64: MINI_PNG_BASE64 },
      owner.token,
    );
    expect(upload.status).toBe(200);

    // 本人下载 200
    const self = await api('get', `/profile/avatar/${owner.userId}`, undefined, owner.token);
    expect(self.status).toBe(200);
    // 共同账本 ACTIVE 成员下载 200
    const shared = await api('get', `/profile/avatar/${owner.userId}`, undefined, peer.token);
    expect(shared.status).toBe(200);
    // 陌生用户下载 404（与不存在头像同响应，防止用户枚举）
    const denied = await api('get', `/profile/avatar/${owner.userId}`, undefined, stranger.token);
    expect(denied.status).toBe(404);
    expect((denied.json() as { code: string }).code).toBe('AVATAR_NOT_FOUND');
    // 陌生用户访问不存在的用户头像也是 404（不可区分）
    const ghost = await api('get', `/profile/avatar/${randomUUID()}`, undefined, stranger.token);
    expect(ghost.status).toBe(404);
    // 唯一共同账本被删除后，成员行保留历史身份但不能继续授权头像读取。
    expect((await api('delete', `/ledgers/${ledgerId}`, undefined, owner.token)).status).toBe(204);
    expect((await api('get', `/profile/avatar/${owner.userId}`, undefined, peer.token)).status).toBe(404);
    expect((await api('get', `/profile/avatar/${owner.userId}`, undefined, owner.token)).status).toBe(200);
  });

  it('头像上传体积边界：原图超上限与请求体超路由上限均返回 413 AVATAR_TOO_LARGE', async () => {
    const { token } = await registerUser();
    // 原始字节超上限：解码前拒绝，错误码与用户文案固定
    const tooBigRaw = Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x01).toString('base64');
    const rawOver = await api('put', '/profile/avatar', { content_type: 'image/png', data_base64: tooBigRaw }, token);
    expect(rawOver.status).toBe(413);
    expect((rawOver.json() as { code: string }).code).toBe('AVATAR_TOO_LARGE');

    // 请求体超过路由 bodyLimit：Base64 开销后必然越界，Fastify 层拒绝并映射同一错误码
    const bodyOver = {
      content_type: 'image/png',
      data_base64: Buffer.alloc(MAX_AVATAR_BYTES * 2, 0x41).toString('base64'),
    };
    const hugeResponse = await app.inject({
      method: 'put',
      url: `${API_BASE}/profile/avatar`,
      payload: JSON.stringify(bodyOver),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    expect(hugeResponse.statusCode).toBe(413);
    const parsed = JSON.parse(hugeResponse.body) as { code: string };
    expect(parsed.code).toBe('AVATAR_TOO_LARGE');
  });
});
