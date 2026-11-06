import cookiePlugin from '@fastify/cookie';
import { Prisma, type AdminSession, type PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { registerAdminAccountRoutes } from './admin-accounts.js';
import { registerAdminAuthRoutes } from './admin-auth.js';
import { adminAuditSummary } from './admin-audit.js';
import { DEFAULT_ADMIN_GROUP_ID, type AdminAccountWithGroup } from './admin-policy.js';
import { hashAdminPassword } from './admin-security.js';
import { normalizeAdminEmail, normalizeAdminLoginIdentifier, normalizeAdminPhone } from './admin-identifiers.js';

const ORIGIN = 'https://admin.example.test';
const INITIAL_PASSWORD = 'r';
let initialHash: string;

beforeAll(async () => {
  initialHash = await hashAdminPassword(INITIAL_PASSWORD);
});

/** 构造完整的后台账号；此测试仅使用内存记录，不建立数据库连接。 */
function accountFixture(username: string, identityType = 'standard_user'): AdminAccountWithGroup {
  const now = new Date();
  return {
    id: randomUUID(),
    username,
    email: null,
    phone: null,
    displayName: username,
    passwordHash: initialHash,
    identityType,
    groupId: DEFAULT_ADMIN_GROUP_ID,
    group: {
      id: DEFAULT_ADMIN_GROUP_ID,
      name: '默认分组',
      description: '',
      sort: 0,
      isEnabled: true,
      permissions: [],
      pageIds: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
      deletedAt: null,
    },
    version: 1,
    isEnabled: true,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
  };
}

/** 注册真实路由和 Cookie 守卫，以内存替身验证输入、散列和会话撤销的完整路径。 */
async function setupRoutes() {
  const app = Fastify({ logger: false });
  try {
    const root = accountFixture('root_admin', 'super_admin');
    const accounts = new Map([[root.id, root]]);
    const sessions = new Map<string, AdminSession>();
    const prisma = {
      adminAccount: {
        findUnique: vi.fn(
          async ({ where }: { where: { id?: string; username?: string; email?: string; phone?: string } }) => {
            const account = [...accounts.values()].find(
              (row) =>
                row.id === where.id ||
                row.username === where.username ||
                (where.email !== undefined && row.email === where.email) ||
                (where.phone !== undefined && row.phone === where.phone),
            );
            return account ? { ...account } : null;
          },
        ),
        create: vi.fn(async ({ data }: { data: Partial<AdminAccountWithGroup> & { username: string } }) => {
          const account = { ...accountFixture(data.username), ...data };
          accounts.set(account.id, account);
          return account;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const account = accounts.get(where.id)!;
          const next = { ...account, ...data, version: data.version ? account.version + 1 : account.version };
          accounts.set(account.id, next);
          return next;
        }),
      },
      adminGroup: { findUnique: vi.fn(async () => root.group) },
      adminSession: {
        create: vi.fn(async ({ data }: { data: Omit<AdminSession, 'id' | 'revokedAt'> }) => {
          const session = { ...data, id: randomUUID(), revokedAt: null };
          sessions.set(session.id, session);
          return { ...session, admin: accounts.get(session.adminId)! };
        }),
        findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
          const session = [...sessions.values()].find((row) => row.tokenHash === where.tokenHash);
          return session ? { ...session, admin: accounts.get(session.adminId)! } : null;
        }),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async ({ where }: { where: { adminId?: string; tokenHash?: string } }) => {
          for (const session of sessions.values()) {
            if (session.adminId === where.adminId || session.tokenHash === where.tokenHash)
              session.revokedAt = new Date();
          }
          return { count: 1 };
        }),
      },
      auditLog: { create: vi.fn(async () => ({})) },
      user: {
        findUnique: vi.fn(async () => {
          throw new Error('后台登录不能读取产品用户');
        }),
      },
      $queryRaw: vi.fn(async () => []),
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => await fn(prisma));
    const config = loadConfig({
      DATABASE_URL: 'postgresql://unused:unused@localhost:1/unused',
      JWT_SECRET: 'admin-password-test-secret-at-least-32-bytes',
      STORAGE_PATH: 'Temp/admin-password-test',
      ADMIN_ORIGINS: ORIGIN,
      AUTH_RATE_LIMIT_MAX: '1000',
    });
    await app.register(cookiePlugin);
    registerAdminAuthRoutes(app, prisma as unknown as PrismaClient, config);
    registerAdminAccountRoutes(app, prisma as unknown as PrismaClient, config);
    await app.ready();
    /** 使用真实登录创建会话，并取回后续请求需要的 Cookie。 */
    async function login(username: string, password: string): Promise<string> {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        headers: { origin: ORIGIN, 'x-admin-request': '1' },
        payload: { username, password },
      });
      expect(response.statusCode, response.body).toBe(200);
      return `__Secure-sesame_admin_session=${response.cookies[0]!.value}`;
    }
    return { app, root, accounts, prisma, login, sessions };
  } catch (cause) {
    await app.close();
    throw new Error('后台密码路由测试初始化失败', { cause });
  }
}

