import { testFixtureDatabaseUrl } from './existing-test-database.js';

import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadTestApiConfig } from './test-api-config.js';
import { lockAccountSessions, terminateRefreshTokens } from '../src/modules/auth/index.js';
import { hashAdminPassword } from '../src/modules/admin/index.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const PASSWORD = 'Wx7!qD3@hM8#tR4$pJ9%nB6';
const NEW_PASSWORD = 'Vz9!bF4@kS7#rN2$mT8%qH5';
const ADMIN_ORIGIN = 'https://admin.example.test';

type Session = { access_token: string; refresh_token: string; device_id: string; user: { user_id: string } };
type Account = { phone: string; installationId: string; session: Session };

let prisma: PrismaClient;
let app: ReturnType<typeof buildApp>;
let admin: { id: string; cookie: string };
let onSessionWriteAttempt: (() => void) | undefined;

/** 发送真实认证与管理请求，错误上下文不包含密码或令牌。 */
async function api(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: Record<string, unknown>,
  credential?: string | { cookie: string },
) {
  try {
    return await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        ...(typeof credential === 'string' ? { authorization: `Bearer ${credential}` } : {}),
        ...(credential && typeof credential === 'object' ? { cookie: credential.cookie } : {}),
        ...(path.startsWith('/admin/') ? { origin: ADMIN_ORIGIN, 'x-admin-request': '1' } : {}),
      },
      ...(payload ? { payload } : {}),
    });
  } catch (cause) {
    throw new Error(`会话生命周期测试请求失败：${method} ${path}`, { cause });
  }
}

/** 建立独立账号及固定安装身份，用于验证重新登录不能恢复旧令牌资格。 */
async function registerAccount(): Promise<Account> {
  try {
    const phone = `139${randomInt(100_000_000).toString().padStart(8, '0')}`;
    const installationId = randomUUID();
    const response = await api('POST', '/auth/register', {
      country_code: '+86',
      phone,
      password: PASSWORD,
      device: { installation_id: installationId, name: '会话测试设备', platform: 'test' },
    });
    expect(response.statusCode, response.body).toBe(201);
    return { phone, installationId, session: response.json<Session>() };
  } catch (cause) {
    throw new Error('会话生命周期测试账号创建失败', { cause });
  }
}

