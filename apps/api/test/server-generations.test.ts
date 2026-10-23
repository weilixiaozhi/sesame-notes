import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PrismaClient } from '@prisma/client';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { currentAuthGeneration } from '../src/shared/server-generations.js';
import { findIdempotentReplay } from '../src/shared/idempotency.js';
import { testStoragePath } from './test-storage-path.js';
import {
  assertLifecycleSuite,
  createLifecycleDatabase,
  lifecycleDatabaseSpec,
  haltLifecycleRun,
} from './lifecycle-test-database.js';
import { runLifecycleSetup } from './lifecycle-setup.js';

const API_DIR = join(import.meta.dirname, '..');
assertLifecycleSuite('server-generations.test.ts', process.env);
const specification = lifecycleDatabaseSpec('generation', process.env);
const GEN_URL = specification.url;
const API_BASE = '/api/v1';
const runFile = promisify(execFile);

const config: ApiConfig = {
  databaseUrl: GEN_URL,
  jwtSecret: 'generation-test-secret-that-is-at-least-32-bytes',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('server-generations'),
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
let lease: Awaited<ReturnType<typeof createLifecycleDatabase>> | undefined;

/** 发起真实应用内请求并按需解析响应。 */
async function api(method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: Record<string, unknown>) {
  const response = await app.inject({
    method,
    url: `${API_BASE}${path}`,
    payload: body,
    headers: body ? { 'content-type': 'application/json' } : {},
  });
  return {
    status: response.statusCode,
    json: (): unknown => (response.body ? JSON.parse(response.body) : null),
  };
}

/** 生成每次调用唯一且可登录的手机号（+86 区号，11 位） */
function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

/** 创建当前测试独享的用户并返回登录凭据。 */
async function registerUser(): Promise<{ userId: string; refreshToken: string; accessToken: string; phone: string }> {
  const phone = uniquePhone();
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone,
    password: 'password-123456',
    device: { installation_id: randomUUID(), name: 'gen-device', platform: 'test' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as { refresh_token: string; access_token: string; user: { user_id: string } };
  return {
    userId: session.user.user_id,
    refreshToken: session.refresh_token,
    accessToken: session.access_token,
    phone,
  };
}

/** 通过真实 CLI 进程验证参数、独占窗口和最终数据库提交，目标始终来自本轮租约。 */
async function recoveryCli(mode: '--inspect' | '--apply') {
  try {
    const url = new URL(GEN_URL);
    const { stdout, stderr } = await runFile(
      process.execPath,
      [join(API_DIR, 'node_modules/tsx/dist/cli.mjs'), join(API_DIR, 'src/server-recover.ts'), mode],
      {
        cwd: API_DIR,
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          DATABASE_URL: GEN_URL,
          SERVER_RECOVERY_CONFIRM: `${url.hostname}:${url.port}${url.pathname}`,
          SERVER_RECOVERY_MAINTENANCE: 'API_STOPPED',
          SERVER_RECOVERY_OPERATOR: '生命周期验收',
          SERVER_RECOVERY_REASON: '验证恢复后的认证、幂等及私有绑定边界',
          SERVER_RECOVERY_BACKUP_REFERENCE: 'generated-fixture-only',
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const error = cause as Error & { code?: number; stdout?: string; stderr?: string };
    if (typeof error.code === 'number')
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    throw new Error('恢复 CLI 进程无法完成', { cause });
  }
}

beforeAll(async () => {
  try {
    lease = await createLifecycleDatabase(specification, process.env);
    await runLifecycleSetup(GEN_URL, join(API_DIR, 'prisma/setup.mjs'), API_DIR);
    prisma = lease.prisma;
    app = buildApp({ logger: false, config, prisma });
    await app.ready();
  } catch (error) {
    const failures = [error];
    try {
      haltLifecycleRun(process.env, 'Generation fixture initialization failed.');
    } catch (haltError) {
      failures.push(haltError);
    }
    try {
      await app?.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    try {
      await lease?.close();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    throw new AggregateError(failures, 'Generation fixture initialization failed.');
  }
}, 180_000);

afterAll(async () => {
  const failures: unknown[] = [];
  try {
    await app?.close();
  } catch (error) {
    failures.push(error);
    try {
      haltLifecycleRun(process.env, 'Generation app cleanup failed.');
    } catch (haltError) {
      failures.push(haltError);
    }
  }
  try {
    await lease?.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'Generation fixture cleanup failed.');
});

describe('服务端 generation 基础设施', () => {
  it('server_epochs 单例行存在：auth_generation / idempotency_generation 为随机 UUID', async () => {
    const row = await prisma.serverEpoch.findUnique({ where: { id: 0 } });
    expect(row).not.toBeNull();
    // 随机 generation：轮换后不会回到历史值
    expect(row!.authGeneration).toMatch(/^[0-9a-f-]{36}$/);
    expect(row!.idempotencyGeneration).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refresh token 携带 auth_generation：登录后与当前一致', async () => {
    const { userId } = await registerUser();
    const current = await currentAuthGeneration(prisma);
    const tokens = await prisma.refreshToken.findMany({ where: { userId } });
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(t.authGeneration).toBe(current);
  });

  it('auth_generation 轮换后：旧 refresh token 失效，新登录可用', async () => {
    const { refreshToken, phone } = await registerUser();
    const before = await currentAuthGeneration(prisma);
    // 随机 UUID 轮换：旧值不会复现
    await prisma.$executeRaw`UPDATE server_epochs SET auth_generation = gen_random_uuid(), idempotency_generation = gen_random_uuid() WHERE id = 0`;
    const after = await currentAuthGeneration(prisma);
    expect(after).not.toBe(before);

    // 旧 refresh token 失效（401）
    const refreshRes = await api('post', '/auth/refresh', { refresh_token: refreshToken });
    expect(refreshRes.status).toBe(401);
    // 新登录可用
    const login = await api('post', '/auth/login', {
      country_code: '+86',
      phone,
      password: 'password-123456',
      device: { installation_id: randomUUID(), name: 'gen-device', platform: 'test' },
    });
    expect(login.status).toBe(200);
  });

  it('恢复 CLI 要求独占窗口并原子轮换全部绑定和会话，审计失败则整体回滚', async () => {
    let observer: PrismaClient | undefined;
    try {
      const session = await registerUser();
      const created = await app.inject({
        method: 'POST',
        url: `${API_BASE}/ledgers`,
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: '恢复演练账本' },
      });
      expect(created.statusCode, created.body).toBe(201);
      const ledger = await prisma.ledger.findUniqueOrThrow({ where: { id: created.json().id } });
      const time = new Date('2025-01-02T03:04:05.006Z');
      const dayBook = await prisma.dayBook.create({
        data: { ownerId: session.userId, name: '日子', createdAt: time, updatedAt: time, revision: 7 },
      });
      const memoBook = await prisma.memoBook.create({
        data: {
          id: randomUUID(),
          ownerId: session.userId,
          name: '备忘录',
          type: 'normal',
          createdAt: time,
          updatedAt: time,
          revision: 9,
          deletedAt: time,
        },
      });
      const fitnessSpace = await prisma.fitnessSpace.create({
        data: {
          id: randomUUID(),
          ownerId: session.userId,
          name: '健身',
          createdAt: time,
          updatedAt: time,
          revision: 11,
        },
      });
      const before = await prisma.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      const key = `restore:${randomUUID()}`;
      await prisma.idempotencyKey.create({
        data: {
          userId: session.userId,
          key,
          requestHash: 'a'.repeat(64),
          response: { stale: true },
          generation: before.idempotencyGeneration,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const admin = await prisma.adminAccount.create({
        data: { username: 'recovery_fixture', displayName: '恢复测试', passwordHash: 'test-only' },
      });
      const adminSession = await prisma.adminSession.create({
        data: { adminId: admin.id, tokenHash: 'f'.repeat(64), expiresAt: new Date(Date.now() + 60_000) },
      });
      await app.close();
      const inspection = await recoveryCli('--inspect');
      expect(inspection.code, inspection.stderr).toBe(0);
      expect(JSON.parse(inspection.stdout).mode).toBe('inspect');

      observer = new PrismaClient({ datasourceUrl: GEN_URL });
      await observer.$queryRaw`SELECT 1`;
      const occupied = await recoveryCli('--apply');
      expect(occupied.code).toBe(1);
      expect(occupied.stderr).toContain('其他客户端连接');
      expect(await observer.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toEqual(before);
      await observer.$disconnect();

      // 注入事务末尾审计失败，证明身份轮换不会在审计未落库时部分提交。
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION recovery_fixture_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'server.recovery_prepared' THEN RAISE EXCEPTION '恢复演练审计拒绝'; END IF; RETURN NEW; END $$`,
      );
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER recovery_fixture_reject_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION recovery_fixture_reject_audit()',
      );
      await prisma.$disconnect();
      try {
        const rejected = await recoveryCli('--apply');
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toContain('恢复演练审计拒绝');
        expect(await prisma.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toEqual(before);
        expect(await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })).toEqual(ledger);
        expect(await prisma.adminSession.findUniqueOrThrow({ where: { id: adminSession.id } })).toEqual(adminSession);
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER recovery_fixture_reject_audit ON audit_logs');
        await prisma.$executeRawUnsafe('DROP FUNCTION recovery_fixture_reject_audit()');
        await prisma.$disconnect();
      }
      const recovered = await recoveryCli('--apply');
      expect(recovered.code, recovered.stderr).toBe(0);
      const receipt = JSON.parse(recovered.stdout) as { operation_id: string };
      const after = await prisma.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      expect(after.authGeneration).not.toBe(before.authGeneration);
      expect(after.idempotencyGeneration).not.toBe(before.idempotencyGeneration);
      const books = [
        [ledger, await prisma.ledger.findUniqueOrThrow({ where: { id: ledger.id } })],
        [dayBook, await prisma.dayBook.findUniqueOrThrow({ where: { id: dayBook.id } })],
        [memoBook, await prisma.memoBook.findUniqueOrThrow({ where: { id: memoBook.id } })],
        [fitnessSpace, await prisma.fitnessSpace.findUniqueOrThrow({ where: { id: fitnessSpace.id } })],
      ] as const;
      for (const [original, current] of books) {
        expect(current.syncId).not.toBe(original.syncId);
        expect(current).toEqual({ ...original, syncId: current.syncId });
      }
      expect(
        (await prisma.adminSession.findUniqueOrThrow({ where: { id: adminSession.id } })).revokedAt,
      ).not.toBeNull();
      expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
      expect(
        await prisma.$transaction((tx) => findIdempotentReplay(tx, session.userId, key, 'a'.repeat(64), new Date())),
      ).toBeNull();
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { requestId: `cli:server-recover:${receipt.operation_id}` },
      });
      expect(audit.action).toBe('server.recovery_prepared');
      expect(audit.metadata).toMatchObject({ operator: '生命周期验收', backup_reference: 'generated-fixture-only' });
      app = buildApp({ logger: false, config, prisma });
      await app.ready();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `${API_BASE}/profile/me`,
            headers: { authorization: `Bearer ${session.accessToken}` },
          })
        ).statusCode,
      ).toBe(401);
      expect((await api('post', '/auth/refresh', { refresh_token: session.refreshToken })).status).toBe(401);
      const login = await api('post', '/auth/login', {
        country_code: '+86',
        phone: session.phone,
        password: 'password-123456',
        device: { installation_id: randomUUID(), name: 'recovery-device', platform: 'test' },
      });
      expect(login.status).toBe(200);
      const credentials = login.json() as { access_token: string };
      const stale = await app.inject({
        method: 'GET',
        url: `${API_BASE}/sync/full?ledger_id=${ledger.id}&sync_id=${ledger.syncId}`,
        headers: { authorization: `Bearer ${credentials.access_token}` },
      });
      expect(stale.statusCode, stale.body).toBe(412);
    } catch (cause) {
      throw new Error('服务器恢复真实事务验收失败', { cause });
    } finally {
      await observer?.$disconnect();
    }
  }, 90_000);
});
