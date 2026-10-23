import { testFixtureDatabaseUrl } from './existing-test-database.js';

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { decodeJwt, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DEFAULT_ADMIN_GROUP_ID,
  hashAdminPassword,
  lockAdminSecurity,
  verifyAdminPassword,
} from '../src/modules/admin/index.js';
import { loadTestApiConfig } from './test-api-config.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const ADMIN_ORIGIN = 'https://admin.example.test';
const COOKIE_NAME = '__Secure-sesame_admin_session';
const PASSWORD = 'Yv8!sR4@kD2#tL9$pN6%xC3';
const NEW_PASSWORD = 'Hq5!bM9@zF2#jW7$vK4%nD8';
const ABSOLUTE_TTL_SECONDS = 28_800;
const IDLE_TTL_SECONDS = 1800;
const createdAdminIds = new Set<string>();
const REASON = '核对后台身份及权限配置';

const createdGroupIds = new Set<string>();
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
type RequestOptions = {
  payload?: Record<string, unknown>;
  cookie?: string;
  token?: string;
  origin?: string | null;
  marker?: boolean;
  headers?: Record<string, string>;
};
let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;
let passwordHash: string;
let jwtSecret: string;

/** 请求真实路由；除针对 CSRF 的反例外，后台写请求显式携带来源与请求标记。 */
function api(method: Method, path: string, options: RequestOptions = {}) {
  const isAdmin = path.startsWith('/admin/');
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: {
      ...(isAdmin && options.origin !== null ? { origin: options.origin ?? ADMIN_ORIGIN } : {}),
      ...(isAdmin && method !== 'GET' && options.marker !== false ? { 'x-admin-request': '1' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(options.payload ? { payload: options.payload } : {}),
  });
}

function sessionCookie(response: Awaited<ReturnType<typeof api>>): string {
  const values = response.headers['set-cookie'];
  const cookie = (Array.isArray(values) ? values : [values]).find((value) => value?.startsWith(`${COOKIE_NAME}=`));
  expect(cookie).toBeDefined();
  return cookie!;
}

/** 每个用例精确清理自己创建的后台账号，避免超级管理员数量受到其它用例影响。 */
async function createAdmin(
  options: {
    id?: string;
    identityType?: 'super_admin' | 'standard_user';
    isEnabled?: boolean;
    groupId?: string;
    permissions?: string[];
    pageIds?: string[];
    usernamePrefix?: string;
  } = {},
) {
  const username = `${options.usernamePrefix ?? 'adm'}_${randomBytes(10).toString('hex')}`;
  const group =
    options.groupId !== undefined
      ? null
      : await prisma.adminGroup.create({
          data: {
            name: `测试_${username}`,
            permissions: options.permissions ?? [
              'users:read',
              'users:write',
              'devices:read',
              'devices:revoke',
              'audit:read',
              'status:read',
            ],
            pageIds: options.pageIds ?? ['users', 'audit'],
          },
        });
  if (group) createdGroupIds.add(group.id);
  const account = await prisma.adminAccount.create({
    data: {
      id: options.id ?? randomUUID(),
      username,
      displayName: '独立后台认证测试',
      passwordHash,
      identityType: options.identityType ?? 'standard_user',
      groupId: options.groupId === undefined ? group!.id : options.groupId,
      isEnabled: options.isEnabled ?? true,
    },
  });
  createdAdminIds.add(account.id);
  return account;
}

async function login(username: string, password = PASSWORD) {
  const response = await api('POST', '/admin/auth/login', { payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return { cookie: sessionCookie(response).split(';')[0]!, response };
}

async function registerUser() {
  const phone = `137${randomInt(100_000_000).toString().padStart(8, '0')}`;
  const response = await api('POST', '/auth/register', {
    payload: {
      country_code: '+86',
      phone,
      password: PASSWORD,
      device: { installation_id: randomUUID(), name: '身份隔离测试', platform: 'test' },
    },
  });
  expect(response.statusCode).toBe(201);
  const session = response.json<{
    access_token: string;
    refresh_token: string;
    device_id: string;
    user: { user_id: string };
  }>();
  return { phone, ...session };
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  const config = {
    ...loadTestApiConfig(),
    databaseUrl: DATABASE_URL,
    adminOrigins: [ADMIN_ORIGIN],
    adminSessionTtlSeconds: ABSOLUTE_TTL_SECONDS,
    adminSessionIdleTtlSeconds: IDLE_TTL_SECONDS,
    rateLimitMax: 10_000,
    authRateLimitMax: 10_000,
  };
  jwtSecret = config.jwtSecret;
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
  passwordHash = await hashAdminPassword(PASSWORD);
});

afterEach(async () => {
  if (prisma && createdAdminIds.size > 0) {
    await prisma.adminAccount.deleteMany({ where: { id: { in: [...createdAdminIds] } } });
    createdAdminIds.clear();
  }
  if (prisma && createdGroupIds.size > 0) {
    await prisma.adminGroup.deleteMany({ where: { id: { in: [...createdGroupIds] } } });
    createdGroupIds.clear();
  }
});

afterAll(async () => {
  if (app) await app.close();
  else if (prisma) await prisma.$disconnect();
});

describe('后台独立身份与不透明会话', () => {
  it('账号密码登录只签发安全 Cookie，数据库和响应均不保存或暴露原始会话令牌', async () => {
    const account = await createAdmin();
    const { cookie, response } = await login(account.username.toUpperCase());
    const header = sessionCookie(response);
    expect(header).toContain('Path=/api/v1/admin');
    expect(header).toMatch(/; HttpOnly(?:;|$)/i);
    expect(header).toMatch(/; Secure(?:;|$)/i);
    expect(header).toMatch(/; SameSite=Strict(?:;|$)/i);
    expect(header).not.toMatch(/; Domain=/i);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json()).toMatchObject({
      admin: { id: account.id, username: account.username, identity_type: 'standard_user' },
    });
    expect(response.json()).not.toHaveProperty('access_token');
    expect(response.json()).not.toHaveProperty('refresh_token');
    expect(response.body).not.toContain(PASSWORD);
    expect(response.body).not.toContain(passwordHash);
    const token = cookie.slice(`${COOKIE_NAME}=`.length);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).not.toContain('.');
    const sessions = await prisma.adminSession.findMany({ where: { adminId: account.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sessions)).not.toContain(token);
    expect(await prisma.user.findUnique({ where: { id: account.id } })).toBeNull();
    expect((await api('GET', '/admin/auth/me', { cookie })).json()).toMatchObject({ admin: { id: account.id } });
  });

  it('有效应用 JWT 携带伪造管理员声明，也不能访问任何受保护的后台接口', async () => {
    const user = await registerUser();
    const userClaims = decodeJwt<Record<string, unknown>>(user.access_token);
    const token = await new SignJWT({ ...userClaims, is_admin: true })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(new TextEncoder().encode(jwtSecret));
    const id = randomUUID();
    const routes: Array<[Method, string, Record<string, unknown>?]> = [
      ['GET', '/admin/auth/me'],
      ['POST', '/admin/auth/password', { old_password: PASSWORD, new_password: NEW_PASSWORD }],
      ['POST', '/admin/auth/logout'],
      ['GET', '/admin/users'],
      ['GET', '/admin/status'],
      ['GET', '/admin/audit-logs'],
      ['GET', '/admin/accounts'],
      [
        'POST',
        '/admin/accounts',
        {
          username: `denied_${randomBytes(6).toString('hex')}`,
          display_name: '不可授权',
          group_id: id,
          password: PASSWORD,
        },
      ],
      ['PATCH', `/admin/accounts/${id}`, { version: 1, is_enabled: false, reason: '访问验证' }],
      ['POST', `/admin/accounts/${id}/reset-password`, { version: 1, new_password: NEW_PASSWORD, reason: '访问验证' }],
      ['PATCH', `/admin/users/${user.user.user_id}/disable`, { reason: '访问验证' }],
      ['PATCH', `/admin/users/${user.user.user_id}/enable`, { reason: '访问验证' }],
      ['POST', `/admin/users/${user.user.user_id}/devices/${user.device_id}/revoke`, { reason: '访问验证' }],
    ];
    for (const [method, path, payload] of routes) {
      const response = await api(method, path, { token, payload });
      expect(response.statusCode, `${method} ${path}`).toBe(401);
      expect(response.json().code).toBe('ADMIN_UNAUTHORIZED');
    }
    expect((await api('GET', '/profile/me', { token })).statusCode).toBe(200);
    const ordinaryLogin = await api('POST', '/auth/login', {
      payload: {
        country_code: '+86',
        phone: user.phone,
        password: PASSWORD,
        device: { installation_id: randomUUID(), name: '旧标记验证', platform: 'test' },
      },
    });
    expect(ordinaryLogin.statusCode).toBe(200);
    expect(ordinaryLogin.json().user).not.toHaveProperty('is_admin');
  });

  it('同 UUID 的管理员与普通用户仍有各自认证和禁用状态', async () => {
    const user = await registerUser();
    const account = await createAdmin({ id: user.user.user_id });
    const root = await createAdmin({ identityType: 'super_admin' });
    const session = await login(account.username);
    const controller = await login(root.username);
    for (const path of ['/profile/me', '/devices', '/ledgers', '/sync/pull']) {
      expect((await api('GET', path, { cookie: session.cookie })).statusCode).toBe(401);
    }
    expect(
      (await api('GET', '/profile/me', { token: session.cookie.slice(`${COOKIE_NAME}=`.length) })).statusCode,
    ).toBe(401);
    const disabled = await api('PATCH', `/admin/accounts/${account.id}`, {
      cookie: controller.cookie,
      payload: { version: account.version, is_enabled: false, reason: '身份隔离验证' },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await api('GET', '/admin/auth/me', { cookie: session.cookie })).statusCode).toBe(401);
    expect((await api('GET', '/profile/me', { token: user.access_token })).statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.user.user_id } })).isEnabled).toBe(true);
  });

  it.each(['idle', 'absolute', 'revoked', 'disabled'] as const)('%s 失效状态立即拒绝后台 Cookie', async (state) => {
    const account = await createAdmin();
    const { cookie } = await login(account.username);
    if (state === 'disabled') {
      await prisma.adminAccount.update({ where: { id: account.id }, data: { isEnabled: false } });
    } else {
      await prisma.adminSession.updateMany({
        where: { adminId: account.id },
        data:
          state === 'idle'
            ? { lastSeenAt: new Date(Date.now() - (IDLE_TTL_SECONDS + 10) * 1000) }
            : state === 'absolute'
              ? { expiresAt: new Date(Date.now() - 10_000) }
              : { revokedAt: new Date() },
      });
    }
    const response = await api('GET', '/admin/auth/me', { cookie });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('ADMIN_UNAUTHORIZED');
  });

  it('活动请求更新闲置时间，同时保留首次登录确定的绝对过期时间', async () => {
    const account = await createAdmin();
    const { cookie } = await login(account.username);
    const session = await prisma.adminSession.findFirstOrThrow({ where: { adminId: account.id } });
    const oldLastSeen = new Date(Date.now() - 120_000);
    await prisma.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: oldLastSeen } });
    expect((await api('GET', '/admin/auth/me', { cookie })).statusCode).toBe(200);
    const touched = await prisma.adminSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(touched.lastSeenAt.getTime()).toBeGreaterThan(oldLastSeen.getTime());
    expect(touched.expiresAt).toEqual(session.expiresAt);
  });

  it('退出仅撤销当前后台会话，其它登录会话仍有效', async () => {
    const account = await createAdmin();
    const first = await login(account.username);
    const second = await login(account.username);
    expect(first.cookie).not.toBe(second.cookie);
    const response = await api('POST', '/admin/auth/logout', { cookie: first.cookie });
    expect(response.statusCode).toBe(204);
    expect(sessionCookie(response)).toMatch(/(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
    expect((await api('GET', '/admin/auth/me', { cookie: first.cookie })).statusCode).toBe(401);
    expect((await api('GET', '/admin/auth/me', { cookie: second.cookie })).statusCode).toBe(200);
    expect(await prisma.adminSession.count({ where: { adminId: account.id, revokedAt: null } })).toBe(1);
  });
});