/** 用明确安装身份进行密码登录，返回同账号的对应设备会话。 */
async function login(account: Account, installationId: string, password = PASSWORD): Promise<Session> {
  try {
    const response = await api('POST', '/auth/login', {
      country_code: '+86',
      phone: account.phone,
      password,
      device: { installation_id: installationId, name: '重新登录设备', platform: 'test' },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Session>();
  } catch (cause) {
    throw new Error('会话生命周期测试登录失败', { cause });
  }
}

beforeAll(async () => {
  try {
    prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
    const applicationPrisma = prisma.$extends({
      query: {
        async $allOperations({ model, operation, args, query }) {
          // 屏障只观察真实请求已经准备取得会话锁或写轮换状态，不替换数据库操作。
          if (
            onSessionWriteAttempt &&
            (operation === '$queryRaw' || (model === 'RefreshToken' && operation === 'updateMany'))
          ) {
            const notify = onSessionWriteAttempt;
            onSessionWriteAttempt = undefined;
            notify();
          }
          return query(args);
        },
      },
    });
    app = buildApp({
      logger: false,
      prisma: applicationPrisma as unknown as PrismaClient,
      config: {
        ...loadTestApiConfig(),
        databaseUrl: DATABASE_URL,
        storagePath: resolve(import.meta.dirname, '../../../Temp/auth-session-lifecycle'),
        rateLimitMax: 1000,
        authRateLimitMax: 1000,
        adminOrigins: [ADMIN_ORIGIN],
      },
    });
    await app.ready();
    const username = `lifecycle_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const password = 'kN9!tJ3@wB6#qR8$vC4%pS7';
    const account = await prisma.adminAccount.create({
      data: {
        username,
        displayName: '用户会话撤销测试',
        passwordHash: await hashAdminPassword(password),
        identityType: 'standard_user',
        group: {
          create: {
            name: `会话测试_${username}`,
            permissions: ['users:read', 'users:write', 'devices:read', 'devices:revoke'],
            pageIds: ['users'],
          },
        },
      },
    });
    admin = { id: account.id, cookie: '' };
    const loggedIn = await api('POST', '/admin/auth/login', { username, password });
    expect(loggedIn.statusCode).toBe(200);
    const cookies = loggedIn.headers['set-cookie'];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies]).find((value) =>
      value?.startsWith('__Secure-sesame_admin_session='),
    );
    expect(cookie).toBeDefined();
    admin.cookie = cookie!.split(';')[0]!;
  } catch (cause) {
    throw new Error('会话生命周期测试初始化失败', { cause });
  }
});

afterAll(async () => {
  try {
    if (admin) await prisma.adminAccount.deleteMany({ where: { id: admin.id } });
    if (app) await app.close();
    else if (prisma) await prisma.$disconnect();
  } catch (cause) {
    throw new Error('会话生命周期测试关闭失败', { cause });
  }
});

describe('刷新轮换宽限与明确终止', () => {
  it.each(['logout', 'password', 'disable', 'self-device', 'admin-device'] as const)(
    '%s 终止全部旧令牌，包含宽限旧令牌；同安装重新登录后仍不能复活',
    async (action) => {
      try {
        const account = await registerAccount();
        const controller = await login(account, randomUUID());
        const first = account.session;
        const rotated = await api('POST', '/auth/refresh', { refresh_token: first.refresh_token });
        expect(rotated.statusCode, rotated.body).toBe(200);
        const second = rotated.json<Session>();
        const retried = await api('POST', '/auth/refresh', { refresh_token: first.refresh_token });
        expect(retried.statusCode, retried.body).toBe(200);
        const third = retried.json<Session>();

        if (action === 'logout') {
          const result = await api('POST', '/auth/logout', { refresh_token: third.refresh_token }, third.access_token);
          expect(result.statusCode, result.body).toBe(204);
        } else if (action === 'password') {
          const result = await api(
            'PATCH',
            '/auth/password',
            {
              current_password: PASSWORD,
              new_password: NEW_PASSWORD,
            },
            controller.access_token,
          );
          expect(result.statusCode, result.body).toBe(204);
        } else if (action === 'disable') {
          const disabled = await api(
            'PATCH',
            `/admin/users/${first.user.user_id}/disable`,
            { reason: '用户确认暂停账号访问' },
            admin,
          );
          expect(disabled.statusCode, disabled.body).toBe(200);
          const enabled = await api(
            'PATCH',
            `/admin/users/${first.user.user_id}/enable`,
            { reason: '用户确认恢复账号访问' },
            admin,
          );
          expect(enabled.statusCode, enabled.body).toBe(200);
        } else if (action === 'self-device') {
          const result = await api('DELETE', `/devices/${first.device_id}`, undefined, controller.access_token);
          expect(result.statusCode, result.body).toBe(204);
        } else {
          const result = await api(
            'POST',
            `/admin/users/${first.user.user_id}/devices/${first.device_id}/revoke`,
            { reason: '设备遗失，用户确认撤销登录' },
            admin,
          );
          expect(result.statusCode, result.body).toBe(204);
        }

        const terminated = await prisma.refreshToken.findMany({
          where: { userId: first.user.user_id, deviceId: first.device_id },
        });
        expect(terminated).toHaveLength(3);
        expect(terminated.every((row) => row.revokedAt !== null && row.expiresAt.getTime() <= Date.now())).toBe(true);
        if (action !== 'disable') {
          // 明确终止只影响选中的设备；修改密码时执行改密的设备仍能刷新。
          const unaffected = await api('POST', '/auth/refresh', { refresh_token: controller.refresh_token });
          expect(unaffected.statusCode, unaffected.body).toBe(200);
        }
        const renewed = await login(account, account.installationId, action === 'password' ? NEW_PASSWORD : PASSWORD);
        expect(renewed.device_id).toBe(first.device_id);
        const before = await prisma.refreshToken.count({ where: { userId: first.user.user_id } });
        for (const old of [first, second, third]) {
          const response = await api('POST', '/auth/refresh', { refresh_token: old.refresh_token });
          expect(response.statusCode, response.body).toBe(401);
          expect(response.json()).toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
        }
        expect(await prisma.refreshToken.count({ where: { userId: first.user.user_id } })).toBe(before);
        const valid = await api('POST', '/auth/refresh', { refresh_token: renewed.refresh_token });
        expect(valid.statusCode, valid.body).toBe(200);
      } catch (cause) {
        throw new Error(`${action} 会话终止与重新登录隔离验证失败`, { cause });
      }
    },
  );

  it('终止事务持锁时到达的宽限刷新，等待提交后重新校验且不签发新令牌', async () => {
    let releaseRevocation!: () => void;
    const revocationGate = new Promise<void>((resolveGate) => {
      releaseRevocation = resolveGate;
    });
    let markRevocationReady!: () => void;
    const revocationReady = new Promise<void>((resolveReady) => {
      markRevocationReady = resolveReady;
    });
    let revocation: Promise<void> | undefined;
    let refresh: ReturnType<typeof api> | undefined;
    try {
      const account = await registerAccount();
      const rotated = await api('POST', '/auth/refresh', { refresh_token: account.session.refresh_token });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const before = await prisma.refreshToken.count({ where: { userId: account.session.user.user_id } });
      revocation = prisma.$transaction(
        async (tx) => {
          await lockAccountSessions(tx, account.session.user.user_id);
          await terminateRefreshTokens(tx, account.session.user.user_id, { deviceId: account.session.device_id });
          markRevocationReady();
          await revocationGate;
        },
        { timeout: 10_000 },
      );
      await Promise.race([revocationReady, revocation]);
      const requestWaiting = new Promise<void>((resolveWaiting) => {
        onSessionWriteAttempt = resolveWaiting;
      });
      refresh = api('POST', '/auth/refresh', { refresh_token: account.session.refresh_token });
      await Promise.race([
        requestWaiting,
        refresh.then(() => {
          throw new Error('刷新请求未等待终止事务');
        }),
      ]);
      releaseRevocation();
      await revocation;
      const response = await refresh;
      expect(response.statusCode, response.body).toBe(401);
      expect(response.json()).toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
      expect(await prisma.refreshToken.count({ where: { userId: account.session.user.user_id } })).toBe(before);
    } catch (cause) {
      throw new Error('刷新与明确终止串行化验证失败', { cause });
    } finally {
      onSessionWriteAttempt = undefined;
      releaseRevocation();
      await Promise.allSettled([revocation, refresh]);
    }
  });

  it.each(['expired', 'generation'] as const)('宽限不能借用 %s 后继令牌继续签发', async (invalidSuccessor) => {
    try {
      const account = await registerAccount();
      const rotated = await api('POST', '/auth/refresh', { refresh_token: account.session.refresh_token });
      expect(rotated.statusCode, rotated.body).toBe(200);
      await prisma.refreshToken.updateMany({
        where: { userId: account.session.user.user_id, revokedAt: null },
        data: invalidSuccessor === 'expired' ? { expiresAt: new Date(0) } : { authGeneration: randomUUID() },
      });
      const before = await prisma.refreshToken.count({ where: { userId: account.session.user.user_id } });
      const retried = await api('POST', '/auth/refresh', { refresh_token: account.session.refresh_token });
      expect(retried.statusCode, retried.body).toBe(401);
      expect(retried.json()).toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
      expect(await prisma.refreshToken.count({ where: { userId: account.session.user.user_id } })).toBe(before);
    } catch (cause) {
      throw new Error('宽限后继令牌有效性验证失败', { cause });
    }
  });

  it('logout 的刷新令牌与访问令牌设备不一致时，不终止任一设备的会话', async () => {
    try {
      const account = await registerAccount();
      const otherInstallation = randomUUID();
      const presented = await login(account, otherInstallation);
      const rotated = await api('POST', '/auth/refresh', { refresh_token: presented.refresh_token });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const unpresented = rotated.json<Session>();
      const result = await api(
        'POST',
        '/auth/logout',
        { refresh_token: presented.refresh_token },
        account.session.access_token,
      );
      expect(result.statusCode, result.body).toBe(204);
      const old = await api('POST', '/auth/refresh', { refresh_token: presented.refresh_token });
      expect(old.statusCode, old.body).toBe(200);
      const current = await api('POST', '/auth/refresh', { refresh_token: unpresented.refresh_token });
      expect(current.statusCode, current.body).toBe(200);
      const caller = await api('POST', '/auth/refresh', { refresh_token: account.session.refresh_token });
      expect(caller.statusCode, caller.body).toBe(200);
    } catch (cause) {
      throw new Error('logout 显式令牌终止范围验证失败', { cause });
    }
  });
});
