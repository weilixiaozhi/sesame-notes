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
