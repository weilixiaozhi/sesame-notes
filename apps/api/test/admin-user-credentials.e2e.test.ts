import { testFixtureDatabaseUrl } from './existing-test-database.js';

import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { decodeJwt, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { hashAdminPassword } from '../src/modules/admin/index.js';
import { registeredMemberId } from '../src/modules/accounting/index.js';
import { maskPhoneE164 } from '../src/modules/auth/index.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const RUN = randomUUID();
const ORIGIN = 'https://admin.credentials.example.test';
const ADMIN_PASSWORD = 'credentials-admin-test-passphrase';
const USER_PASSWORD = 'user-old-password';
const COUNTRY_CODE = '+991';
const NUMBER_PREFIX = randomInt(1_000_000, 9_999_999).toString();
const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'credentials-e2e-at-least-32-byte-secret',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: resolve('../../Temp', `admin-user-credentials-${RUN}`),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [ORIGIN],
  adminOrigins: [ORIGIN],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};
const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
const app = buildApp({ logger: false, config, prisma });
const userIds: string[] = [];
const adminIds: string[] = [];
let groupId: string | undefined;
let adminCookie = '';
let readerCookie = '';
let numberSequence = 0;

type Session = {
  access_token: string;
  refresh_token: string;
  device_id: string;
  user: { user_id: string; sesame_number: string; phone: string };
};
type Account = { phone: string; installationId: string; session: Session };

/** 每轮使用随机前缀和递增尾号，避免测试间的号码冲突。 */
function nextPhone(): string {
  numberSequence += 1;
  return `${NUMBER_PREFIX}${numberSequence.toString().padStart(4, '0')}`;
}

/** 写请求使用真实后台登录所得 Cookie 和同源安全标识。 */
function adminHeaders(cookie = adminCookie) {
  return { cookie, origin: ORIGIN, 'x-admin-request': '1' };
}

/** 普通用户通过真实注册入口创建，使凭据和初始会话遵循实际约束。 */
async function registerAccount(): Promise<Account> {
  try {
    const phone = nextPhone();
    const installationId = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        country_code: COUNTRY_CODE,
        phone,
        password: USER_PASSWORD,
        device: { installation_id: installationId, name: '凭据验收设备', platform: 'e2e' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json<Session>();
    userIds.push(session.user.user_id);
    return { phone, installationId, session };
  } catch (cause) {
    throw new Error('凭据管理验收注册用户失败', { cause });
  }
}

/** 登录仍复用同一安装标识，验证撤销后的旧令牌不会被新登录复活。 */
async function loginUser(account: Account, phone = account.phone, password = USER_PASSWORD) {
  try {
    return await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        country_code: COUNTRY_CODE,
        phone,
        password,
        device: { installation_id: account.installationId, name: '凭据验收设备', platform: 'e2e' },
      },
    });
  } catch (cause) {
    throw new Error('凭据管理验收登录请求失败', { cause });
  }
}

/** 读取本人资料以校验短期访问令牌的真实授权状态。 */
async function accessStatus(token: string): Promise<number> {
  try {
    return (
      await app.inject({ method: 'GET', url: '/api/v1/profile/me', headers: { authorization: `Bearer ${token}` } })
    ).statusCode;
  } catch (cause) {
    throw new Error('凭据管理验收访问状态读取失败', { cause });
  }
}

/** 登录后台并提取浏览器使用的独立会话 Cookie。 */
async function loginAdmin(username: string): Promise<string> {
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      headers: { origin: ORIGIN, 'x-admin-request': '1' },
      payload: { username, password: ADMIN_PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    const values = response.headers['set-cookie'];
    const cookie = (Array.isArray(values) ? values : [values]).find((value) =>
      value?.startsWith('__Secure-sesame_admin_session='),
    );
    expect(cookie).toBeDefined();
    return cookie!.split(';')[0]!;
  } catch (cause) {
    throw new Error('凭据管理验收后台登录失败', { cause });
  }
}

/** 生成缺少凭据版本的令牌，验证声明不完整的凭据被拒绝。 */
async function legacyAccessToken(session: Session): Promise<string> {
  try {
    const { credential_version: _version, ...claims } = decodeJwt(session.access_token);
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(new TextEncoder().encode(config.jwtSecret));
  } catch (cause) {
    throw new Error('存量访问令牌验收准备失败', { cause });
  }
}