describe('后台登录标识规范化', () => {
  it.each([null, '   '])('可选联系方式空值归一为 null：%j', (input) => {
    expect(normalizeAdminEmail(input)).toBeNull();
    expect(normalizeAdminPhone(input)).toBeNull();
  });

  it('邮箱大小写统一但保留点和加号标签，三种手机号写法映射同一值', () => {
    expect(normalizeAdminEmail(' First.Last+Ops@Example.COM ')).toBe('first.last+ops@example.com');
    for (const input of ['138 0013 8000', '+86 (138) 0013-8000', '0086 13800138000', '-13800138000', ')13800138000']) {
      expect(normalizeAdminPhone(input)).toBe('+8613800138000');
      expect(normalizeAdminLoginIdentifier(input)).toEqual({ phone: '+8613800138000' });
    }
    expect(normalizeAdminLoginIdentifier(' ROOT_ADMIN ')).toEqual({ username: 'root_admin' });
    expect(normalizeAdminLoginIdentifier('OPS@EXAMPLE.COM')).toEqual({ email: 'ops@example.com' });
    expect(normalizeAdminPhone('+1 (202) 555-0100')).toBe('+12025550100');
  });

  it.each(['.a@example.com', 'a@例子.com', `${'a'.repeat(65)}@example.com`])('拒绝含混或无效邮箱：%j', (input) => {
    expect(() => normalizeAdminEmail(input)).toThrow();
    expect(normalizeAdminLoginIdentifier(input)).toBeNull();
  });

  it.each(['2025550100', '+01234567', '+1234567890123456'])('拒绝含混或无效手机号：%j', (input) => {
    expect(() => normalizeAdminPhone(input)).toThrow();
    expect(normalizeAdminLoginIdentifier(input)).toBeNull();
  });
});

