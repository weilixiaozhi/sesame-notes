import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../src/shared/api-config.js';
import { CategorySchema } from '../src/shared/contracts/accounting.js';
import { registerErrorHandler } from '../src/shared/errors.js';
import type { AccessClaims } from '../src/modules/auth/index.js';
import { signAccessToken } from '../src/modules/auth/testing.js';
import { registerSharingRoutes } from '../src/modules/sharing/index.js';

type Action = 'create' | 'accept' | 'leave' | 'remove';
type Resource = 'ledger' | 'invite' | 'member';
type Revocation = 'device' | 'account' | 'credential';
const applications: ReturnType<typeof Fastify>[] = [];
const releases: Array<() => void> = [];
const config = {
  jwtSecret: 'sharing-session-access-test-at-least-32-bytes',
  accessTokenTtlSeconds: 900,
  authRateLimitMax: 1000,
} as ApiConfig;

/** 提供真实认证所读取的账号、设备与代次；仅持久化委托和可观察的行锁等待使用内存实现。 */
async function fixture(action: Action, resource: Resource) {
  try {
    const claims: AccessClaims = {
      userId: randomUUID(),
      deviceId: randomUUID(),
      authGeneration: randomUUID(),
      credentialVersion: 0,
      scopes: ['sync:read', 'sync:write'],
    };
    const state = { enabled: true, revoked: false, credentialVersion: 0 };
    const now = new Date();
    const ledger = {
      id: randomUUID(),
      ownerId: action === 'create' || action === 'remove' ? claims.userId : randomUUID(),
      syncId: randomUUID(),
      name: '共享会话测试',
      currency: 'CNY',
      monthStartDay: 1,
      aaEnabled: false,
      deletedAt: null,
    };
    const member = {
      id: randomUUID(),
      ledgerId: ledger.id,
      memberType: 'REGISTERED',
      linkedAccountId: action === 'leave' ? claims.userId : randomUUID(),
      displayName: '成员',
      role: 'editor',
      status: 'ACTIVE',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const invitation = {
      id: randomUUID(),
      ledgerId: ledger.id,
      ledger,
      role: 'editor',
      usedAt: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releases.push(() => release.resolve());
    let blocked = false;
    const lockOrder: Resource[] = [];
    /** 每个测试只暂停目标资源的首次锁请求，释放后同一事务的重复锁可以立即返回。 */
    async function lock(kind: Resource) {
      lockOrder.push(kind);
      if (kind === resource && !blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
    }
    const businessWrites = vi.fn();
    const events: Array<Record<string, unknown>> = [];
    const tx = {
      serverEpoch: { findUniqueOrThrow: vi.fn(async () => ({ authGeneration: claims.authGeneration })) },
      device: {
        findFirst: vi.fn(async ({ where }: { where: { user: { credentialVersion: number } } }) =>
          state.enabled && !state.revoked && state.credentialVersion === where.user.credentialVersion
            ? { id: claims.deviceId }
            : null,
        ),
      },
      ledger: { findUnique: vi.fn(async () => ledger) },
      ledgerInvite: {
        findUnique: vi.fn(async () => invitation),
        updateMany: vi.fn(async () => {
          businessWrites('invite-update');
          return { count: 1 };
        }),
        create: vi.fn(async ({ data }: { data: object }) => {
          businessWrites('invite-create');
          return { id: randomUUID(), ...data };
        }),
      },
      user: { findUnique: vi.fn(async () => ({ profile: { displayName: '受邀成员' } })) },
      ledgerMember: {
        findUnique: vi.fn(async () => member),
        findUniqueOrThrow: vi.fn(async () => member),
        upsert: vi.fn(async ({ create }: { create: object }) => {
          businessWrites('member-create');
          return { ...member, ...create };
        }),
        updateMany: vi.fn(async ({ data }: { data: Partial<typeof member> }) => {
          businessWrites('member-update');
          Object.assign(member, data);
          return { count: 1 };
        }),
        update: vi.fn(async ({ data }: { data: Partial<typeof member> }) => {
          businessWrites('member-update');
          Object.assign(member, data);
          return { ...member };
        }),
      },
      syncChange: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          businessWrites('sync-event');
          events.push(data);
          return { changeId: BigInt(events.length) };
        }),
      },
      $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
        expect(sql.join('')).toContain('pg_advisory_xact_lock');
        return 0;
      }),
      $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
        const text = sql.join('');
        expect(text).toContain('FOR UPDATE');
        if (text.includes('FROM "ledger_invites"')) {
          await lock('invite');
          return [{ id: invitation.id }];
        }
        if (text.includes('FROM "ledger_members"')) {
          await lock('member');
          return [member];
        }
        expect(text).toContain('FROM "ledgers"');
        await lock('ledger');
        return [ledger];
      }),
    };
    const prisma = {
      ...tx,
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    } as unknown as PrismaClient;
    const app = Fastify({ logger: false });
    applications.push(app);
    app.addSchema(CategorySchema);
    registerErrorHandler(app);
    registerSharingRoutes(app, prisma, config);
    await app.ready();
    const token = await signAccessToken(claims, config);
    const pending = app
      .inject({
        method: action === 'remove' ? 'DELETE' : 'POST',
        url:
          action === 'accept'
            ? '/api/v1/invites/valid-code/accept'
            : `/api/v1/ledgers/${ledger.id}/${action === 'create' ? 'invites' : action === 'leave' ? 'leave' : `members/${member.id}`}`,
        headers: { authorization: `Bearer ${token}` },
        ...(action === 'create' ? { payload: {} } : {}),
      })
      .then((response) => response);
    await Promise.race([
      entered.promise,
      pending.then((response) => {
        throw new Error(`请求未进入${resource}等待门，响应${response.statusCode}：${response.body}`);
      }),
    ]);
    return { state, tx, pending, release: () => release.resolve(), businessWrites, events, lockOrder };
  } catch (cause) {
    throw new Error('共享会话行锁回归夹具初始化失败', { cause });
  }
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