beforeAll(async () => {
  try {
    const passwordHash = await hashAdminPassword(ADMIN_PASSWORD);
    const group = await prisma.adminGroup.create({
      data: { name: `凭据管理验收-${RUN}`, permissions: ['users:read'], pageIds: ['users'] },
    });
    groupId = group.id;
    for (const identityType of ['super_admin', 'standard_user']) {
      const admin = await prisma.adminAccount.create({
        data: {
          username: `cred_${identityType === 'super_admin' ? 'a' : 'r'}_${RUN.replaceAll('-', '').slice(0, 16)}`,
          displayName: '用户凭据验收',
          passwordHash,
          identityType,
          groupId: group.id,
        },
      });
      adminIds.push(admin.id);
      if (identityType === 'super_admin') adminCookie = await loginAdmin(admin.username);
      else readerCookie = await loginAdmin(admin.username);
    }
  } catch (cause) {
    throw new Error('后台用户凭据管理验收初始化失败', { cause });
  }
}, 30_000);

afterAll(async () => {
  try {
    await app.close();
    await prisma.ledger.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.adminAccount.deleteMany({ where: { id: { in: adminIds } } });
    if (groupId) await prisma.adminGroup.delete({ where: { id: groupId } });
  } catch (cause) {
    throw new Error('后台用户凭据管理验收清理失败', { cause });
  } finally {
    await prisma.$disconnect();
  }
});

