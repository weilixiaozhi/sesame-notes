import { createHash, randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { hashPassword, registerAuthRoutes } from '../src/modules/auth/index.js';
import { registerErrorHandler } from '../src/shared/errors.js';

const userId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const origin = 'http://localhost:5173';
const password = 'logout-test-password';
const apps: ReturnType<typeof Fastify>[] = [];

type TokenRow = {
  id: string;
  userId: string;
  deviceId: string;
  tokenHash: string;
  authGeneration: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};
type DeviceRow = { id: string; userId: string; installationId: string; revokedAt: Date | null };
type Session = { access_token: string; refresh_token: string; device_id: string };
type TokenQuery = { where: Record<string, unknown>; include?: unknown };

/** 模拟 Prisma 使用的字段筛选运算，未知查询立即失败，不包含任何会话策略。 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === 'gt') return (actual as Date) > (value as Date);
        if (operator === 'gte') return (actual as Date) >= (value as Date);
        if (operator === 'not') return actual !== value;
        throw new Error(`测试数据库不支持筛选运算：${operator}`);
      });
    }
    return actual === expected;
  });
}

/** 使用真实路由、认证守卫和加密，只以内存行集合替代数据库，绝不连接外部数据库。 */
async function setup(browser: boolean) {
  try {
    const config = {
      ...loadConfig({
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
        JWT_SECRET: 'logout-session-isolation-test-secret-at-least-32-bytes',
        STORAGE_PATH: 'Temp/auth-logout',
      }),
      corsOrigins: [origin],
      authRateLimitMax: 1000,
    };
    const user = {
      id: userId,
      phoneE164: '+8613800138000',
      sesameNumber: '123456789',
      passwordHash: await hashPassword(password),
      credentialVersion: 0,
      isEnabled: true,
      profile: null,
    };
    const rows: TokenRow[] = [];
    const devices: DeviceRow[] = [];
    let nextLock: (() => Promise<void>) | undefined;
    const prisma = {
      serverEpoch: { upsert: vi.fn(async () => ({ authGeneration: generation })) },
      user: { findUnique: vi.fn(async () => user) },
      device: {
        findFirst: vi.fn(
          async ({ where }: { where: Record<string, unknown> }) =>
            devices.find((row) => matches(row, { id: where.id, userId: where.userId, revokedAt: null })) ?? null,
        ),
        upsert: vi.fn(async ({ where }: { where: { userId_installationId: { installationId: string } } }) => {
          const installationId = where.userId_installationId.installationId;
          const existing = devices.find((row) => row.installationId === installationId);
          if (existing) return existing;
          const device = { id: randomUUID(), userId, installationId, revokedAt: null };
          devices.push(device);
          return device;
        }),
        update: vi.fn(async () => ({})),
      },
      refreshToken: {
        findUnique: vi.fn(async ({ where, include }: TokenQuery) => {
          const row = rows.find((value) => matches(value, where));
          if (!row) return null;
          return include ? { ...row, user, device: devices.find((device) => device.id === row.deviceId) } : { ...row };
        }),
        findFirst: vi.fn(async ({ where }: TokenQuery) => rows.find((row) => matches(row, where)) ?? null),
        create: vi.fn(
          async ({ data }: { data: Omit<TokenRow, 'id' | 'createdAt' | 'revokedAt'> & Partial<TokenRow> }) => {
            const row = { id: randomUUID(), createdAt: new Date(), revokedAt: null, ...data };
            rows.push(row);
            return row;
          },
        ),
        updateMany: vi.fn(async ({ where, data }: TokenQuery & { data: Partial<TokenRow> }) => {
          const affected = rows.filter((row) => matches(row, where));
          for (const row of affected) Object.assign(row, data);
          return { count: affected.length };
        }),
      },
      $queryRaw: vi.fn(async () => {
        const action = nextLock;
        nextLock = undefined;
        await action?.();
        return [];
      }),
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(async (action: (tx: typeof prisma) => Promise<unknown>) => action(prisma));
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(cookie);
    registerErrorHandler(app);
    registerAuthRoutes(app, prisma as unknown as PrismaClient, config, async () => {
      throw new Error('登录、刷新与登出不应初始化账号分类');
    });
    await app.ready();
    const prefix = `/api/v1/auth${browser ? '/browser' : ''}`;

    /** 浏览器从 HttpOnly Cookie 取得令牌，移动端从正文取得，二者经过同一生产处理器。 */
    function readSession(response: Awaited<ReturnType<typeof app.inject>>): Session {
      const body = response.json<Session>();
      return { ...body, refresh_token: browser ? response.cookies[0]!.value : body.refresh_token };
    }

    /** 密码认证使用固定安装标识，同安装的重复登录复用设备主键。 */
    async function login(installationId: string) {
      const response = await app.inject({
        method: 'POST',
        url: `${prefix}/login`,
        headers: browser ? { origin } : {},
        payload: {
          country_code: '+86',
          phone: '13800138000',
          password,
          device: { installation_id: installationId, name: '登出隔离测试', platform: browser ? 'web' : 'flutter' },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      return readSession(response);
    }

    /** 请求只携带明确指定的凭据，用于复现旧请求晚于新登录执行的真实顺序。 */
    async function request(
      action: 'refresh' | 'logout',
      session: Session,
      token: string | undefined = session.refresh_token,
    ) {
      return app.inject({
        method: 'POST',
        url: `${prefix}/${action}`,
        headers: {
          ...(action === 'logout' ? { authorization: `Bearer ${session.access_token}` } : {}),
          ...(browser ? { origin, ...(token ? { cookie: `browser_refresh_token=${token}` } : {}) } : {}),
        },
        payload: browser ? {} : { refresh_token: token },
      });
    }

    /** 控制一条请求取得账号锁的时机，数据库筛选和令牌改动仍完全来自真实处理器。 */
    function delayNextLock() {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nextLock = async () => {
        entered();
        await wait;
      };
      return { started, release };
    }

    return { app, config, rows, prisma, login, request, readSession, delayNextLock };
  } catch (cause) {
    throw new Error('登出会话隔离测试初始化失败', { cause });
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it('生产部署即使未使用 production 运行标记，也只签发 Secure 浏览器刷新 Cookie', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  try {
    const fixture = await setup(true);
    fixture.config.deploymentEnvironment = 'prod';
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/v1/auth/browser/login',
      headers: { origin },
      payload: {
        country_code: '+86',
        phone: '13800138000',
        password,
        device: { installation_id: randomUUID(), name: '生产 Cookie 验证', platform: 'web' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.cookies).toContainEqual(expect.objectContaining({ name: 'browser_refresh_token', secure: true }));
  } catch (cause) {
    throw new Error('生产部署浏览器安全 Cookie 验证失败', { cause });
  } finally {
    vi.unstubAllEnvs();
  }
});

for (const browser of [false, true]) {
  const client = browser ? '浏览器' : '移动端';

  it(`${client}旧登出等待期间完成同安装新登录，迟到请求不能撤销新会话`, async () => {
    const fixture = await setup(browser);
    const installation = randomUUID();
    const original = await fixture.login(installation);
    const rotatedResponse = await fixture.request('refresh', original);
    expect(rotatedResponse.statusCode).toBe(200);
    const rotated = fixture.readSession(rotatedResponse);
    const lock = fixture.delayNextLock();
    let pending: ReturnType<typeof fixture.request> | undefined;
    try {
      pending = fixture.request('logout', rotated);
      await lock.started;
      const current = await fixture.login(installation);
      expect(current.device_id).toBe(original.device_id);
      lock.release();
      const result = await pending;
      expect(result.statusCode, result.body).toBe(204);
      expect(result.headers['set-cookie']).toBeUndefined();
      for (const old of [original, rotated]) {
        const response = await fixture.request('refresh', old);
        expect(response.statusCode, response.body).toBe(401);
        expect(response.json()).toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
      }
      const refreshed = await fixture.request('refresh', current);
      expect(refreshed.statusCode, refreshed.body).toBe(200);
    } catch (cause) {
      throw new Error(`${client}迟到登出隔离验证失败`, { cause });
    } finally {
      lock.release();
      if (pending) await pending;
    }
  });

  it(`${client}正常轮换旧令牌登出终止全部后继，其他安装会话不受影响`, async () => {
    try {
      const fixture = await setup(browser);
      const first = await fixture.login(randomUUID());
      const other = await fixture.login(randomUUID());
      const sessions = [first];
      for (let index = 0; index < 2; index++) {
        const refreshed = await fixture.request('refresh', first);
        expect(refreshed.statusCode, refreshed.body).toBe(200);
        sessions.push(fixture.readSession(refreshed));
      }
      const logout = await fixture.request('logout', first);
      expect(logout.statusCode, logout.body).toBe(204);
      if (browser) expect(logout.headers['set-cookie']).toContain('browser_refresh_token=;');
      for (const session of sessions) {
        const response = await fixture.request('refresh', session);
        expect(response.statusCode, response.body).toBe(401);
      }
      const unaffected = await fixture.request('refresh', other);
      expect(unaffected.statusCode, unaffected.body).toBe(200);
    } catch (cause) {
      throw new Error(`${client}轮换后登出范围验证失败`, { cause });
    }
  });

  it.each(['unknown', 'user', 'device', 'generation'] as const)(
    `${client}登出不接受 %s 令牌扩大撤销范围`,
    async (mismatch) => {
      try {
        const fixture = await setup(browser);
        const current = await fixture.login(randomUUID());
        const presented = 'unrelated-refresh-token'.repeat(3);
        if (mismatch !== 'unknown') {
          fixture.rows.push({
            ...fixture.rows[0]!,
            id: randomUUID(),
            tokenHash: createHash('sha256').update(presented).digest('hex'),
            ...(mismatch === 'user' ? { userId: randomUUID() } : {}),
            ...(mismatch === 'device' ? { deviceId: randomUUID() } : {}),
            ...(mismatch === 'generation' ? { authGeneration: randomUUID() } : {}),
          });
        }
        const response = await fixture.request('logout', current, presented);
        expect(response.statusCode, response.body).toBe(204);
        expect(response.headers['set-cookie']).toBeUndefined();
        const valid = await fixture.request('refresh', current);
        expect(valid.statusCode, valid.body).toBe(200);
      } catch (cause) {
        throw new Error(`${client}登出令牌归属验证失败：${mismatch}`, { cause });
      }
    },
  );
}

it('浏览器无刷新 Cookie 的登出只清理 Cookie，不凭旧 Bearer 撤销当前会话', async () => {
  try {
    const fixture = await setup(true);
    const current = await fixture.login(randomUUID());
    const response = await fixture.request('logout', current, '');
    expect(response.statusCode, response.body).toBe(204);
    expect(response.headers['set-cookie']).toContain('browser_refresh_token=;');
    const valid = await fixture.request('refresh', current);
    expect(valid.statusCode, valid.body).toBe(200);
  } catch (cause) {
    throw new Error('无刷新 Cookie 的浏览器登出隔离验证失败', { cause });
  }
});