const targets = [
  ['create', 'ledger'],
  ['accept', 'ledger'],
  ['accept', 'invite'],
  ['leave', 'member'],
  ['remove', 'member'],
] as const;
const invalidations: Revocation[] = ['device', 'account', 'credential'];

describe('共享写入在行锁等待后的真实会话复查', () => {
  it.each([`${'a'.repeat(63)}😀`, '😀'.repeat(64)])('接受邀请时完整保留昵称的 Unicode 码点：%s', async (name) => {
    try {
      const context = await fixture('accept', 'invite');
      context.tx.user.findUnique.mockResolvedValue({ profile: { displayName: name } });
      context.release();
      const response = await context.pending;
      expect(response.statusCode, response.body).toBe(200);
      const event = context.events.find((entry) => entry.entityType === 'member');
      expect(event?.payload).toMatchObject({ display_name: name });
      expect((event?.payload as { display_name: string }).display_name.isWellFormed()).toBe(true);
    } catch (cause) {
      throw new Error('受邀成员昵称快照 Unicode 边界验证失败', { cause });
    }
  });

  it.each(
    targets.flatMap(([action, resource]) => invalidations.map((revocation) => ({ action, resource, revocation }))),
  )('$action等待$resource期间发生$revocation变更，401且业务与事件零写入', async ({ action, resource, revocation }) => {
    const context = await fixture(action, resource);
    if (revocation === 'device') context.state.revoked = true;
    if (revocation === 'account') context.state.enabled = false;
    if (revocation === 'credential') context.state.credentialVersion++;
    context.release();
    const response = await context.pending;
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED', message: '登录状态已失效' });
    expect(context.businessWrites).not.toHaveBeenCalled();
    expect(context.events).toEqual([]);
    expect(context.tx.device.findFirst).toHaveBeenCalledTimes(2);
  });

  it.each(targets)('%s取得%s行锁后，合法会话仍完成原操作及同步事件', async (action, resource) => {
    const context = await fixture(action, resource);
    context.release();
    const response = await context.pending;
    expect(response.statusCode, response.body).toBe(action === 'create' ? 201 : action === 'accept' ? 200 : 204);
    expect(context.businessWrites).toHaveBeenCalled();
    expect(context.events).toHaveLength(action === 'create' ? 0 : action === 'accept' ? 2 : 1);
    expect(context.lockOrder[0]).toBe('ledger');
    if (action !== 'create') expect(context.lockOrder.at(-1)).toBe(action === 'accept' ? 'invite' : 'member');
  });
});