describe('后台用户手机号换绑和密码重置', () => {
  it('等待换绑完成的登录请求不能沿用锁前读取的旧手机号身份', async () => {
    const captured = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let oldPhone: string | undefined;
    let pendingLogin: Promise<{ statusCode: number; body: string }> | undefined;
    const delayedClient = prisma.$extends({
      query: {
        user: {
          /** 在读取旧号码账号后暂停，制造账号锁取得之前发生换绑的窗口。 */
          async findUnique({ args, query }) {
            try {
              const user = await query(args);
              if (oldPhone && args.where.phoneE164 === oldPhone) {
                captured.resolve();
                await resume.promise;
              }
              return user;
            } catch (cause) {
              throw new Error('登录与手机号换绑并发夹具读取失败', { cause });
            }
          },
        },
      },
    });
    const delayedApp = buildApp({ logger: false, config, prisma: delayedClient as unknown as PrismaClient });
    try {
      const account = await registerAccount();
      oldPhone = account.session.user.phone;
      pendingLogin = delayedApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          country_code: COUNTRY_CODE,
          phone: account.phone,
          password: USER_PASSWORD,
          device: { installation_id: randomUUID(), name: '等待换绑的登录设备', platform: 'e2e' },
        },
      });
      await Promise.race([
        captured.promise,
        pendingLogin.then(() => {
          throw new Error('登录没有进入预期的锁前并发窗口');
        }),
      ]);
      const result = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/users/${account.session.user.user_id}/phone`,
        headers: adminHeaders(),
        payload: { country_code: COUNTRY_CODE, phone: nextPhone(), current_phone: oldPhone, reason: '并发换绑验收' },
      });
      expect(result.statusCode, result.body).toBe(204);
      resume.resolve();
      const login = await pendingLogin;
      expect(login.statusCode, login.body).toBe(401);
      expect(
        await prisma.refreshToken.count({ where: { userId: account.session.user.user_id, revokedAt: null } }),
      ).toBe(0);
    } catch (cause) {
      throw new Error('换绑期间锁前登录身份重验失败', { cause });
    } finally {
      resume.resolve();
      await Promise.allSettled([pendingLogin]);
      await delayedApp.close();
    }
  });

  it('换绑保留用户身份和业务资料，并永久终止全部旧会话和轮换宽限', async () => {
    try {
      const account = await registerAccount();
      const userId = account.session.user.user_id;
      const next = nextPhone();
      const legacy = await legacyAccessToken(account.session);
      expect(await accessStatus(legacy)).toBe(401);
      const secondary = await loginUser({ ...account, installationId: randomUUID() });
      expect(secondary.statusCode, secondary.body).toBe(200);
      const rotated = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refresh_token: account.session.refresh_token },
      });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const profile = await prisma.userProfile.findUniqueOrThrow({ where: { userId } });
      const ledger = await prisma.$transaction(async (tx) => {
        const created = await tx.ledger.create({
          data: { syncId: randomUUID(), ownerId: userId, name: '换绑保留账本', currency: 'CNY' },
        });
        // 账本所有者必须在同一事务拥有有效的注册成员身份，满足真实业务不变量。
        await tx.ledgerMember.create({
          data: {
            id: registeredMemberId(created.id, userId),
            ledgerId: created.id,
            displayName: '换绑验收所有者',
            memberType: 'REGISTERED',
            linkedAccountId: userId,
            role: 'owner',
            status: 'ACTIVE',
          },
        });
        return created;
      });
      const result = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/users/${userId}/phone`,
        headers: adminHeaders(),
        payload: {
          country_code: COUNTRY_CODE,
          phone: next,
          current_phone: account.session.user.phone,
          reason: '用户确认换绑',
        },
      });
      expect(result.statusCode, result.body).toBe(204);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({
        phoneE164: `${COUNTRY_CODE}${next}`,
        sesameNumber: account.session.user.sesame_number,
        credentialVersion: 1,
      });
      expect(await prisma.userProfile.findUniqueOrThrow({ where: { userId } })).toEqual(profile);
      expect(await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })).toEqual(ledger);
      for (const session of [account.session, rotated.json<Session>(), secondary.json<Session>()]) {
        expect(await accessStatus(session.access_token)).toBe(401);
        const refresh = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          payload: { refresh_token: session.refresh_token },
        });
        expect(refresh.statusCode, refresh.body).toBe(401);
      }
      expect(await accessStatus(legacy)).toBe(401);
      expect((await loginUser(account)).statusCode).toBe(401);
      const renewed = await loginUser(account, next);
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(renewed.json<Session>().device_id).toBe(account.session.device_id);
      expect(renewed.json<Session>().user.user_id).toBe(userId);
      expect(await accessStatus(renewed.json<Session>().access_token)).toBe(200);
      expect(await accessStatus(account.session.access_token)).toBe(401);
      expect(await accessStatus(legacy)).toBe(401);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.phone.change', target: { path: ['id'], equals: userId } },
      });
      expect(audit.metadata).toMatchObject({
        reason: '用户确认换绑',
        previous_number: maskPhoneE164(account.session.user.phone),
        current_number: maskPhoneE164(`${COUNTRY_CODE}${next}`),
      });
      expect(JSON.stringify(audit.metadata)).not.toContain(account.session.user.phone);
      expect(JSON.stringify(audit.metadata)).not.toContain(next);
    } catch (cause) {
      throw new Error('换绑身份保留、全部会话终止与审计脱敏验收失败', { cause });
    }
  });

  it.each(['1', '  新密码  ', 'x'.repeat(128)])('重置密码完整保留输入字符并使旧凭据失效：%s', async (password) => {
    try {
      const account = await registerAccount();
      const userId = account.session.user.user_id;
      const result = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${userId}/reset-password`,
        headers: adminHeaders(),
        payload: { new_password: password, reason: '用户申请重置密码' },
      });
      expect(result.statusCode, result.body).toBe(204);
      expect(await accessStatus(account.session.access_token)).toBe(401);
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refresh_token: account.session.refresh_token },
      });
      expect(invalid.statusCode, invalid.body).toBe(401);
      expect((await loginUser(account)).statusCode).toBe(401);
      const renewed = await loginUser(account, account.phone, password);
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(await accessStatus(renewed.json<Session>().access_token)).toBe(200);
      expect(await accessStatus(account.session.access_token)).toBe(401);
      if (password.trim() !== password)
        expect((await loginUser(account, account.phone, password.trim())).statusCode).toBe(401);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.credentialVersion).toBe(1);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.password.reset', target: { path: ['id'], equals: userId } },
      });
      expect(audit.metadata).toMatchObject({ reason: '用户申请重置密码' });
      expect(Object.keys(audit.metadata as object)).toEqual(
        expect.arrayContaining(['reason', 'actor_username', 'target_display']),
      );
      expect(Object.keys(audit.metadata as object).some((key) => /password|hash|token/i.test(key))).toBe(false);
      expect(JSON.stringify(audit.metadata)).not.toContain(user.passwordHash);
    } catch (cause) {
      throw new Error('用户密码重置与凭据版本验收失败', { cause });
    }
  });

  it('已占用号码、陈旧页面和未改变号码都不修改资料、不终止现有会话', async () => {
    try {
      const account = await registerAccount();
      const other = await registerAccount();
      const userId = account.session.user.user_id;
      const original = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const cases = [
        { phone: other.phone, current_phone: account.session.user.phone, code: 'PHONE_ALREADY_REGISTERED' },
        { phone: nextPhone(), current_phone: other.session.user.phone, code: 'USER_PHONE_CHANGED' },
        { phone: account.phone, current_phone: account.session.user.phone, code: 'PHONE_UNCHANGED' },
      ];
      for (const input of cases) {
        const result = await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/users/${userId}/phone`,
          headers: adminHeaders(),
          payload: {
            country_code: COUNTRY_CODE,
            phone: input.phone,
            current_phone: input.current_phone,
            reason: '验证冲突',
          },
        });
        expect(result.statusCode, result.body).toBe(409);
        expect(result.json()).toMatchObject({ code: input.code });
      }
      expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toEqual(original);
      expect(await accessStatus(account.session.access_token)).toBe(200);
      expect(await prisma.refreshToken.count({ where: { userId, revokedAt: null } })).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { action: 'user.phone.change', target: { path: ['id'], equals: userId } },
        }),
      ).toBe(0);
    } catch (cause) {
      throw new Error('手机号换绑冲突与无副作用验收失败', { cause });
    }
  });

  it('只读后台用户不能换绑或重置密码，空密码和超长密码均被拒绝', async () => {
    try {
      const account = await registerAccount();
      const userId = account.session.user.user_id;
      const phone = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/users/${userId}/phone`,
        headers: adminHeaders(readerCookie),
        payload: {
          country_code: COUNTRY_CODE,
          phone: nextPhone(),
          current_phone: account.session.user.phone,
          reason: '未授权换绑',
        },
      });
      expect(phone.statusCode, phone.body).toBe(403);
      const reset = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${userId}/reset-password`,
        headers: adminHeaders(readerCookie),
        payload: { new_password: 'new-password', reason: '未授权改密' },
      });
      expect(reset.statusCode, reset.body).toBe(403);
      for (const password of ['', 'x'.repeat(129)]) {
        const invalid = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/users/${userId}/reset-password`,
          headers: adminHeaders(),
          payload: { new_password: password, reason: '验证密码限制' },
        });
        expect(invalid.statusCode, invalid.body).toBe(400);
      }
      expect(await accessStatus(account.session.access_token)).toBe(200);
      expect((await loginUser(account)).statusCode).toBe(200);
    } catch (cause) {
      throw new Error('用户凭据管理权限及密码边界验收失败', { cause });
    }
  });

  it.each(['phone', 'reset-password'] as const)('%s 审计失败时凭据、版本和会话一并回滚', async (action) => {
    const failedClient = prisma.$extends({
      query: {
        auditLog: {
          /** 模拟审计持久化故障以验证实际数据库事务边界。 */ async create() {
            throw new Error('验收注入的审计不可用');
          },
        },
      },
    });
    const failedApp = buildApp({ logger: false, config, prisma: failedClient as unknown as PrismaClient });
    try {
      const account = await registerAccount();
      const userId = account.session.user.user_id;
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const tokens = await prisma.refreshToken.findMany({ where: { userId } });
      const result = await failedApp.inject({
        method: action === 'phone' ? 'PUT' : 'POST',
        url: `/api/v1/admin/users/${userId}/${action}`,
        headers: adminHeaders(),
        payload:
          action === 'phone'
            ? {
                country_code: COUNTRY_CODE,
                phone: nextPhone(),
                current_phone: account.session.user.phone,
                reason: '验证事务回滚',
              }
            : { new_password: 'must-not-commit', reason: '验证事务回滚' },
      });
      expect(result.statusCode, result.body).toBe(500);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: userId } })).toEqual(user);
      expect(await prisma.refreshToken.findMany({ where: { userId } })).toEqual(tokens);
      expect(await accessStatus(account.session.access_token)).toBe(200);
      expect((await loginUser(account)).statusCode).toBe(200);
      expect(
        await prisma.auditLog.count({
          where: {
            target: { path: ['id'], equals: userId },
            action: { in: ['user.phone.change', 'user.password.reset'] },
          },
        }),
      ).toBe(0);
    } catch (cause) {
      throw new Error('审计故障下用户凭据与会话原子性验收失败', { cause });
    } finally {
      await failedApp.close();
    }
  });
});
