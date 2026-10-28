import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { registeredMemberId, resolveMemberReference } from '../src/modules/accounting/testing.js';

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

/** 注册独立账号，首台设备身份用于成员与交易同步。 */
async function registerUser(): Promise<{ token: string; deviceId: string; userId: string }> {
  const phone = uniquePhone();
  const res = await api('post', '/auth/register', {
    country_code: '+86',
    phone,
    password: 'password-123456',
    device: { installation_id: uuid(), name: 'e2e-device', platform: 'e2e' },
  });
  expect(res.status).toBe(201);
  const session = res.json() as { access_token: string; device_id: string; user: { user_id: string } };
  return { token: session.access_token, deviceId: session.device_id, userId: session.user.user_id };
}

/** 建账本 + 占位成员（member 实体）+ 一笔交易（payer=占位成员、splits 含占位成员）。 */
async function setupLedgerWithHistory(): Promise<{
  token: string;
  deviceId: string;
  ledgerId: string;
  syncId: string;
  vUser: string;
}> {
  const { token, deviceId, userId } = await registerUser();
  const ledgerId = uuid();
  const ledgerPush = await api(
    'post',
    '/sync/push',
    {
      device_id: deviceId,
      changes: [
        {
          mutation_id: uuid(),
          entity_type: 'ledger',
          entity_id: ledgerId,
          ledger_id: ledgerId,
          action: 'upsert',
          updated_at: '2026-08-22T14:00:00.000Z',
          payload: { name: '成员账本', currency: 'CNY', month_start_day: 1, aa_enabled: true },
        },
      ],
    },
    token,
  );
  const syncId = (ledgerPush.json() as { outcomes: Array<{ sync_id?: string }> }).outcomes[0]!.sync_id!;
  const vUser = uuid();
  await api(
    'post',
    '/sync/push',
    {
      device_id: deviceId,
      changes: [
        {
          mutation_id: uuid(),
          entity_type: 'member',
          entity_id: vUser,
          ledger_id: ledgerId,
          sync_id: syncId,
          action: 'upsert',
          updated_at: '2026-08-22T14:00:00.000Z',
          payload: { display_name: '老婆' },
        },
      ],
    },
    token,
  );
  // 交易：payer=虚拟成员，splits 一半虚拟成员
  const txnId = uuid();
  await api(
    'post',
    '/sync/push',
    {
      device_id: deviceId,
      changes: [
        {
          mutation_id: uuid(),
          entity_type: 'transaction',
          entity_id: txnId,
          ledger_id: ledgerId,
          sync_id: syncId,
          action: 'upsert',
          updated_at: '2026-08-22T14:00:00.000Z',
          payload: {
            tx_type: 'expense',
            amount: '100',
            happened_at: '2026-08-22T14:00:00.000Z',
            note: '历史交易',
            category_id: null,
            currency_code: 'CNY',
            native_amount: '100',
            recurring_id: null,
            payer_member_id: vUser,
            aa_mode: '2',
            splits: [
              { member_id: registeredMemberId(ledgerId, userId), amount: '60' },
              { member_id: vUser, amount: '40' },
            ],
            last_edited_at: null,
          },
        },
      ],
    },
    token,
  );
  return { token, deviceId, ledgerId, syncId, vUser };
}

/** 经真实建账本和接受邀请入口建立 ACTIVE 编辑者，成员身份与授权均由服务端生成。 */
async function setupRegisteredMember() {
  try {
    const owner = await registerUser();
    const editor = await registerUser();
    const created = await api('post', '/ledgers', { name: '成员退出验收' }, owner.token);
    expect(created.status, created.body).toBe(201);
    const ledgerId = (created.json() as { id: string }).id;
    const invitation = await api('post', `/ledgers/${ledgerId}/invites`, {}, owner.token);
    expect(invitation.status, invitation.body).toBe(201);
    const code = (invitation.json() as { code: string }).code;
    const accepted = await api('post', `/invites/${code}/accept`, undefined, editor.token);
    expect(accepted.status, accepted.body).toBe(200);
    return { owner, editor, ledgerId, memberId: registeredMemberId(ledgerId, editor.userId) };
  } catch (cause) {
    throw new Error('注册成员退出验收准备失败', { cause });
  }
}