describe('后台邮箱和手机号登录', () => {
  it('三种标识均登录同一后台账号，空联系方式可省略并且不查询产品用户', async () => {
    const { app, root, accounts, prisma, login } = await setupRoutes();
    try {
      const cookie = await login(root.username, INITIAL_PASSWORD);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/accounts',
        headers: { origin: ORIGIN, 'x-admin-request': '1', cookie },
        payload: {
          username: 'alias_user',
          password: 'a',
          display_name: '同名用户',
          email: ' Ops+Admin@Example.COM ',
          phone: '138 0013 8000',
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      const accountId = response.json<{ id: string }>().id;
      expect(response.json()).toMatchObject({ email: 'ops+admin@example.com', phone: '+8613800138000' });
      for (const identifier of ['ALIAS_USER', 'OPS+ADMIN@EXAMPLE.COM', '13800138000', '0086 (138) 0013-8000']) {
        const currentCookie = await login(identifier, 'a');
        const me = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/auth/me',
          headers: { cookie: currentCookie },
        });
        expect(me.statusCode, me.body).toBe(200);
        expect(me.json().admin).toMatchObject({
          id: accountId,
          username: 'alias_user',
          email: 'ops+admin@example.com',
          phone: '+8613800138000',
        });
      }
      expect(accounts.get(root.id)).toMatchObject({ email: null, phone: null });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }, 30_000);

  it('已删除账号仍占用邮箱手机号，并将数据库唯一冲突转换为友好错误', async () => {
    const { app, root, accounts, prisma, login } = await setupRoutes();
    try {
      const retired = {
        ...accountFixture('retired_user'),
        email: 'used@example.com',
        phone: '+8613800138000',
        deletedAt: new Date(),
      };
      accounts.set(retired.id, retired);
      const cookie = await login(root.username, INITIAL_PASSWORD);
      const headers = { origin: ORIGIN, 'x-admin-request': '1', cookie };
      for (const [contact, code] of [
        [{ email: 'USED@EXAMPLE.COM' }, 'ADMIN_EMAIL_EXISTS'],
        [{ phone: '13800138000' }, 'ADMIN_PHONE_EXISTS'],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/accounts',
          headers,
          payload: { username: 'another_user', password: 'x', display_name: '新用户', ...contact },
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().code).toBe(code);
      }
      for (const field of ['email', 'phone'] as const) {
        prisma.adminAccount.create.mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('unique conflict', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: [field] },
          }),
        );
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/accounts',
          headers,
          payload: { username: 'another_user', password: 'x', display_name: '新用户' },
        });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().code).toBe(field === 'email' ? 'ADMIN_EMAIL_EXISTS' : 'ADMIN_PHONE_EXISTS');
      }
    } finally {
      await app.close();
    }
  }, 30_000);

  it('省略或规范化后相同的联系方式不撤会话，变更必须原因，清空撤会话且旧标识不能登录', async () => {
    const { app, root, accounts, prisma, login } = await setupRoutes();
    try {
      const member = { ...accountFixture('member_user'), email: 'member@example.com', phone: '+8613800138000' };
      accounts.set(member.id, member);
      const adminCookie = await login(root.username, INITIAL_PASSWORD);
      const memberCookie = await login(member.email, INITIAL_PASSWORD);
      const headers = { origin: ORIGIN, 'x-admin-request': '1', cookie: adminCookie };
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/accounts/${member.id}`,
        headers,
        payload: { version: 1, display_name: '新名称' },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json()).toMatchObject({ email: member.email, phone: member.phone });
      const same = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/accounts/${member.id}`,
        headers,
        payload: { version: 2, email: 'MEMBER@EXAMPLE.COM', phone: '13800138000' },
      });
      expect(same.statusCode, same.body).toBe(200);
      expect(prisma.adminSession.updateMany).not.toHaveBeenCalled();
      const noReason = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/accounts/${member.id}`,
        headers,
        payload: { version: 3, email: null },
      });
      expect(noReason.statusCode).toBe(400);
      expect(noReason.json().code).toBe('ADMIN_REASON_REQUIRED');
      const cleared = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/accounts/${member.id}`,
        headers,
        payload: { version: 3, email: '   ', phone: null, reason: '清除登录联系方式' },
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json()).toMatchObject({ email: null, phone: null });
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/admin/auth/me', headers: { cookie: memberCookie } }))
          .statusCode,
      ).toBe(401);
      for (const username of [member.email, member.phone]) {
        const removed = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          headers: { origin: ORIGIN, 'x-admin-request': '1' },
          payload: { username, password: INITIAL_PASSWORD },
        });
        expect(removed.statusCode).toBe(401);
      }
      await login(member.username, INITIAL_PASSWORD);
      const rebound = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/accounts',
        headers,
        payload: {
          username: 'contact_receiver',
          display_name: '接收联系方式',
          password: 'x',
          email: member.email,
          phone: member.phone,
        },
      });
      expect(rebound.statusCode, rebound.body).toBe(201);
      const receiverId = rebound.json<{ id: string }>().id;
      for (const identifier of [member.email, member.phone]) {
        const receiverCookie = await login(identifier, 'x');
        const me = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/auth/me',
          headers: { cookie: receiverCookie },
        });
        expect(me.json().admin.id).toBe(receiverId);
      }
      const auditRecords = prisma.auditLog.create.mock.calls as unknown as Array<
        [{ data: { action: string; metadata: Record<string, unknown> } }]
      >;
      const update = auditRecords.filter(([input]) => input.data.action === 'admin.account.update').at(-1)![0].data
        .metadata;
      expect(update.changed_fields).toEqual(['email', 'phone']);
      expect(adminAuditSummary('admin.account.update', update as Record<string, Prisma.JsonValue>)).toContain(
        '邮箱已修改',
      );
      expect(adminAuditSummary('admin.account.update', update as Record<string, Prisma.JsonValue>)).toContain(
        '手机号已修改',
      );
      expect(JSON.stringify(update)).not.toContain(member.email);
      expect(JSON.stringify(update)).not.toContain(member.phone);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('不同登录标识共享同一账号的失败次数和锁定', async () => {
    const { app, accounts, login } = await setupRoutes();
    try {
      const member = { ...accountFixture('locked_user'), email: 'locked@example.com', phone: '+8613800138000' };
      accounts.set(member.id, member);
      const identifiers = [member.username, member.email, '13800138000', member.email, member.username];
      for (const username of identifiers) {
        const failed = await app.inject({
          method: 'POST',
          url: '/api/v1/admin/auth/login',
          headers: { 'x-admin-request': '1' },
          payload: { username, password: 'incorrect' },
        });
        expect(failed.statusCode).toBe(401);
      }
      expect(accounts.get(member.id)?.failedLoginAttempts).toBe(5);
      expect(accounts.get(member.id)?.lockedUntil).toBeInstanceOf(Date);
      const locked = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        headers: { 'x-admin-request': '1' },
        payload: { username: member.phone, password: INITIAL_PASSWORD },
      });
      expect(locked.statusCode).toBe(401);
      accounts.get(member.id)!.lockedUntil = new Date(Date.now() - 1);
      await login(member.email, INITIAL_PASSWORD);
      expect(accounts.get(member.id)?.failedLoginAttempts).toBe(0);
    } finally {
      await app.close();
    }
  }, 30_000);

  it('邮箱在锁外验密后转移到另一账号时拒绝创建会话', async () => {
    const { app, accounts, prisma, sessions } = await setupRoutes();
    try {
      const member: AdminAccountWithGroup = { ...accountFixture('original_user'), email: 'transfer@example.com' };
      const receiver = accountFixture('receiver_user');
      accounts.set(member.id, member);
      accounts.set(receiver.id, receiver);
      prisma.$queryRaw.mockImplementationOnce(async () => {
        member.email = null;
        receiver.email = 'transfer@example.com';
        return [];
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/auth/login',
        headers: { 'x-admin-request': '1' },
        payload: { username: 'transfer@example.com', password: INITIAL_PASSWORD },
      });
      expect(response.statusCode).toBe(401);
      expect(sessions.size).toBe(0);
    } finally {
      await app.close();
    }
  });
});
