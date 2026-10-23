import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomInt, randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

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
  corsOrigins: ['http://localhost:5173'],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};

type TestPrisma = ReturnType<typeof buildTestPrisma>;
let prisma: TestPrisma;
let app: ReturnType<typeof buildApp>;

/** 记录注册事务已完成的真实写入，随后在指定阶段抛出故障。 */
type RegistrationFailPoint = {
  kind: 'device' | 'refreshToken' | 'sesameCollision';
  userId?: string;
  deviceId?: string;
  refreshTokenId?: string;
};
let failPoint: RegistrationFailPoint | null = null;
let collisionInjected = false;

/** 构建带故障注入的 Prisma 客户端（Client Extension 只在测试中使用）。 */
function buildTestPrisma() {
  const base = new PrismaClient({ datasourceUrl: DATABASE_URL });
  return base.$extends({
    query: {
      user: {
        /** 在真实唯一冲突前占用芝麻号，并记录故障场景实际创建的用户身份。 */
        async create({
          args,
          query,
        }: {
          args: Prisma.UserCreateArgs;
          query: (a: Prisma.UserCreateArgs) => Promise<unknown>;
        }) {
          if (failPoint) {
            const data = args.data as { sesameNumber?: string };
            if (failPoint.kind === 'sesameCollision' && !collisionInjected && data.sesameNumber) {
              // 先占用同一芝麻号（绕过扩展的裸 SQL），迫使真实 create 触发唯一约束冲突
              collisionInjected = true;
              await base.$executeRaw`
                INSERT INTO users (id, phone_e164, sesame_number, password_hash, is_enabled, created_at)
                VALUES (gen_random_uuid(), ${`+1${String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)}`},
                        ${data.sesameNumber}, 'scrypt:inj', true, now())
              `;
            }
          }
          const user = await query(args);
          if (failPoint && failPoint.kind !== 'sesameCollision') failPoint.userId = (user as { id: string }).id;
          return user;
        },
      },
      device: {
        /** 设备已在注册事务中保存后注入故障，验证包含用户资料的事务整体回滚。 */
        async upsert({ args, query }) {
          const device = await query(args);
          if (failPoint && failPoint.kind !== 'sesameCollision') {
            failPoint.deviceId = device.id;
            if (failPoint.kind === 'device') throw new Error('注入的设备保存后故障');
          }
          return device;
        },
      },
      refreshToken: {
        /** 刷新令牌已落入事务后注入故障，验证用户、资料和设备均不残留。 */
        async create({ args, query }) {
          const token = await query(args);
          if (failPoint?.kind === 'refreshToken') {
            failPoint.refreshTokenId = token.id;
            throw new Error('注入的刷新令牌保存后故障');
          }
          return token;
        },
      },
    },
  });
}

/** 测试用唯一手机号：+86 区号 + 时间戳后缀，保证并发测试文件之间不冲突 */
let phoneSequence = Date.now() % 10_000_000_000;
/** 单文件单调分配号码，避免同毫秒内两个随机两位尾号发生碰撞。 */
function uniquePhone(): string {
  phoneSequence += 1;
  return `138${phoneSequence.toString().padStart(10, '0')}`;
}

/** 从测试库选择未占用的四位手机号，重复执行时保留已有账号和重复注册断言。 */
async function unusedShortPhone(): Promise<string> {
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const phone = randomInt(1000, 10_000).toString();
      if (!(await prisma.user.findUnique({ where: { phoneE164: `+86${phone}` }, select: { id: true } }))) return phone;
    }
    throw new Error('四位测试号码尝试次数已达上限');
  } catch (cause) {
    throw new Error('短手机号注册夹具准备失败', { cause });
  }
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

function registerBody(phone: string, password = '1', extra: Record<string, unknown> = {}) {
  return {
    country_code: '+86',
    phone,
    password,
    device: {
      installation_id: randomUUID(),
      name: 'auth-account-e2e',
      platform: 'e2e',
      app_version: '1.0.0',
      os_version: '16',
      device_model: 'e2e-model',
    },
    ...extra,
  };
}

type Session = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  device_id: string;
  scopes: string[];
  user: {
    user_id: string;
    sesame_number: string;
    display_name: string;
    avatar_url: string | null;
    avatar_version: number;
    phone: string;
    gender: string;
  };
};

