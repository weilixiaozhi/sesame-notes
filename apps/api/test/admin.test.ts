import { testFixtureDatabaseUrl } from './existing-test-database.js';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { WebSocket } from 'ws';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { hashAdminPassword } from '../src/modules/admin/index.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';
const ADMIN_ORIGIN = 'https://admin.example.test';
const ADMIN_PASSWORD = 'Dg7!mR2#vS9@cK4%pQ6+xZ8';
const USER_PASSWORD = 'Hx6!eB9@vR2#kT8$qW4%mJ7';
const createdAdminIds: string[] = [];

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'admin-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: '.e2e-storage',
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  adminOrigins: [ADMIN_ORIGIN],
  adminSessionTtlSeconds: 28_800,
  adminSessionIdleTtlSeconds: 1800,
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;

function uuid(): string {
  return randomUUID();
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function api(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  body?: Record<string, unknown>,
  credentials?: { token: string } | { cookie: string },
) {
  const response = await app.inject({
    method,
    url: `${API_BASE}${path}`,
    payload: body,
    headers: {
      ...(credentials && 'token' in credentials ? bearer(credentials.token) : {}),
      ...(credentials && 'cookie' in credentials ? { cookie: credentials.cookie } : {}),
      ...(path.startsWith('/admin/') && method !== 'get' ? { origin: ADMIN_ORIGIN, 'x-admin-request': '1' } : {}),
      ...(method === 'post' && body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return {
    status: response.statusCode,
    json: (): unknown => (response.body ? JSON.parse(response.body) : null),
    body: response.body,
  };
}

/** 生成每次调用唯一且可登录的手机号（+86 区号，11 位） */
function uniquePhone(): string {
  return `138${randomInt(100_000_000).toString().padStart(8, '0')}`;
}

/** 通过实际注册入口建立独立用户身份，返回账号和会话验证需要的资料。 */
async function registerUser(): Promise<{
  token: string;
  deviceId: string;
  userId: string;
  phone: string;
  refreshToken: string;
}> {
  const phone = uniquePhone();
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone,
    password: USER_PASSWORD,
    device: { installation_id: uuid(), name: 'e2e-device', platform: 'e2e' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as {
    access_token: string;
    refresh_token: string;
    device_id: string;
    user: { user_id: string };
  };
  return {
    token: session.access_token,
    refreshToken: session.refresh_token,
    deviceId: session.device_id,
    userId: session.user.user_id,
    phone,
  };
}

/** 后台身份从独立账号表和真实登录取得，不借用普通用户或其 JWT。 */
async function registerAdmin(capability: 'writer' | 'reader' = 'writer', id = uuid()) {
  const username = `admin_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const admin = await prisma.adminAccount.create({
    data: {
      id,
      username,
      displayName: '管理域集成测试',
      passwordHash: await hashAdminPassword(ADMIN_PASSWORD),
      identityType: 'standard_user',
      group: {
        create: {
          name: `业务测试组_${id}`,
          permissions:
            capability === 'writer'
              ? ['users:read', 'users:write', 'devices:read', 'devices:revoke', 'status:read']
              : ['users:read', 'audit:read', 'status:read'],
          pageIds: capability === 'writer' ? ['users'] : ['users', 'audit'],
        },
      },
    },
  });
  createdAdminIds.push(admin.id);
  const response = await app.inject({
    method: 'POST',
    url: `${API_BASE}/admin/auth/login`,
    headers: { origin: ADMIN_ORIGIN, 'x-admin-request': '1' },
    payload: { username, password: ADMIN_PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const cookies = response.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : [cookies]).find((value) =>
    value?.startsWith('__Secure-sesame_admin_session='),
  );
  expect(cookie).toBeDefined();
  return { id: admin.id, username, cookie: cookie!.split(';')[0]! };
}

/** 使用真实取票与握手建立实时连接，等 ready 后再执行撤销操作。 */
async function connectRealtime(token: string): Promise<WebSocket> {
  let socket: WebSocket | undefined;
  try {
    const issued = await app.inject({ method: 'POST', url: `${API_BASE}/ws/ticket`, headers: bearer(token) });
    expect(issued.statusCode).toBe(200);
    let ready: Promise<unknown[]> | undefined;
    socket = await app.injectWS(
      `${API_BASE}/ws?ticket=${issued.json().ticket}`,
      {},
      {
        onInit: (connection) => {
          ready = once(connection, 'message', { signal: AbortSignal.timeout(5000) });
        },
      },
    );
    await ready;
    return socket;
  } catch (error) {
    socket?.terminate();
    throw new Error('实时撤销测试连接建立失败', { cause: error });
  }
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await prisma.adminAccount.deleteMany({ where: { id: { in: createdAdminIds } } });
  await app.close();
});

describe('管理员域', () => {
  it('用户搜索在相邻页保持过滤条件与总数，记录不重不漏', async () => {
    try {
      const admin = await registerAdmin();
      const marker = randomInt(1000000, 9999999).toString();
      const ids = Array.from({ length: 25 }, () => uuid());
      const now = Date.now();
      await prisma.user.createMany({
        data: ids.map((id, index) => ({
          id,
          phoneE164: `+${index % 2 === 0 ? '991' : '992'}${marker}${index}`,
          sesameNumber: randomInt(100000000, 1000000000).toString(),
          passwordHash: 'pagination-fixture',
          createdAt: new Date(now + index),
        })),
      });
      const received: string[] = [];
      for (let page = 1; page <= 2; page++) {
        const query = new URLSearchParams({ page: String(page), page_size: '10', search: `+991${marker}` });
        const result = await api('get', `/admin/users?${query}`, undefined, admin);
        expect(result.status, result.body).toBe(200);
        const body = result.json() as { items: Array<{ id: string }>; page: number; total: number };
        expect(body).toMatchObject({ page, total: 13 });
        expect(body).not.toHaveProperty('next_cursor');
        received.push(...body.items.map((item) => item.id));
      }
      expect(received).toEqual(ids.filter((_, index) => index % 2 === 0).reverse());
    } catch (cause) {
      throw new Error('管理员搜索分页往返失败', { cause });
    }
  });

  it('用户游标分页参数返回明确400', async () => {
    const admin = await registerAdmin();
    const cursor = Buffer.from(JSON.stringify({ v: 1, c: new Date().toISOString(), i: 'not-a-uuid' })).toString(
      'base64url',
    );
    const result = await api('get', `/admin/users?cursor=${cursor}`, undefined, admin);
    expect(result.status).toBe(400);
    expect(result.json()).toMatchObject({ code: 'ADMIN_PAGINATION_INVALID' });
  });

  it.each(['disable', 'admin-device', 'own-device'] as const)(
    '%s 提交后立即关闭目标连接且保留其他账号连接',
    async (operation) => {
      const target = await registerUser();
      const other = await registerUser();
      const admin = await registerAdmin();
      const sockets: WebSocket[] = [];
      try {
        const targetSocket = await connectRealtime(target.token);
        sockets.push(targetSocket);
        const otherSocket = await connectRealtime(other.token);
        sockets.push(otherSocket);
        const closed = once(targetSocket, 'close', { signal: AbortSignal.timeout(5000) });
        const response =
          operation === 'disable'
            ? await api('patch', `/admin/users/${target.userId}/disable`, { reason: '设备安全验证' }, admin)
            : operation === 'admin-device'
              ? await api(
                  'post',
                  `/admin/users/${target.userId}/devices/${target.deviceId}/revoke`,
                  { reason: '设备安全验证' },
                  admin,
                )
              : await api('delete', `/devices/${target.deviceId}`, undefined, target);
        expect(response.status).toBe(operation === 'disable' ? 200 : 204);
        expect((await closed)[0]).toBe(1008);
        expect(otherSocket.readyState).toBe(otherSocket.OPEN);
      } finally {
        for (const socket of sockets) socket.terminate();
      }
    },
  );

  it('普通用户 JWT 访问管理接口返回 401 ADMIN_UNAUTHORIZED', async () => {
    const { token } = await registerUser();
    for (const path of ['/admin/users', '/admin/status', '/admin/audit-logs']) {
      const res = await api('get', path, undefined, { token });
      expect(res.status).toBe(401);
      expect((res.json() as { code: string }).code).toBe('ADMIN_UNAUTHORIZED');
    }
    const patchRes = await api('patch', `/admin/users/${uuid()}/disable`, { reason: '权限验证' }, { token });
    expect(patchRes.status).toBe(401);
    const delRes = await api(
      'post',
      `/admin/users/${uuid()}/devices/${uuid()}/revoke`,
      { reason: '权限验证' },
      { token },
    );
    expect(delRes.status).toBe(401);
  });

  it('管理员可列出用户（含目标用户与禁用状态）', async () => {
    const target = await registerUser();
    const admin = await registerAdmin();
    const res = await api('get', `/admin/users?search=${target.phone}`, undefined, admin);
    expect(res.status).toBe(200);
    const body = res.json() as { items: Array<{ id: string; phone_masked: string | null; is_enabled: boolean }> };
    const found = body.items.find((user) => user.id === target.userId);
    expect(found).toBeTruthy();
    expect(found!.is_enabled).toBe(true);
  });

  it('禁用用户后登录与刷新立即失效，启用后恢复', async () => {
    const target = await registerUser();
    const admin = await registerAdmin();

    const disableRes = await api('patch', `/admin/users/${target.userId}/disable`, { reason: '用户申请停用' }, admin);
    expect(disableRes.status).toBe(200);
    expect((disableRes.json() as { is_enabled: boolean }).is_enabled).toBe(false);

    const loginAfterDisable = await api('post', '/auth/login', {
      country_code: '+86',
      phone: target.phone,
      password: USER_PASSWORD,
      device: { installation_id: uuid(), name: 'd', platform: 'd' },
    });
    expect(loginAfterDisable.status).toBe(401);

    const refreshAfterDisable = await api('post', '/auth/refresh', { refresh_token: target.refreshToken });
    expect(refreshAfterDisable.status).toBe(401);

    const enableRes = await api('patch', `/admin/users/${target.userId}/enable`, { reason: '用户申请启用' }, admin);
    expect(enableRes.status).toBe(200);
    expect((enableRes.json() as { is_enabled: boolean }).is_enabled).toBe(true);

    const loginAfterEnable = await api('post', '/auth/login', {
      country_code: '+86',
      phone: target.phone,
      password: USER_PASSWORD,
      device: { installation_id: uuid(), name: 'd', platform: 'd' },
    });
    expect(loginAfterEnable.status).toBe(200);
  });

  it('吊销设备后该设备刷新令牌立即失效', async () => {
    const target = await registerUser();
    const admin = await registerAdmin();

    const delRes = await api(
      'post',
      `/admin/users/${target.userId}/devices/${target.deviceId}/revoke`,
      { reason: '设备遗失' },
      admin,
    );
    expect(delRes.status).toBe(204);

    const refreshAfterRevoke = await api('post', '/auth/refresh', { refresh_token: target.refreshToken });
    expect(refreshAfterRevoke.status).toBe(401);
  });

  it('管理员与用户即使 UUID 相同，禁用业务用户也不会禁用后台身份', async () => {
    const user = await registerUser();
    const admin = await registerAdmin('writer', user.userId);
    const res = await api('patch', `/admin/users/${user.userId}/disable`, { reason: '用户申请停用' }, admin);
    expect(res.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.userId } })).isEnabled).toBe(false);
    expect((await prisma.adminAccount.findUniqueOrThrow({ where: { id: admin.id } })).isEnabled).toBe(true);
    expect((await api('get', '/admin/status', undefined, admin)).status).toBe(200);
  });

  it('系统状态返回用户/账本/设备等计数', async () => {
    const admin = await registerAdmin();
    const res = await api('get', '/admin/status', undefined, admin);
    expect(res.status).toBe(200);
    const body = res.json() as {
      users: { total: number; enabled: number };
      admins: { total: number; enabled: number };
    };
    expect(body.users.total).toBeGreaterThanOrEqual(1);
    expect(body.users.enabled).toBeGreaterThanOrEqual(1);
    expect(body.users).not.toHaveProperty('admins');
    expect(body.admins.total).toBeGreaterThanOrEqual(1);
    expect(body.admins.enabled).toBeGreaterThanOrEqual(1);
  });

  it('审计日志记录管理操作并可按动作过滤', async () => {
    const target = await registerUser();
    const admin = await registerAdmin();
    const auditor = await registerAdmin('reader');

    await api('patch', `/admin/users/${target.userId}/disable`, { reason: '用户申请停用' }, admin);

    const res = await api('get', '/admin/audit-logs?action=user.disable', undefined, auditor);
    expect(res.status).toBe(200);
    const body = res.json() as { items: Array<{ actor_display: string; action_label: string }> };
    const entry = body.items.find((item) => item.actor_display === admin.username);
    expect(entry).toBeTruthy();
    expect(entry!.action_label).toBe('禁用应用用户');
    for (const field of ['actor', 'action', 'target', 'request_id']) expect(entry).not.toHaveProperty(field);
  });

  it.each(['limit=10', 'cursor=1'])('审计游标分页参数 %s 返回 400，且不查询审计表', async (querystring) => {
    const query = vi.spyOn(prisma.auditLog, 'findMany');
    const rawQuery = vi.spyOn(prisma, '$queryRaw');
    try {
      const admin = await registerAdmin('reader');
      const response = await api('get', `/admin/audit-logs?${querystring}`, undefined, admin);
      expect(response.status).toBe(400);
      expect(response.json()).toMatchObject({ code: 'ADMIN_PAGINATION_INVALID' });
      expect(query).not.toHaveBeenCalled();
      // 安全锁不属于业务读取，分页校验失败不能触发审计表 SELECT。
      const auditReads = rawQuery.mock.calls.filter(([statement]) => {
        const text = 'sql' in statement ? statement.sql : statement.join('');
        return /\bselect\b/i.test(text) && /\baudit_logs\b/i.test(text);
      });
      expect(auditReads).toHaveLength(0);
    } catch (cause) {
      throw new Error('非法审计游标拒绝验证失败', { cause });
    } finally {
      query.mockRestore();
      rawQuery.mockRestore();
    }
  });
});