describe('后台密码、来源和最小权限', () => {
  it('不存在、密码错误、已禁用和暂时锁定的账号返回相同凭据错误', async () => {
    const account = await createAdmin();
    const disabled = await createAdmin({ isEnabled: false });
    const locked = await createAdmin();
    await prisma.adminAccount.update({
      where: { id: locked.id },
      data: { lockedUntil: new Date(Date.now() + 60_000) },
    });
    const responses = [];
    for (const [username, password] of [
      [`missing_${randomBytes(6).toString('hex')}`, PASSWORD],
      [account.username, NEW_PASSWORD],
      [disabled.username, PASSWORD],
      [locked.username, PASSWORD],
    ]) {
      const response = await api('POST', '/admin/auth/login', { payload: { username, password } });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ code: string; message: string }>();
      responses.push({ code: body.code, message: body.message });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    for (const response of responses) expect(response).toEqual(responses[0]);
    expect(responses[0]!.code).toBe('INVALID_CREDENTIALS');
    expect(await prisma.adminSession.count({ where: { adminId: { in: [account.id, disabled.id, locked.id] } } })).toBe(
      0,
    );
  });

  it('第五次失败触发临时锁定，锁期结束重新计数，成功登录清除失败状态', async () => {
    const account = await createAdmin();
    await prisma.adminAccount.update({ where: { id: account.id }, data: { failedLoginAttempts: 4 } });
    const wrong = await api('POST', '/admin/auth/login', {
      payload: { username: account.username, password: NEW_PASSWORD },
    });
    expect(wrong.statusCode).toBe(401);
    const locked = await prisma.adminAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(locked.failedLoginAttempts).toBe(5);
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const correctWhileLocked = await api('POST', '/admin/auth/login', {
      payload: { username: account.username, password: PASSWORD },
    });
    expect(correctWhileLocked.statusCode).toBe(401);
    expect(correctWhileLocked.json().code).toBe('INVALID_CREDENTIALS');
    await prisma.adminAccount.update({ where: { id: account.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const firstAfterLock = await api('POST', '/admin/auth/login', {
      payload: { username: account.username, password: NEW_PASSWORD },
    });
    expect(firstAfterLock.statusCode).toBe(401);
    expect((await prisma.adminAccount.findUniqueOrThrow({ where: { id: account.id } })).failedLoginAttempts).toBe(1);
    await login(account.username);
    expect(await prisma.adminAccount.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
  });

  it('旧密码不正确的改密请求不会撤销现有会话', async () => {
    const account = await createAdmin();
    const { cookie } = await login(account.username);
    const response = await api('POST', '/admin/auth/password', {
      cookie,
      payload: { old_password: NEW_PASSWORD, new_password: PASSWORD },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('ADMIN_PASSWORD_MISMATCH');
    expect((await api('GET', '/admin/auth/me', { cookie })).statusCode).toBe(200);
    expect((await prisma.adminAccount.findUniqueOrThrow({ where: { id: account.id } })).passwordHash).toBe(
      passwordHash,
    );
  });

  it('创建后直接正常登录，主动改密会撤销所有旧会话', async () => {
    const account = await createAdmin();
    const first = await login(account.username);
    const second = await login(account.username);
    const me = await api('GET', '/admin/auth/me', { cookie: first.cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().admin).not.toHaveProperty('must_change_password');
    const restricted = await api('GET', '/admin/users', { cookie: first.cookie });
    expect(restricted.statusCode).toBe(200);
    const changed = await api('POST', '/admin/auth/password', {
      cookie: first.cookie,
      payload: { old_password: PASSWORD, new_password: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(204);
    expect(sessionCookie(changed)).toMatch(/(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
    for (const { cookie } of [first, second]) {
      expect((await api('GET', '/admin/auth/me', { cookie })).statusCode).toBe(401);
    }
    expect(
      (await api('POST', '/admin/auth/login', { payload: { username: account.username, password: PASSWORD } }))
        .statusCode,
    ).toBe(401);
    const replacement = await login(account.username, NEW_PASSWORD);
    expect(replacement.response.json().admin).not.toHaveProperty('must_change_password');
    expect((await api('GET', '/admin/users', { cookie: replacement.cookie })).statusCode).toBe(200);
    const stored = await prisma.adminAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(await verifyAdminPassword(NEW_PASSWORD, stored.passwordHash)).toBe(true);
    expect(await verifyAdminPassword(PASSWORD, stored.passwordHash)).toBe(false);
  });

  it.each(['x', '密'.repeat(513), '   ', PASSWORD])('非空密码均可保存且撤销现有会话：%j', async (newPassword) => {
    const account = await createAdmin();
    const { cookie } = await login(account.username);
    const response = await api('POST', '/admin/auth/password', {
      cookie,
      payload: { old_password: PASSWORD, new_password: newPassword },
    });
    expect(response.statusCode).toBe(204);
    expect((await api('GET', '/admin/auth/me', { cookie })).statusCode).toBe(401);
    const stored = await prisma.adminAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(await verifyAdminPassword(newPassword, stored.passwordHash)).toBe(true);
    await login(account.username, newPassword);
  });

  it.each([
    { label: '未知来源', options: { origin: 'https://attacker.example.test' } },
    { label: '来源后缀伪装', options: { origin: `${ADMIN_ORIGIN}.attacker.example.test` } },
    { label: 'null 来源', options: { origin: 'null' } },
    { label: 'Cookie 写请求缺来源', options: { origin: null } },
    { label: '缺少请求标记', options: { marker: false } },
  ])('$label 不能执行后台写操作', async ({ options }) => {
    const user = await registerUser();
    const account = await createAdmin();
    const { cookie } = await login(account.username);
    const response = await api('PATCH', `/admin/users/${user.user.user_id}/disable`, {
      cookie,
      payload: { reason: REASON },
      ...options,
    });
    expect(response.statusCode).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.user.user_id } })).isEnabled).toBe(true);
  });

  it('浏览器登录要求可信来源及标记；显式无浏览器来源信号的 CLI 可使用账号密码', async () => {
    const account = await createAdmin();
    const payload = { username: account.username, password: PASSWORD };
    for (const options of [
      { marker: false },
      { origin: 'https://attacker.example.test' },
      { origin: null, headers: { 'sec-fetch-site': 'same-origin' } },
    ]) {
      expect((await api('POST', '/admin/auth/login', { payload, ...options })).statusCode).toBe(403);
    }
    expect(await prisma.adminSession.count({ where: { adminId: account.id } })).toBe(0);
    const cli = await api('POST', '/admin/auth/login', { payload, origin: null });
    expect(cli.statusCode).toBe(200);
  });
});
describe('后台身份、单组授权与并发保护', () => {
  it('创建账号可选择组、默认普通身份，重置后直接登录且已删名称不能复用', async () => {
    const root = await createAdmin({ identityType: 'super_admin' });
    const { cookie } = await login(root.username);
    const username = `new_${randomBytes(10).toString('hex')}`;
    const payload = { username, password: NEW_PASSWORD, display_name: '新后台用户', group_id: root.groupId };
    const missing = await api('POST', '/admin/accounts', {
      cookie,
      payload: { username, password: PASSWORD, display_name: '无效组', group_id: randomUUID() },
    });
    expect(missing.statusCode).toBe(404);
    const created = await api('POST', '/admin/accounts', { cookie, payload });
    expect(created.statusCode, created.body).toBe(201);
    const account = created.json();
    createdAdminIds.add(account.id);
    expect(account).toMatchObject({
      identity_type: 'standard_user',
      group_id: root.groupId,
      created_by: root.username,
    });
    expect(created.body).not.toContain(NEW_PASSWORD);
    expect(account).not.toHaveProperty('role');
    const session = await login(username, NEW_PASSWORD);
    expect((await api('GET', '/admin/users', { cookie: session.cookie })).statusCode).toBe(200);
    const reset = await api('POST', `/admin/accounts/${account.id}/reset-password`, {
      cookie,
      payload: { version: 1, new_password: PASSWORD, reason: REASON },
    });
    expect(reset.statusCode, reset.body).toBe(204);
    expect((await api('GET', '/admin/auth/me', { cookie: session.cookie })).statusCode).toBe(401);
    await login(username);
    const deleted = await api('DELETE', `/admin/accounts/${account.id}`, {
      cookie,
      payload: { version: 2, reason: REASON },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect((await api('POST', '/admin/auth/login', { payload: { username, password: PASSWORD } })).statusCode).toBe(
      401,
    );
    const duplicate = await api('POST', '/admin/accounts', { cookie, payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('ADMIN_USERNAME_EXISTS');
    expect(
      (
        await api('POST', `/admin/accounts/${account.id}/reset-password`, {
          cookie,
          payload: { version: 3, new_password: PASSWORD, reason: REASON },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('普通身份无权维护账号、组或身份目录，即使伪造新增身份参数也无法提权', async () => {
    const account = await createAdmin();
    const { cookie } = await login(account.username);
    for (const path of ['/admin/accounts', '/admin/groups', '/admin/identity-types', '/admin/permission-catalog'])
      expect((await api('GET', path, { cookie })).statusCode).toBe(403);
    const identity = await api('PUT', `/admin/accounts/${account.id}/identity`, {
      cookie,
      payload: { version: 1, identity_type: 'super_admin', reason: REASON },
    });
    expect(identity.statusCode).toBe(403);
    expect((await prisma.adminAccount.findUniqueOrThrow({ where: { id: account.id } })).identityType).toBe(
      'standard_user',
    );
  });

  it('身份变化撤销会话，未知身份和资料编辑提权参数被拒绝', async () => {
    const root = await createAdmin({ identityType: 'super_admin' });
    const target = await createAdmin({ identityType: 'super_admin' });
    const controller = await login(root.username);
    const previous = await login(target.username);
    const unknown = await api('PUT', `/admin/accounts/${target.id}/identity`, {
      cookie: controller.cookie,
      payload: { version: 1, identity_type: 'invented', reason: REASON },
    });
    expect(unknown.statusCode).toBe(400);
    const changed = await api('PUT', `/admin/accounts/${target.id}/identity`, {
      cookie: controller.cookie,
      payload: { version: 1, identity_type: 'standard_user', reason: REASON },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await api('GET', '/admin/auth/me', { cookie: previous.cookie })).statusCode).toBe(401);
    const current = await login(target.username);
    expect((await api('GET', '/admin/accounts', { cookie: current.cookie })).statusCode).toBe(403);
    const injected = await api('PATCH', `/admin/accounts/${target.id}`, {
      cookie: controller.cookie,
      payload: { version: 2, identity_type: 'super_admin' },
    });
    expect(injected.statusCode).toBe(400);
  });

  it('最后超管不能自降级、自禁用或自删除，两个超管并发降级只提交一个', async () => {
    let existingAdmins: Array<{ id: string; isEnabled: boolean }> = [];
    let failure: unknown;
    try {
      const first = await createAdmin({ identityType: 'super_admin' });
      await prisma.$transaction(async (tx) => {
        await lockAdminSecurity(tx);
        // 最后超管是全库不变量；仅本用例期间隔离其他启用超管，并保存逐项恢复所需状态。
        const accounts = await tx.adminAccount.findMany({
          where: { id: { not: first.id }, identityType: 'super_admin', isEnabled: true, deletedAt: null },
          select: { id: true, isEnabled: true },
        });
        existingAdmins = accounts;
        if (accounts.length > 0)
          await tx.adminAccount.updateMany({
            where: { id: { in: accounts.map((account) => account.id) } },
            data: { isEnabled: false },
          });
      });
      const firstSession = await login(first.username);
      expect(
        (
          await api('PUT', `/admin/accounts/${first.id}/identity`, {
            cookie: firstSession.cookie,
            payload: { version: 1, identity_type: 'standard_user', reason: REASON },
          })
        ).json().code,
      ).toBe('LAST_SUPER_ADMIN');
      expect(
        (
          await api('PATCH', `/admin/accounts/${first.id}`, {
            cookie: firstSession.cookie,
            payload: { version: 1, is_enabled: false, reason: REASON },
          })
        ).json().code,
      ).toBe('CANNOT_DISABLE_SELF');
      expect(
        (
          await api('DELETE', `/admin/accounts/${first.id}`, {
            cookie: firstSession.cookie,
            payload: { version: 1, reason: REASON },
          })
        ).json().code,
      ).toBe('CANNOT_DELETE_SELF');
      const second = await createAdmin({ identityType: 'super_admin' });
      const secondSession = await login(second.username);
      const responses = await Promise.all([
        api('PUT', `/admin/accounts/${first.id}/identity`, {
          cookie: firstSession.cookie,
          payload: { version: 1, identity_type: 'standard_user', reason: REASON },
        }),
        api('PUT', `/admin/accounts/${second.id}/identity`, {
          cookie: secondSession.cookie,
          payload: { version: 1, identity_type: 'standard_user', reason: REASON },
        }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(
        await prisma.adminAccount.count({ where: { identityType: 'super_admin', isEnabled: true, deletedAt: null } }),
      ).toBe(1);
    } catch (cause) {
      failure = new Error('最后超管与并发身份保护验证失败', { cause });
    } finally {
      try {
        if (existingAdmins.length > 0)
          await prisma.$transaction(async (tx) => {
            await lockAdminSecurity(tx);
            // 恢复精确快照，只修改启用状态，不影响已有账号的凭据、身份、归属或版本。
            for (const account of existingAdmins)
              await tx.adminAccount.update({ where: { id: account.id }, data: { isEnabled: account.isEnabled } });
          });
      } catch (cause) {
        const recoveryFailure = new Error('最后超管测试隔离状态恢复失败', { cause });
        // 清理结束后统一报告验证与恢复错误，保留两个阶段的完整诊断。
        failure = failure
          ? new AggregateError([failure, recoveryFailure], '最后超管验证和隔离恢复均失败')
          : recoveryFailure;
      }
    }
    if (failure) throw failure;
  });

  it('组权限与页面分别授权，组停用不影响超管但撤销普通成员会话', async () => {
    const root = await createAdmin({ identityType: 'super_admin' });
    const member = await createAdmin({ groupId: root.groupId });
    const controller = await login(root.username);
    const first = await login(member.username);
    const configured = await api('PUT', `/admin/groups/${root.groupId}/permissions`, {
      cookie: controller.cookie,
      payload: { version: 1, permissions: ['users:read'], page_ids: [], reason: REASON },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    expect((await api('GET', '/admin/auth/me', { cookie: first.cookie })).statusCode).toBe(401);
    const latest = await login(member.username);
    expect(latest.response.json().admin.allowed_pages).toEqual([]);
    expect(latest.response.json().admin.authorization_version).not.toBe(
      first.response.json().admin.authorization_version,
    );
    expect((await api('GET', '/admin/users', { cookie: latest.cookie })).statusCode).toBe(200);
    expect((await api('GET', '/admin/groups', { cookie: controller.cookie })).statusCode).toBe(200);
    const disabled = await api('PATCH', `/admin/groups/${root.groupId}`, {
      cookie: controller.cookie,
      payload: { version: 2, is_enabled: false, reason: REASON },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await api('GET', '/admin/auth/me', { cookie: latest.cookie })).statusCode).toBe(401);
    const limited = await login(member.username);
    expect(limited.response.json().admin.permissions).toEqual(['auth:password', 'auth:logout']);
    expect(limited.response.json().admin.authorization_version).not.toBe(
      latest.response.json().admin.authorization_version,
    );
    expect((await api('GET', '/admin/users', { cookie: limited.cookie })).statusCode).toBe(403);
    expect((await api('GET', '/admin/groups', { cookie: controller.cookie })).statusCode).toBe(200);
    const unchangedSuper = await api('GET', '/admin/auth/me', { cookie: controller.cookie });
    expect(unchangedSuper.json().admin.authorization_version).toBe(
      controller.response.json().admin.authorization_version,
    );
  });

  it('组授权拒绝控制面和缺失依赖，资料改名保留成员会话并检查版本', async () => {
    const root = await createAdmin({ identityType: 'super_admin' });
    const member = await createAdmin({ groupId: root.groupId });
    const controller = await login(root.username);
    const session = await login(member.username);
    for (const permissions of [['accounts:manage'], ['devices:revoke']]) {
      const response = await api('PUT', `/admin/groups/${root.groupId}/permissions`, {
        cookie: controller.cookie,
        payload: { version: 1, permissions, page_ids: [], reason: REASON },
      });
      expect(response.statusCode).toBe(400);
    }
    const renamed = await api('PATCH', `/admin/groups/${root.groupId}`, {
      cookie: controller.cookie,
      payload: { version: 1, name: `自定义_${randomUUID()}`, description: '用户组说明', sort: 99 },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().version).toBe(2);
    const renamedAccount = await api('PATCH', `/admin/accounts/${member.id}`, {
      cookie: controller.cookie,
      payload: { version: member.version, display_name: '更新后台用户显示名' },
    });
    expect(renamedAccount.statusCode).toBe(200);
    expect(renamedAccount.json().version).toBe(member.version + 1);
    const afterMetadataChange = await api('GET', '/admin/auth/me', { cookie: session.cookie });
    expect(afterMetadataChange.statusCode).toBe(200);
    expect(afterMetadataChange.json().admin.display_name).toBe('更新后台用户显示名');
    expect(afterMetadataChange.json().admin.authorization_version).toBe(
      session.response.json().admin.authorization_version,
    );
    const conflict = await api('PATCH', `/admin/groups/${root.groupId}`, {
      cookie: controller.cookie,
      payload: { version: 1, description: '过期更新' },
    });
    expect(conflict.statusCode).toBe(409);
    const notEmpty = await api('DELETE', `/admin/groups/${root.groupId}`, {
      cookie: controller.cookie,
      payload: { version: 2, reason: REASON },
    });
    expect(notEmpty.json().code).toBe('ADMIN_GROUP_NOT_EMPTY');
  });

  it('批量转组先验证全批版本，失败整批不变，包含本人成功后全部旧会话失效', async () => {
    const root = await createAdmin({ identityType: 'super_admin' });
    const member = await createAdmin();
    const target = await prisma.adminGroup.create({ data: { name: `目标_${randomUUID()}` } });
    createdGroupIds.add(target.id);
    const controller = await login(root.username);
    const previous = await login(member.username);
    const members = [root, member].map((account) => ({
      admin_id: account.id,
      version: account.version,
      group_id: account.groupId,
      group_version: 1,
    }));
    const failed = await api('POST', `/admin/groups/${target.id}/members`, {
      cookie: controller.cookie,
      payload: { version: 1, members: [members[0], { ...members[1], version: 9 }], reason: REASON },
    });
    expect(failed.statusCode).toBe(409);
    expect((await prisma.adminAccount.findUniqueOrThrow({ where: { id: root.id } })).groupId).toBe(root.groupId);
    expect((await api('GET', '/admin/auth/me', { cookie: previous.cookie })).statusCode).toBe(200);
    const transferred = await api('POST', `/admin/groups/${target.id}/members`, {
      cookie: controller.cookie,
      payload: { version: 1, members, reason: REASON },
    });
    expect(transferred.statusCode, transferred.body).toBe(200);
    expect(transferred.json()).toEqual({ transferred: 2, self_session_revoked: true });
    for (const cookie of [controller.cookie, previous.cookie])
      expect((await api('GET', '/admin/auth/me', { cookie })).statusCode).toBe(401);
    expect((await prisma.adminAccount.findUniqueOrThrow({ where: { id: root.id } })).identityType).toBe('super_admin');
    const relogged = await login(root.username);
    const removed = await api('DELETE', `/admin/groups/${root.groupId}`, {
      cookie: relogged.cookie,
      payload: { version: 1, reason: REASON },
    });
    expect(removed.statusCode).toBe(204);
    const assignDeleted = await api('PATCH', `/admin/accounts/${member.id}`, {
      cookie: relogged.cookie,
      payload: { version: 2, group_id: root.groupId, reason: REASON },
    });
    expect(assignDeleted.statusCode).toBe(404);
  });

  it('账号与组列表的总数和分页来自同一筛选，删除账号不出现在候选或成员中', async () => {
    const usernamePrefix = `pg_${randomBytes(3).toString('hex')}`;
    const root = await createAdmin({ identityType: 'super_admin', usernamePrefix });
    const controller = await login(root.username);
    for (let i = 0; i < 12; i += 1) await createAdmin({ groupId: root.groupId, usernamePrefix });
    // 同组成员与他组候选都通过真实接口软删除，查询只能返回未删除的账号。
    for (const retired of [
      await createAdmin({ groupId: root.groupId, usernamePrefix }),
      await createAdmin({ usernamePrefix }),
    ]) {
      const removed = await api('DELETE', `/admin/accounts/${retired.id}`, {
        cookie: controller.cookie,
        payload: { version: retired.version, reason: REASON },
      });
      expect(removed.statusCode, removed.body).toBe(204);
      expect((await prisma.adminAccount.findUniqueOrThrow({ where: { id: retired.id } })).deletedAt).not.toBeNull();
    }
    // 同一唯一前缀使账号、成员与候选总数都只统计本用例创建的身份。
    const list = await api('GET', `/admin/accounts?group_id=${root.groupId}&q=${usernamePrefix}&page=99&page_size=10`, {
      cookie: controller.cookie,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ page: 2, page_size: 10, total: 13 });
    expect(list.json().items).toHaveLength(3);
    const members = await api('GET', `/admin/groups/${root.groupId}/members?q=${usernamePrefix}&page=2&page_size=10`, {
      cookie: controller.cookie,
    });
    expect(members.json().total).toBe(13);
    expect(members.json().items).toHaveLength(3);
    const candidates = await api('GET', `/admin/groups/${root.groupId}/candidates?q=${usernamePrefix}`, {
      cookie: controller.cookie,
    });
    expect(candidates.json().total).toBe(0);
  });
});

describe('系统默认分组与必填归属', () => {
  it('创建省略组时归入空授权默认组，显式null被拒绝且超管权限来自身份', async () => {
    const root = await createAdmin({ identityType: 'super_admin', groupId: DEFAULT_ADMIN_GROUP_ID });
    const controller = await login(root.username);
    expect(controller.response.json().admin.group).toMatchObject({ id: DEFAULT_ADMIN_GROUP_ID, is_default: true });
    expect(controller.response.json().admin.permissions).toContain('accounts:manage');
    const username = `default_${randomBytes(8).toString('hex')}`;
    const created = await api('POST', '/admin/accounts', {
      cookie: controller.cookie,
      payload: { username, password: PASSWORD, display_name: '默认组普通后台用户' },
    });
    expect(created.statusCode, created.body).toBe(201);
    createdAdminIds.add(created.json().id);
    expect(created.json()).toMatchObject({
      identity_type: 'standard_user',
      group_id: DEFAULT_ADMIN_GROUP_ID,
      group: { is_default: true },
    });
    const session = await login(username);
    expect(session.response.json().admin).toMatchObject({
      permissions: ['auth:password', 'auth:logout'],
      allowed_pages: [],
    });
    expect((await api('GET', '/admin/users', { cookie: session.cookie })).statusCode).toBe(403);
    const invalid = await api('POST', '/admin/accounts', {
      cookie: controller.cookie,
      payload: {
        username: `invalid_${randomBytes(7).toString('hex')}`,
        password: PASSWORD,
        display_name: '空组参数',
        group_id: null,
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('修改省略组保持归属，显式null不改变数据或会话，选择默认组正常撤销旧会话', async () => {
    const root = await createAdmin({ identityType: 'super_admin' });
    const target = await createAdmin();
    const controller = await login(root.username);
    const previous = await login(target.username);
    const renamed = await api('PATCH', `/admin/accounts/${target.id}`, {
      cookie: controller.cookie,
      payload: { version: target.version, display_name: '保留分组' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().group_id).toBe(target.groupId);
    const invalid = await api('PATCH', `/admin/accounts/${target.id}`, {
      cookie: controller.cookie,
      payload: { version: renamed.json().version, group_id: null, reason: REASON },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await api('GET', '/admin/auth/me', { cookie: previous.cookie })).statusCode).toBe(200);
    const moved = await api('PATCH', `/admin/accounts/${target.id}`, {
      cookie: controller.cookie,
      payload: { version: renamed.json().version, group_id: DEFAULT_ADMIN_GROUP_ID, reason: REASON },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().group).toMatchObject({ id: DEFAULT_ADMIN_GROUP_ID, is_default: true });
    expect((await api('GET', '/admin/auth/me', { cookie: previous.cookie })).statusCode).toBe(401);
    const current = await login(target.username);
    expect(current.response.json().admin.allowed_pages).toEqual([]);
  });

  it('默认组由稳定引用识别，不能停用或删除，成员转入必须给非空原组和版本', async () => {
    const root = await createAdmin({ identityType: 'super_admin' });
    const target = await createAdmin();
    const controller = await login(root.username);
    const group = await prisma.adminGroup.findUniqueOrThrow({ where: { id: DEFAULT_ADMIN_GROUP_ID } });
    const groups = await api('GET', `/admin/groups?q=${encodeURIComponent(group.name)}`, { cookie: controller.cookie });
    expect(groups.json().items.find((entry: { id: string }) => entry.id === DEFAULT_ADMIN_GROUP_ID).is_default).toBe(
      true,
    );
    const disabled = await api('PATCH', `/admin/groups/${group.id}`, {
      cookie: controller.cookie,
      payload: { version: group.version, is_enabled: false, reason: REASON },
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json().code).toBe('ADMIN_DEFAULT_GROUP_PROTECTED');
    const deleted = await api('DELETE', `/admin/groups/${group.id}`, {
      cookie: controller.cookie,
      payload: { version: group.version, reason: REASON },
    });
    expect(deleted.statusCode).toBe(409);
    expect(deleted.json().code).toBe('ADMIN_DEFAULT_GROUP_PROTECTED');
    const invalid = await api('POST', `/admin/groups/${group.id}/members`, {
      cookie: controller.cookie,
      payload: {
        version: group.version,
        members: [{ admin_id: target.id, version: target.version, group_id: null, group_version: null }],
        reason: REASON,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await prisma.adminAccount.findUniqueOrThrow({ where: { id: target.id } })).groupId).toBe(target.groupId);
  });
});