beforeAll(async () => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ logger: false, config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('占位成员生命周期与引用锁', () => {
  it('成员移除与离线 upsert 并发时，移除提交后旧身份不能复活', async () => {
    const { token, deviceId, ledgerId, syncId, vUser } = await setupLedgerWithHistory();
    let markRemoved!: () => void;
    const removed = new Promise<void>((resolve) => {
      markRemoved = resolve;
    });
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const removal = prisma.$transaction(async (tx) => {
      await tx.ledgerMember.update({
        where: { id: vUser },
        data: { status: 'REMOVED', updatedAt: new Date() },
      });
      markRemoved();
      await removalGate;
    });
    await removed;
    const revive = api(
      'post',
      '/sync/push',
      {
        device_id: deviceId,
        changes: [
          {
            mutation_id: uuid(),
            entity_type: 'member',
            entity_id: vUser,
            ledger_id: ledgerId,
            sync_id: syncId,
            action: 'upsert',
            updated_at: new Date(Date.now() + 1_000).toISOString(),
            payload: { display_name: '离线旧身份' },
          },
        ],
      },
      token,
    );
    try {
      await expect
        .poll(
          async () => {
            const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
              SELECT EXISTS (
                SELECT 1
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock'
                  AND query ILIKE '%ledger_members%'
              ) AS "waiting"
            `;
            return state?.waiting ?? false;
          },
          { timeout: 2_000, interval: 20 },
        )
        .toBe(true);
    } finally {
      releaseRemoval();
      await removal;
    }
    const response = await revive;
    expect((response.json() as { outcomes: Array<{ status: string }> }).outcomes[0]!.status).toBe('invalid');
    expect((await prisma.ledgerMember.findUniqueOrThrow({ where: { id: vUser } })).status).toBe('REMOVED');
  });

  it('交易引用占位成员时持有共享行锁，成员更新必须等引用事务提交', async () => {
    const { ledgerId, vUser } = await setupLedgerWithHistory();
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let releaseReader!: () => void;
    const readerGate = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    const reader = prisma.$transaction(async (tx) => {
      expect(await resolveMemberReference(tx, ledgerId, { member_id: vUser })).toBe(vUser);
      markLocked();
      await readerGate;
    });
    await locked;
    const updater = prisma.$transaction((tx) =>
      tx.ledgerMember.updateMany({ where: { id: vUser }, data: { displayName: '锁后更新' } }),
    );
    try {
      const state = await Promise.race([
        updater.then(() => 'updated' as const),
        new Promise<'blocked'>((resolve) => setTimeout(resolve, 100, 'blocked')),
      ]);
      expect(state).toBe('blocked');
    } finally {
      releaseReader();
    }
    await reader;
    expect((await updater).count).toBe(1);
  });
});

describe('注册成员退出与最终状态事件', () => {
  it('所有者不能退出；编辑者退出保存 LEFT，并向本人发送一致的最终成员快照', async () => {
    try {
      const context = await setupRegisteredMember();
      const ownerRejected = await api('post', `/ledgers/${context.ledgerId}/leave`, undefined, context.owner.token);
      expect(ownerRejected.status, ownerRejected.body).toBe(409);
      expect(ownerRejected.json()).toMatchObject({ code: 'OWNER_CANNOT_LEAVE' });
      const before = await prisma.ledgerMember.findUniqueOrThrow({ where: { id: context.memberId } });
      const scope = { entityType: 'member', entityId: context.memberId };
      const eventsBefore = await prisma.syncChange.count({ where: scope });
      const response = await api('post', `/ledgers/${context.ledgerId}/leave`, undefined, context.editor.token);
      expect(response.status, response.body).toBe(204);
      const left = await prisma.ledgerMember.findUniqueOrThrow({ where: { id: context.memberId } });
      expect(left).toMatchObject({
        ...before,
        status: 'LEFT',
        updatedAt: expect.any(Date),
        updatedByDeviceId: context.editor.deviceId,
      });
      expect(left.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
      const event = await prisma.syncChange.findFirstOrThrow({ where: scope, orderBy: { changeId: 'desc' } });
      expect(event).toMatchObject({
        ledgerId: context.ledgerId,
        recipientUserId: context.editor.userId,
        action: 'upsert',
        payload: {
          id: left.id,
          ledger_id: context.ledgerId,
          display_name: left.displayName,
          member_type: 'REGISTERED',
          linked_account_id: context.editor.userId,
          role: 'editor',
          status: 'LEFT',
          updated_at: left.updatedAt.toISOString(),
        },
      });
      expect(await prisma.syncChange.count({ where: scope })).toBe(eventsBefore + 1);
    } catch (cause) {
      throw new Error('成员退出的角色、持久状态与最终事件验收失败', { cause });
    }
  });

  it.each(['LEFT', 'REMOVED'] as const)('已有 %s 成员退出仍由授权边界拒绝，不改状态或增加事件', async (status) => {
    try {
      const context = await setupRegisteredMember();
      const transitioned =
        status === 'LEFT'
          ? await api('post', `/ledgers/${context.ledgerId}/leave`, undefined, context.editor.token)
          : await api(
              'delete',
              `/ledgers/${context.ledgerId}/members/${context.memberId}`,
              undefined,
              context.owner.token,
            );
      expect(transitioned.status, transitioned.body).toBe(204);
      const before = await prisma.ledgerMember.findUniqueOrThrow({ where: { id: context.memberId } });
      const scope = { entityType: 'member', entityId: context.memberId };
      const eventsBefore = await prisma.syncChange.count({ where: scope });
      const response = await api('post', `/ledgers/${context.ledgerId}/leave`, undefined, context.editor.token);
      expect(response.status, response.body).toBe(404);
      expect(response.json()).toMatchObject({ code: 'LEDGER_NOT_FOUND' });
      expect(await prisma.ledgerMember.findUniqueOrThrow({ where: { id: context.memberId } })).toEqual(before);
      expect(await prisma.syncChange.count({ where: scope })).toBe(eventsBefore);
    } catch (cause) {
      throw new Error('失效成员退出的授权边界验收失败', { cause });
    }
  });

  it('退出事件写入失败时回滚成员状态，重试只提交一次最终事件', async () => {
    const context = await setupRegisteredMember();
    const cause = new Error('member final event storage unavailable');
    const failingPrisma = new PrismaClient({ datasourceUrl: DATABASE_URL }).$extends({
      query: {
        syncChange: {
          /** 只使本轮目标成员的最终事件失败，其余真实数据库读写和事务回滚保持执行。 */
          async create({ args, query }) {
            if (args.data.entityType === 'member' && args.data.entityId === context.memberId) throw cause;
            return query(args);
          },
        },
      },
    });
    const failures: Error[] = [];
    const failingApp = buildApp({ logger: false, config, prisma: failingPrisma as unknown as PrismaClient });
    failingApp.addHook('onError', async (_request, _reply, error) => {
      failures.push(error);
    });
    try {
      const before = await prisma.ledgerMember.findUniqueOrThrow({ where: { id: context.memberId } });
      const scope = { entityType: 'member', entityId: context.memberId };
      const eventsBefore = await prisma.syncChange.count({ where: scope });
      const response = await failingApp.inject({
        method: 'POST',
        url: `${API_BASE}/ledgers/${context.ledgerId}/leave`,
        headers: bearer(context.editor.token),
      });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toMatchObject({ code: 'SHARING_OPERATION_FAILED' });
      expect(failures).toHaveLength(1);
      let original: unknown = failures[0];
      while (original instanceof Error && original.cause !== undefined) original = original.cause;
      expect(original).toBe(cause);
      expect(await prisma.ledgerMember.findUniqueOrThrow({ where: { id: context.memberId } })).toEqual(before);
      expect(await prisma.syncChange.count({ where: scope })).toBe(eventsBefore);
      const retried = await api('post', `/ledgers/${context.ledgerId}/leave`, undefined, context.editor.token);
      expect(retried.status, retried.body).toBe(204);
      expect((await prisma.ledgerMember.findUniqueOrThrow({ where: { id: context.memberId } })).status).toBe('LEFT');
      expect(await prisma.syncChange.count({ where: scope })).toBe(eventsBefore + 1);
    } catch (error) {
      throw new Error('成员退出事件失败的事务回滚与重试验收失败', { cause: error });
    } finally {
      await failingApp.close();
    }
  });
});
