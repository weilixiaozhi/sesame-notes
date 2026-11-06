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

let injectCollision = false;
let collisionInjected = false;

/** 构建带故障注入的 Prisma 客户端（Client Extension 只在测试中使用）。 */
function buildTestPrisma() {
  try {
    const base = new PrismaClient({ datasourceUrl: DATABASE_URL });
    return base.$extends({
      query: {
        user: {
          /** 在独立事务中占用芝麻号，使注册遭遇真实唯一约束冲突。 */
          async create({
            args,
            query,
          }: {
            args: Prisma.UserCreateArgs;
            query: (a: Prisma.UserCreateArgs) => Promise<unknown>;
          }) {
            try {
              const data = args.data as { sesameNumber?: string };
              if (injectCollision && !collisionInjected && data.sesameNumber) {
                // 先占用同一芝麻号（绕过扩展的裸 SQL），迫使真实 create 触发唯一约束冲突
                collisionInjected = true;
                await base.$executeRaw`
                INSERT INTO users (id, phone_e164, sesame_number, password_hash, is_enabled, created_at)
                VALUES (gen_random_uuid(), ${`+1${String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)}`},
                        ${data.sesameNumber}, 'scrypt:inj', true, now())
              `;
              }
              return await query(args);
            } catch (cause) {
              console.error('注册碰撞夹具数据库写入失败：', cause);
              throw cause;
            }
          },
        },
      },
    });
  } catch (cause) {
    throw new Error('注册碰撞夹具初始化失败', { cause });
  }
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

beforeAll(async () => {
  prisma = buildTestPrisma();
  app = buildApp({ logger: false, config, prisma: prisma as unknown as PrismaClient });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('切片一：手机号账号注册模型（需求锚点）', () => {
  it.each([{ browser: true, password: '1' }])(
    '四位短手机号和宽松密码可注册并跨入口登录：browser=$browser',
    async ({ browser, password }) => {
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
    },
  );

  it.each([''])('认证输入保留空值与过长值边界：%s', async (prefix) => {
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

  it('芝麻号碰撞从新事务完整重试，重试后注册成功', async () => {
    const phone = uniquePhone();
    injectCollision = true;
    collisionInjected = false;
    try {
      const res = await api('post', '/auth/register', registerBody(phone));
      expect(res.status, res.body).toBe(201);
    } finally {
      injectCollision = false;
    }
    // 碰撞注入者 + 重试成功者各一行；重试者的芝麻号仍是 9 位
    const row = await prisma.user.findUniqueOrThrow({ where: { phoneE164: `+86${phone}` } });
    expect(row.sesameNumber).toMatch(/^[1-9]\d{8}$/);
    expect(collisionInjected).toBe(true);
  });
});
