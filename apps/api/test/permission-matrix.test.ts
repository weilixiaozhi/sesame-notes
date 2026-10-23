import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { registeredMemberId } from '../src/modules/accounting/index.js';

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
  corsOrigins: [],
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
  token?: string,
) {
  const response = await app.inject({
    method,
    url: `${API_BASE}${path}`,
    payload: body,
    headers: {
      ...(token ? bearer(token) : {}),
      // 任何带 body 的方法（POST/PATCH）都必须声明 JSON，否则 Fastify 不解析请求体
      ...(body ? { 'content-type': 'application/json' } : {}),
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
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

/** 注册权限矩阵所需的真实账号并返回访问令牌与账号身份。 */
async function registerUser(): Promise<{ token: string; userId: string }> {
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone: uniquePhone(),
    password: 'password-123456',
    device: { installation_id: uuid(), name: 'perm-device', platform: 'e2e' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as { access_token: string; user: { user_id: string } };
  return { token: session.access_token, userId: session.user.user_id };
}

/** 权限矩阵夹具：owner + editor（邀请即编辑）两个现任成员加入同一账本。 */
async function seedLedgerWithMembers(): Promise<{
  ledgerId: string;
  owner: { token: string; userId: string };
  editor: { token: string; userId: string };
}> {
  const owner = await registerUser();
  const editor = await registerUser();
  const ledgerId = uuid();
  const create = await api('post', '/ledgers', { id: ledgerId, name: '权限矩阵账本' }, owner.token);
  expect(create.status).toBe(201);
  const invite = await api('post', `/ledgers/${ledgerId}/invites`, {}, owner.token);
  expect(invite.status).toBe(201);
  const code = (invite.json() as { code: string }).code;
  const accept = await api('post', `/invites/${code}/accept`, {}, editor.token);
  expect(accept.status).toBe(200);
  return { ledgerId, owner, editor };
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** 权限矩阵（getLedgerWriteAccess minimumRole 语义）。 */
describe('权限矩阵（角色 × 资源）', () => {
  it('非成员同步他人账本时不泄漏同步身份，错误响应先执行资源授权', async () => {
    try {
      const { ledgerId } = await seedLedgerWithMembers();
      const outsider = await registerUser();
      const device = await prisma.device.findFirstOrThrow({ where: { userId: outsider.userId } });
      const ledger = await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } });
      const response = await api(
        'post',
        '/sync/push',
        {
          device_id: device.id,
          changes: [
            {
              mutation_id: uuid(),
              ledger_id: ledgerId,
              entity_type: 'ledger',
              entity_id: ledgerId,
              action: 'upsert',
              sync_id: uuid(),
              updated_at: new Date().toISOString(),
              payload: { name: '越权请求', currency: 'CNY', month_start_day: 1, aa_enabled: false },
            },
          ],
        },
        outsider.token,
      );
      expect(response.body).not.toContain(ledger.syncId);
      expect(response.body).not.toContain('SYNC_ID_MISMATCH');
      expect(response.status).toBe(200);
      expect(response.json()).toMatchObject({ outcomes: [{ status: 'invalid', message: '账本不存在' }] });
      expect((await prisma.ledger.findUniqueOrThrow({ where: { id: ledgerId } })).name).toBe(ledger.name);
    } catch (error) {
      throw new Error('跨用户同步身份保密验证失败', { cause: error });
    }
  });
  it('非成员读写账本均返回 404，不暴露账本是否存在', async () => {
    const { ledgerId, owner } = await seedLedgerWithMembers();
    const outsider = await registerUser();
    // 读：账本详情与交易列表 404（账本对其不可见）
    expect((await api('get', `/ledgers/${ledgerId}`, undefined, outsider.token)).status).toBe(404);
    expect((await api('get', `/ledgers/${ledgerId}/transactions`, undefined, outsider.token)).status).toBe(404);
    // 写请求也隐藏账本是否存在。
    expect((await api('patch', `/ledgers/${ledgerId}`, { name: '改' }, outsider.token)).status).toBe(404);
    const del = await api(
      'delete',
      `/ledgers/${ledgerId}/members/${registeredMemberId(ledgerId, owner.userId)}`,
      undefined,
      outsider.token,
    );
    expect(del.status).toBe(404);
  });

  it('editor：可记账，账本元数据/成员管理/邀请 403', async () => {
    const { ledgerId, owner, editor } = await seedLedgerWithMembers();
    expect((await api('patch', `/ledgers/${ledgerId}`, { name: '改' }, editor.token)).status).toBe(403);
    expect((await api('post', `/ledgers/${ledgerId}/invites`, {}, editor.token)).status).toBe(403);
    expect(
      (
        await api(
          'patch',
          `/ledgers/${ledgerId}/members/${registeredMemberId(ledgerId, owner.userId)}`,
          {},
          editor.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api(
          'delete',
          `/ledgers/${ledgerId}/members/${registeredMemberId(ledgerId, owner.userId)}`,
          undefined,
          editor.token,
        )
      ).status,
    ).toBe(403);
    // editor 记账 201
    expect(
      (
        await api(
          'post',
          `/ledgers/${ledgerId}/transactions`,
          {
            id: uuid(),
            tx_type: 'expense',
            amount: '2',
            happened_at: '2026-08-19T10:00:00.000Z',
            currency_code: 'CNY',
            native_amount: '2',
          },
          editor.token,
        )
      ).status,
    ).toBe(201);
  });

  it('owner 不可被移除（409）；跨账本 member_id 一律 404', async () => {
    const { ledgerId, owner } = await seedLedgerWithMembers();
    const ownerMemberId = registeredMemberId(ledgerId, owner.userId);
    const removeOwner = await api('delete', `/ledgers/${ledgerId}/members/${ownerMemberId}`, undefined, owner.token);
    expect(removeOwner.status).toBe(409);
    expect((removeOwner.json() as { code: string }).code).toBe('OWNER_CANNOT_BE_REMOVED');
    // 跨账本：另一账本的 member_id 在本账本操作 → 404
    const other = await seedLedgerWithMembers();
    const cross = await api(
      'delete',
      `/ledgers/${ledgerId}/members/${registeredMemberId(other.ledgerId, other.owner.userId)}`,
      undefined,
      owner.token,
    );
    expect(cross.status).toBe(404);
  });
});