beforeAll(async () => {
  prisma = buildTestPrisma();
  app = buildApp({ logger: false, config, prisma: prisma as unknown as PrismaClient });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('切片一：手机号账号注册模型（需求锚点）', () => {
  it.each([false, true])('注册统计按服务端入口记录来源，不采用设备声明：browser=%s', async (browser) => {
    try {
      const body = registerBody(uniquePhone());
      body.device.platform = browser ? 'android' : 'web';
      const response = await app.inject({
        method: 'POST',
        url: `${API_BASE}/auth/${browser ? 'browser/' : ''}register`,
        headers: browser ? { origin: config.corsOrigins[0]! } : {},
        payload: body,
      });
      expect(response.statusCode, response.body).toBe(201);
      const events = await prisma.productAnalyticsEvent.findMany({
        where: { eventId: response.json().user.user_id, kind: 'registration' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.platform).toBe(browser ? 'web' : 'app');
    } catch (cause) {
      throw new Error('注册来源事务记录验证失败', { cause });
    }
  });

  it.each([
    { browser: true, password: '1' },
    { browser: false, password: '1234' },
  ])('四位短手机号和宽松密码可注册并跨入口登录：browser=$browser', async ({ browser, password }) => {
    try {
      const phone = await unusedShortPhone();
      const body = registerBody(phone, password);
      const registered = await app.inject({
        method: 'POST',
        url: `${API_BASE}/auth/${browser ? 'browser/' : ''}register`,
        headers: browser ? { origin: config.corsOrigins[0]! } : {},
        payload: body,
      });
      expect(registered.statusCode, registered.body).toBe(201);
      expect(registered.json().user.phone).toBe(`+86${phone}`);
      for (const prefix of ['', 'browser/']) {
        const loggedIn = await app.inject({
          method: 'POST',
          url: `${API_BASE}/auth/${prefix}login`,
          headers: prefix ? { origin: config.corsOrigins[0]! } : {},
          payload: { ...body, phone: `${phone.slice(0, 2)} - ${phone.slice(2)}` },
        });
        expect(loggedIn.statusCode, loggedIn.body).toBe(200);
        expect(loggedIn.json().user.user_id).toBe(registered.json().user.user_id);
        const duplicate = await app.inject({
          method: 'POST',
          url: `${API_BASE}/auth/${prefix}register`,
          headers: prefix ? { origin: config.corsOrigins[0]! } : {},
          payload: { ...body, phone: ` ${phone} ` },
        });
        expect(duplicate.statusCode, duplicate.body).toBe(409);
        expect(duplicate.json().code).toBe('PHONE_ALREADY_REGISTERED');
      }
      expect(await prisma.user.count({ where: { phoneE164: `+86${phone}` } })).toBe(1);
    } catch (cause) {
      throw new Error('短手机号与非空短密码注册登录验证失败', { cause });
    }
  });

  it.each(['', 'browser/'])('认证输入保留空值与过长值边界：%s', async (prefix) => {
    try {
      const phone = uniquePhone();
      for (const fields of [
        { password: '' },
        { password: 'a'.repeat(129) },
        { phone: '' },
        { phone: '1'.repeat(33) },
      ]) {
        for (const action of ['register', 'login']) {
          const response = await app.inject({
            method: 'POST',
            url: `${API_BASE}/auth/${prefix}${action}`,
            headers: prefix ? { origin: config.corsOrigins[0]! } : {},
            payload: { ...registerBody(phone), ...fields },
          });
          expect(response.statusCode, response.body).toBe(400);
        }
      }
      expect(await prisma.user.count({ where: { phoneE164: `+86${phone}` } })).toBe(0);
    } catch (cause) {
      throw new Error('手机号与密码输入边界验证失败', { cause });
    }
  });

  it('登录缺少 phone 时由 schema 返回 400，不进入 handler', async () => {
    const res = await api('post', '/auth/login', {
      country_code: '+86',
      password: 'password-123456',
      device: { installation_id: randomUUID(), name: 'e2e-device', platform: 'e2e' },
    });
    expect(res.status).toBe(400);
  });

  it('1 位密码可注册，注册即返回完整会话与默认资料', async () => {
    const phone = uniquePhone();
    const res = await api('post', '/auth/register', registerBody(phone, '1'));
    expect(res.status, res.body).toBe(201);
    const session = res.json() as Session;
    expect(session.token_type).toBe('Bearer');
    expect(session.expires_in).toBe(900);
    expect(session.scopes).toEqual(
      expect.arrayContaining(['sync:read', 'sync:write', 'profile:read', 'profile:write']),
    );
    expect(session.user.user_id).toMatch(/^[\da-f-]{36}$/);
    expect(session.user).not.toHaveProperty('is_admin');
    // 完整手机号仅本人可见（产品要求完全显示）
    expect(session.user.phone).toBe(`+86${phone}`);
    expect(session.user).not.toHaveProperty('phone_masked');
    // 数据库事实断言：芝麻号 9 位无前导零、默认昵称格式、性别默认 UNSPECIFIED；
    // 无 account 占位列（单轨手机号凭据）
    const row = await prisma.user.findUniqueOrThrow({ where: { phoneE164: `+86${phone}` } });
    expect(row.sesameNumber).toMatch(/^[1-9]\d{8}$/);
    expect('account' in row).toBe(false);
    const profile = await prisma.userProfile.findUniqueOrThrow({ where: { userId: row.id } });
    expect(profile.displayName).toMatch(/^芝麻仔\d{6}$/);
    expect(profile.gender).toBe('UNSPECIFIED');
  });

  it('非 +86 区号（+852/+1）可注册，非法 E.164 被拒且不落库', async () => {
    // 每次运行生成唯一本地号码，避免重复执行时与历史数据冲突
    const now8 = String(Date.now()).slice(-8);
    for (const [code, local] of [
      ['+852', now8],
      ['+1', `2${now8}1`],
      ['+61', `4${now8}2`],
    ] as const) {
      const res = await api('post', '/auth/register', { ...registerBody('unused'), country_code: code, phone: local });
      expect(res.status, `${code} 应可注册`).toBe(201);
    }
    // 非法：本地号码含字母
    const bad1 = await api('post', '/auth/register', { ...registerBody('unused'), phone: '1380013800a' });
    expect(bad1.status).toBe(400);
    expect((bad1.json() as { code: string }).code).toBe('PHONE_INVALID');
    // 非法：总位数超 15 位
    const bad2 = await api('post', '/auth/register', { ...registerBody('unused'), phone: '13800138000123456789' });
    expect(bad2.status).toBe(400);
    expect((bad2.json() as { code: string }).code).toBe('PHONE_INVALID');
    // 非法：本地号码为纯空格/短横线（规范化后为空）
    const bad3 = await api('post', '/auth/register', { ...registerBody('unused'), phone: ' - ' });
    expect(bad3.status).toBe(400);
    // 数据库零残留：全部失败注册都没有创建用户
    expect(await prisma.user.count({ where: { phoneE164: { contains: 'unused' } } })).toBe(0);
  });

  it('同手机号并发注册只能成功一个', async () => {
    const phone = uniquePhone();
    const [first, second] = await Promise.all([
      api('post', '/auth/register', registerBody(phone)),
      api('post', '/auth/register', registerBody(phone)),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
    const failed = first.status === 409 ? first : second;
    expect((failed.json() as { code: string }).code).toBe('PHONE_ALREADY_REGISTERED');
    // 数据库最终只有一行
    expect(await prisma.user.count({ where: { phoneE164: `+86${phone}` } })).toBe(1);
  });

  it('连接池被占满时并发注册排队等待，仍返回 409 而不是事务超时 500', async () => {
    // 单连接池 + 长事务占满连接：注册必须排队等待，不能把排队超时暴露成 500
    const limitedUrl = new URL(DATABASE_URL);
    limitedUrl.searchParams.set('connection_limit', '1');
    const limitedPrisma = new PrismaClient({ datasourceUrl: limitedUrl.toString() });
    const limitedApp = buildApp({
      logger: false,
      config: { ...config, databaseUrl: limitedUrl.toString() },
      prisma: limitedPrisma,
    });
    const blocker = limitedPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_sleep(4)');
    });
    try {
      await limitedApp.ready();
      const phone = uniquePhone();
      const [first, second] = await Promise.all([
        limitedApp.inject({ method: 'POST', url: `${API_BASE}/auth/register`, payload: registerBody(phone) }),
        limitedApp.inject({ method: 'POST', url: `${API_BASE}/auth/register`, payload: registerBody(phone) }),
      ]);
      expect([first.statusCode, second.statusCode].sort((left, right) => left - right)).toEqual([201, 409]);
      const failed = first.statusCode === 409 ? first : second;
      expect((JSON.parse(failed.body) as { code: string }).code).toBe('PHONE_ALREADY_REGISTERED');
      expect(await prisma.user.count({ where: { phoneE164: `+86${phone}` } })).toBe(1);
    } finally {
      await blocker;
      await limitedApp.close();
    }
    // 该用例本身要占满单连接池并等待 pg_sleep(4)，默认 5s 预算在全量并行执行时不足。
  }, 30_000);

  it('默认昵称不唯一、芝麻号唯一：多次注册互不冲突', async () => {
    const phones = [uniquePhone(), uniquePhone()];
    for (const phone of phones) {
      const res = await api('post', '/auth/register', registerBody(phone));
      expect(res.status, res.body).toBe(201);
    }
    const rows = await prisma.user.findMany({
      where: { phoneE164: { in: phones.map((p) => `+86${p}`) } },
      select: { sesameNumber: true },
    });
    expect(new Set(rows.map((r) => r.sesameNumber)).size).toBe(2);
  });

  it.each(['device', 'refreshToken'] as const)('%s 写入后故障时 User/Profile/Device/Token 全部回滚', async (kind) => {
    const phone = uniquePhone();
    const injected: RegistrationFailPoint = { kind };
    failPoint = injected;
    try {
      const res = await api('post', '/auth/register', registerBody(phone));
      expect(res.status, res.body).toBe(500);
      expect((res.json() as { code: string }).code).toBe('REGISTER_FAILED');
      // 先确认用户与设备确实保存过，避免前置异常让零残留断言产生假通过。
      expect(injected.userId).toEqual(expect.any(String));
      expect(injected.deviceId).toEqual(expect.any(String));
      if (kind === 'refreshToken') expect(injected.refreshTokenId).toEqual(expect.any(String));
      expect(await prisma.user.count({ where: { phoneE164: `+86${phone}` } })).toBe(0);
      expect(await prisma.userProfile.count({ where: { userId: injected.userId! } })).toBe(0);
      expect(await prisma.device.count({ where: { userId: injected.userId! } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { userId: injected.userId! } })).toBe(0);
      expect(await prisma.productAnalyticsEvent.count({ where: { eventId: injected.userId! } })).toBe(0);
    } catch (cause) {
      throw new Error('注册事务后继写入故障回滚验证失败', { cause });
    } finally {
      failPoint = null;
    }
  });

  it('JWT 预签名失败时数据库零残留', async () => {
    // NaN 有效期让 jose 在设置过期时间时抛错，注册事务必须整体回滚。
    const brokenConfig: ApiConfig = { ...config, accessTokenTtlSeconds: Number.NaN };
    const brokenApp = buildApp({ logger: false, config: brokenConfig, prisma: prisma as unknown as PrismaClient });
    await brokenApp.ready();
    const phone = uniquePhone();
    try {
      const res = await brokenApp.inject({
        method: 'POST',
        url: `${API_BASE}/auth/register`,
        payload: registerBody(phone),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(500);
      expect((res.json() as { code: string }).code).toBe('REGISTER_FAILED');
    } finally {
      await brokenApp.close();
    }
    expect(await prisma.user.count({ where: { phoneE164: `+86${phone}` } })).toBe(0);
  });

  it('芝麻号碰撞从新事务完整重试，重试后注册成功', async () => {
    const phone = uniquePhone();
    failPoint = { kind: 'sesameCollision' };
    collisionInjected = false;
    try {
      const res = await api('post', '/auth/register', registerBody(phone));
      expect(res.status, res.body).toBe(201);
    } finally {
      failPoint = null;
    }
    // 碰撞注入者 + 重试成功者各一行；重试者的芝麻号仍是 9 位
    const row = await prisma.user.findUniqueOrThrow({ where: { phoneE164: `+86${phone}` } });
    expect(row.sesameNumber).toMatch(/^[1-9]\d{8}$/);
    expect(collisionInjected).toBe(true);
  });

  it('登录只认手机号：account 字段不是合法输入，手机号错误密码返回统一 401', async () => {
    const phone = uniquePhone();
    const password = 'login-check';
    const res = await api('post', '/auth/register', registerBody(phone, password));
    expect(res.status, res.body).toBe(201);

    // account 不能替代必填的 country_code 和 phone，缺少手机号凭据时返回 400。
    const accountAttempt = await api('post', '/auth/login', {
      account: 'whatever',
      password,
      device: { installation_id: randomUUID(), name: 'e2e', platform: 'e2e' },
    });
    expect(accountAttempt.status).toBe(400);

    // 手机号 + 错误密码 → 401 统一文案（防枚举）
    const badPass = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password: 'wrong-password',
      device: { installation_id: randomUUID(), name: 'e2e', platform: 'e2e' },
    });
    expect(badPass.status).toBe(401);
    expect((badPass.json() as { code: string }).code).toBe('INVALID_CREDENTIALS');

    // 手机号 + 正确密码 → 200
    const ok = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password,
      device: { installation_id: randomUUID(), name: 'e2e', platform: 'e2e' },
    });
    expect(ok.status).toBe(200);
  });

  it('Access Token 在账号停用或签发设备撤销后立即失效', async () => {
    const phone = uniquePhone();
    const registered = await api('post', '/auth/register', registerBody(phone));
    expect(registered.status).toBe(201);
    const session = registered.json() as Session;

    expect((await api('get', '/profile/me', undefined, session.access_token)).status).toBe(200);

    await prisma.user.update({ where: { id: session.user.user_id }, data: { isEnabled: false } });
    expect((await api('get', '/profile/me', undefined, session.access_token)).status).toBe(401);

    await prisma.user.update({ where: { id: session.user.user_id }, data: { isEnabled: true } });
    await prisma.device.update({ where: { id: session.device_id }, data: { revokedAt: new Date() } });
    expect((await api('get', '/profile/me', undefined, session.access_token)).status).toBe(401);
  });
});

describe('刷新令牌轮换宽限（安装更新/杀进程不再掉登录）', () => {
  it('同设备后继令牌已签发时，刚被轮换的旧令牌在窗口内仍可换发', async () => {
    const phone = uniquePhone();
    const registered = await api('post', '/auth/register', registerBody(phone));
    expect(registered.status).toBe(201);
    const first = registered.json() as Session;

    // 第一次刷新：服务端立刻作废旧令牌并签发后继令牌
    const second = await api('post', '/auth/refresh', { refresh_token: first.refresh_token });
    expect(second.status).toBe(200);
    const rotated = second.json() as Session;

    // 客户端还没落盘新令牌就被系统停进程：拿旧令牌重试，宽限窗口内仍换发成功
    const retried = await api('post', '/auth/refresh', { refresh_token: first.refresh_token });
    expect(retried.status).toBe(200);
    expect((retried.json() as Session).refresh_token).not.toBe(first.refresh_token);

    // 已落盘的后继令牌不受影响，继续可用
    expect((await api('post', '/auth/refresh', { refresh_token: rotated.refresh_token })).status).toBe(200);
  });

  it('登出整设备撤销：宽限重试留下的兄弟令牌一起失效', async () => {
    const phone = uniquePhone();
    const registered = await api('post', '/auth/register', registerBody(phone));
    const first = registered.json() as Session;

    // 轮换 + 宽限重试：同设备同时存在多条令牌（后一条是宽限补发）
    const rotated = (await api('post', '/auth/refresh', { refresh_token: first.refresh_token })).json() as Session;
    const retried = (await api('post', '/auth/refresh', { refresh_token: first.refresh_token })).json() as Session;
    expect((await api('post', '/auth/refresh', { refresh_token: rotated.refresh_token })).status).toBe(200);

    // 用其中一条登出：该设备其余令牌（含宽限补发的）必须一并失效
    expect(
      (await api('post', '/auth/logout', { refresh_token: retried.refresh_token }, retried.access_token)).status,
    ).toBe(204);

    expect((await api('post', '/auth/refresh', { refresh_token: first.refresh_token })).status).toBe(401);
    expect((await api('post', '/auth/refresh', { refresh_token: retried.refresh_token })).status).toBe(401);
  });

  it('登出撤销的令牌没有后继令牌，仍按失效处理', async () => {
    const phone = uniquePhone();
    const registered = await api('post', '/auth/register', registerBody(phone));
    const session = registered.json() as Session;
    const loggedOut = await api('post', '/auth/logout', { refresh_token: session.refresh_token }, session.access_token);
    expect(loggedOut.status).toBe(204);

    const after = await api('post', '/auth/refresh', { refresh_token: session.refresh_token });
    expect(after.status).toBe(401);
    expect((after.json() as { code: string }).code).toBe('INVALID_REFRESH_TOKEN');
  });
});
