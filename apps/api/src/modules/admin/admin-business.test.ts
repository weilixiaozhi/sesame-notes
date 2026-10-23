import cookie from '@fastify/cookie';
import { Prisma, type PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../../shared/api-config.js';
import { ErrorSchema } from '../../shared/contracts/errors.js';
import { registerErrorHandler } from '../../shared/errors.js';
import { adminAuditConditions, adminAuditResponse } from './admin-audit.js';
import { adminOperationReason, adminPage } from './admin-pagination.js';
import { registerAdminAccountRoutes } from './admin-accounts.js';
import { registerAdminRoutes } from './admin-routes.js';
import { ADMIN_USER_SELECT, adminAvatarFile, adminUserWhere } from './admin-users.js';
import { writeAuditLog } from './audit-log.js';
import { enforceAdminRouteProtection } from './route-policy.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://admin.example.test';
const NOW = new Date('2026-10-09T01:00:00.000Z');
const headers = { cookie: `__Secure-sesame_admin_session=${'a'.repeat(64)}`, origin: ORIGIN, 'x-admin-request': '1' };
const apps: FastifyInstance[] = [];

/** 只构造安全边界所需的会话，真实守卫仍会读取账号与组并核对每个路由权限。 */
function session(
  permissions = ['users:read', 'users:write', 'devices:read', 'devices:revoke', 'audit:read', 'status:read'],
) {
  return {
    id: 'session',
    tokenHash: 'hash',
    revokedAt: null,
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    admin: {
      id: ADMIN_ID,
      username: 'ops_test',
      email: null,
      phone: null,
      displayName: '测试运营',
      identityType: 'standard_user',
      groupId: 'group',
      isEnabled: true,
      deletedAt: null,
      version: 1,
      group: { id: 'group', name: '运营组', version: 1, isEnabled: true, deletedAt: null, permissions, pageIds: [] },
    },
  };
}

/** 固定用户资料包含故意混入的秘密字段，验证显式投影与响应序列化不会泄漏它们。 */
function user() {
  return {
    id: USER_ID,
    phoneE164: '+8613800138000',
    sesameNumber: '123456789',
    isEnabled: true,
    createdAt: NOW,
    passwordHash: 'do-not-expose-password',
    profile: {
      displayName: '小芝麻',
      gender: 'FEMALE',
      avatarFileId: null,
      avatarVersion: 0,
      updatedAt: NOW,
      primaryCurrency: 'CNY',
      themePrimaryColor: '#3F72AF',
      aiConfig: { apiKey: 'do-not-expose-ai' },
    },
  };
}

/** 内存仓储只替代数据库 I/O；鉴权、Schema、路由和日志映射均使用生产代码。 */
function repository() {
  const db = {
    user: {
      findMany: vi.fn().mockResolvedValue([user()]),
      findUnique: vi.fn().mockResolvedValue(user()),
      count: vi.fn().mockResolvedValue(21),
      update: vi.fn().mockResolvedValue(user()),
    },
    device: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([
        {
          id: DEVICE_ID,
          name: '随身手机',
          platform: 'android',
          appVersion: '1.0',
          osVersion: '15',
          deviceModel: 'test',
          lastIp: '127.0.0.1',
          createdAt: NOW,
          lastSeenAt: NOW,
          revokedAt: null,
          installationId: 'private-installation',
        },
      ]),
      findFirst: vi.fn().mockResolvedValue({ id: DEVICE_ID, revokedAt: null }),
      findUnique: vi.fn().mockResolvedValue({ name: '随身手机', user: user() }),
      update: vi.fn().mockResolvedValue({}),
    },
    userProfile: { findUnique: vi.fn().mockResolvedValue({ avatarFileId: null }) },
    adminAccount: {
      findUnique: vi.fn().mockResolvedValue({ username: 'ops_test' }),
      findMany: vi
        .fn()
        .mockResolvedValue([
          { ...session().admin, createdAt: NOW, updatedAt: NOW, createdBy: null, updatedBy: null, lastLoginAt: null },
        ]),
      count: vi.fn().mockResolvedValue(3),
    },
    adminGroup: { findUnique: vi.fn().mockResolvedValue({ name: '运营组' }) },
    adminSession: { findUnique: vi.fn().mockResolvedValue(session()), update: vi.fn().mockResolvedValue({}) },
    refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}), count: vi.fn().mockResolvedValue(1) },
    ledger: { count: vi.fn().mockResolvedValue(1) },
    syncChange: { count: vi.fn().mockResolvedValue(1) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (operation: (tx: typeof db) => Promise<unknown>) => operation(db));
  return db;
}

/** 创建独立 Fastify 实例，绝不实例化 PrismaClient 或加载 test 数据库配置。 */
async function application(db = repository(), includeAccounts = false) {
  const app = Fastify({ logger: false });
  apps.push(app);
  enforceAdminRouteProtection(app);
  app.addSchema(ErrorSchema);
  registerErrorHandler(app);
  app.decorateRequest('realtimeRevalidationUserIds');
  app.addHook('onRequest', async (request) => {
    request.realtimeRevalidationUserIds = new Set<string>();
  });
  await app.register(cookie);
  registerAdminRoutes(
    app,
    db as unknown as PrismaClient,
    { adminOrigins: [ORIGIN], storagePath: 'Temp/admin-business-no-files' } as ApiConfig,
  );
  if (includeAccounts)
    registerAdminAccountRoutes(app, db as unknown as PrismaClient, { adminOrigins: [ORIGIN] } as ApiConfig);
  await app.ready();
  return { app, db };
}

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } catch (error) {
    throw new Error('后台业务测试资源释放失败', { cause: error });
  }
});

describe('后台业务资料与页码分页', () => {
  it('总数分页按同一筛选和快照返回资料，越界页码回到最后有效页', async () => {
    const { app, db } = await application();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users?page=9&page_size=10&search=138&is_enabled=false',
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      page: 3,
      page_size: 10,
      total: 21,
      items: [{ phone: '+8613800138000', sesame_number: '123456789', display_name: '小芝麻', gender: 'FEMALE' }],
    });
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 10,
        select: ADMIN_USER_SELECT,
        where: db.user.count.mock.calls[0]![0].where,
      }),
    );
    expect(db.$transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(response.body).not.toContain('do-not-expose');
    expect(response.json()).not.toHaveProperty('next_cursor');
    expect(response.json().items[0]).not.toHaveProperty('is_admin');
    expect(response.json().items[0]).not.toHaveProperty('device_count');
    expect(ADMIN_USER_SELECT).not.toHaveProperty('_count');
  });

  it.each(['users', 'accounts', 'audit-logs'])('%s 列表拒绝游标参数且不执行业务查询', async (path) => {
    try {
      const db = repository();
      const adminSession = session();
      adminSession.admin.identityType = 'super_admin';
      db.adminSession.findUnique.mockResolvedValue(adminSession);
      const { app } = await application(db, path === 'accounts');
      for (const query of ['limit=10', 'cursor=1', 'page=1&limit=10']) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/admin/${path}?${query}`, headers });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().code).toBe('ADMIN_PAGINATION_INVALID');
      }
      expect(db.user.findMany).not.toHaveBeenCalled();
      expect(db.adminAccount.findMany).not.toHaveBeenCalled();
      expect(db.$queryRaw).not.toHaveBeenCalled();
    } catch (error) {
      throw new Error('后台列表游标参数拒绝验证失败', { cause: error });
    }
  });

  it('后台账号页码分页返回真实总数与稳定排序', async () => {
    try {
      const db = repository();
      const adminSession = session();
      adminSession.admin.identityType = 'super_admin';
      db.adminSession.findUnique.mockResolvedValue(adminSession);
      db.adminAccount.count.mockResolvedValue(21);
      const { app } = await application(db, true);
      const response = await app.inject({ method: 'GET', url: '/api/v1/admin/accounts?page=9&page_size=10', headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ page: 3, page_size: 10, total: 21 });
      expect(response.json()).not.toHaveProperty('next_cursor');
      expect(db.adminAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      );
    } catch (error) {
      throw new Error('后台账号页码分页验证失败', { cause: error });
    }
  });

  it('用户列表分页返回当前头像与版本', async () => {
    try {
      const { app, db } = await application();
      const avatarUser = {
        ...user(),
        profile: { ...user().profile, avatarFileId: `${DEVICE_ID}.png`, avatarVersion: 2 },
      };
      // 默认头像也保留递增版本；缺少资料的用户使用空地址与初始版本。
      db.user.findMany.mockResolvedValue([
        avatarUser,
        { ...user(), id: ADMIN_ID, profile: { ...user().profile, avatarVersion: 3 } },
        { ...user(), id: DEVICE_ID, profile: null },
      ]);
      const result = await app.inject({ method: 'GET', url: '/api/v1/admin/users?page=1&page_size=10', headers });
      expect(result.statusCode, result.body).toBe(200);
      const avatar = { avatar_url: `/api/v1/admin/users/${USER_ID}/avatar?v=2`, avatar_version: 2 };
      expect(result.json().items).toMatchObject([
        { id: USER_ID, ...avatar },
        { id: ADMIN_ID, avatar_url: null, avatar_version: 3 },
        { id: DEVICE_ID, avatar_url: null, avatar_version: 0 },
      ]);
      expect(result.body).not.toContain(avatarUser.profile.avatarFileId);
      expect(result.body).not.toContain('do-not-expose');
      db.user.findUnique.mockResolvedValue(avatarUser);
      const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/users/${USER_ID}`, headers });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject(avatar);
    } catch (error) {
      throw new Error('后台用户列表头像与详情一致性验证失败', { cause: error });
    }
  });

  it('详情仅返回资料白名单，找不到账号返回明确404', async () => {
    const { app, db } = await application();
    const result = await app.inject({ method: 'GET', url: `/api/v1/admin/users/${USER_ID}`, headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      primary_currency: 'CNY',
      profile_updated_at: NOW.toISOString(),
      avatar_url: null,
      avatar_version: 0,
    });
    expect(result.body).not.toContain('aiConfig');
    expect(result.body).not.toContain('passwordHash');
    expect(result.json()).not.toHaveProperty('is_admin');
    expect(result.json()).not.toHaveProperty('device_count');
    db.user.findUnique.mockResolvedValue(null);
    expect((await app.inject({ method: 'GET', url: `/api/v1/admin/users/${USER_ID}`, headers })).statusCode).toBe(404);
  });

  it('缺少Admin会话时拒绝用户Bearer，设备读取需独立权限', async () => {
    const { app, db } = await application();
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: 'Bearer ordinary-user-token' },
    });
    expect(denied.statusCode).toBe(401);
    expect(db.user.findMany).not.toHaveBeenCalled();
    db.adminSession.findUnique.mockResolvedValue(session(['users:read']));
    const devices = await app.inject({ method: 'GET', url: `/api/v1/admin/users/${USER_ID}/devices`, headers });
    expect(devices.statusCode).toBe(403);
    expect(db.device.findMany).not.toHaveBeenCalled();
  });

  it('设备资料按目标用户分页并过滤安装标识与令牌', async () => {
    const { app, db } = await application();
    const result = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${USER_ID}/devices?page=1&page_size=10`,
      headers,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ total: 1, items: [{ name: '随身手机', last_ip: '127.0.0.1' }] });
    expect(db.device.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER_ID } }));
    expect(result.body).not.toContain('installation');
  });

  it('头像始终按目标用户当前关联查询，损坏文件名不读取磁盘', async () => {
    const { app, db } = await application();
    db.userProfile.findUnique.mockResolvedValue({ avatarFileId: '../../secret.png' });
    const result = await app.inject({ method: 'GET', url: `/api/v1/admin/users/${USER_ID}/avatar`, headers });
    expect(result.statusCode).toBe(404);
    expect(result.json().code).toBe('AVATAR_NOT_FOUND');
    expect(db.userProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      select: { avatarFileId: true },
    });
  });

  it('启停原因与实际修改同事务写日志，缺少原因时不执行写入', async () => {
    const { app, db } = await application();
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${USER_ID}/disable`,
      headers,
      payload: { reason: '经用户确认处理' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER_ID } }));
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'user.disable',
          metadata: expect.objectContaining({
            reason: '经用户确认处理',
            actor_username: 'ops_test',
            target_display: '小芝麻（芝麻号 123456789）',
          }),
        }),
      }),
    );
    db.user.update.mockClear();
    db.auditLog.create.mockClear();
    for (const payload of [undefined, {}, { reason: '   ' }]) {
      const rejected = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${USER_ID}/enable`,
        headers,
        payload,
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
    }
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('设备撤销仅接受带原因的 POST，成功写审计并撤销会话', async () => {
    try {
      const { app, db } = await application();
      const baseUrl = `/api/v1/admin/users/${USER_ID}/devices/${DEVICE_ID}`;
      const rejected = await app.inject({ method: 'DELETE', url: baseUrl, headers });
      expect(rejected.statusCode, rejected.body).toBe(404);
      expect(db.device.update).not.toHaveBeenCalled();
      const response = await app.inject({
        method: 'POST',
        url: `${baseUrl}/revoke`,
        headers,
        payload: { reason: '设备遗失' },
      });
      expect(response.statusCode, response.body).toBe(204);
      expect(db.refreshToken.updateMany).toHaveBeenCalled();
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'device.revoke',
            metadata: expect.objectContaining({ reason: '设备遗失' }),
          }),
        }),
      );
    } catch (error) {
      throw new Error('后台设备撤销入口验证失败', { cause: error });
    }
  });

  it('设备撤销校验归属、原因与重复状态，审计失败不得报告成功', async () => {
    const { app, db } = await application();
    const url = `/api/v1/admin/users/${USER_ID}/devices/${DEVICE_ID}/revoke`;
    const invalid = await app.inject({ method: 'POST', url, headers, payload: { reason: '   ' } });
    expect(invalid.statusCode).toBe(400);
    expect(db.device.update).not.toHaveBeenCalled();
    db.device.findFirst.mockResolvedValue(null);
    expect((await app.inject({ method: 'POST', url, headers, payload: { reason: '设备遗失' } })).statusCode).toBe(404);
    db.device.findFirst.mockResolvedValue({ id: DEVICE_ID, revokedAt: NOW });
    expect((await app.inject({ method: 'POST', url, headers, payload: { reason: '设备遗失' } })).statusCode).toBe(409);
    db.device.findFirst.mockResolvedValue({ id: DEVICE_ID, revokedAt: null });
    db.auditLog.create.mockRejectedValue(new Error('审计不可写'));
    expect((await app.inject({ method: 'POST', url, headers, payload: { reason: '设备遗失' } })).statusCode).toBe(500);
    expect(db.device.findFirst).toHaveBeenLastCalledWith({
      where: { id: DEVICE_ID, userId: USER_ID },
      select: { id: true, revokedAt: true },
    });
  });

  it('统计排除软删除后台账号，默认计数与启用计数共用删除条件', async () => {
    const { app, db } = await application();
    const result = await app.inject({ method: 'GET', url: '/api/v1/admin/status', headers });
    expect(result.statusCode).toBe(200);
    expect(result.json().users).not.toHaveProperty('admins');
    expect(result.json().admins).toMatchObject({ total: 3, enabled: 3 });
    expect(db.adminAccount.count.mock.calls).toEqual([
      [{ where: { deletedAt: null } }],
      [{ where: { deletedAt: null, isEnabled: true } }],
    ]);
  });

  it('日志数字分页在数据库过滤业务名称和时间，并返回中文快照字段', async () => {
    const { app, db } = await application();
    db.$queryRaw.mockImplementation(async (sql: Prisma.Sql | TemplateStringsArray) => {
      if (Array.isArray(sql)) return [];
      const text = (sql as Prisma.Sql).sql;
      if (text.includes('COUNT(*)')) return [{ total: 11n }];
      return [
        {
          id: 18n,
          action: 'user.disable',
          ip: '127.0.0.1',
          created_at: NOW,
          actor_display: 'ops_test',
          target_display: '小芝麻 · 芝麻号 123456789',
          metadata: { reason: '用户申请', is_enabled: false },
        },
      ];
    });
    const result = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?page=3&page_size=10&actor_search=ops&target_search=123&created_from=2026-10-08T00%3A00%3A00Z',
      headers,
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).not.toHaveProperty('next_cursor');
    expect(result.json()).toMatchObject({
      total: 11,
      page: 2,
      page_size: 10,
      items: [
        {
          action_label: '禁用应用用户',
          actor_display: 'ops_test',
          target_display: '小芝麻 · 芝麻号 123456789',
          reason: '用户申请',
          summary: '状态：停用',
        },
      ],
    });
    const queries = db.$queryRaw.mock.calls.map((call) => call[0]).filter((sql) => !Array.isArray(sql)) as Prisma.Sql[];
    expect(queries).toHaveLength(2);
    for (const sql of queries) {
      expect(sql.values).toContain('%ops%');
      expect(sql.values).toContain('%123%');
      expect(sql.values.some((value) => value instanceof Date)).toBe(true);
    }
    expect(queries[1]!.values.slice(-2)).toEqual([10, 10]);
  });

  it('日志读取保留联系方式变更和分类迁移摘要需要的安全字段', async () => {
    const { app, db } = await application();
    db.$queryRaw.mockImplementation(async (sql: Prisma.Sql | TemplateStringsArray) => {
      if (Array.isArray(sql)) return [];
      const text = (sql as Prisma.Sql).sql;
      if (text.includes('COUNT(*)')) return [{ total: 2n }];
      // 通过真实路由取得读取投影，只有被明确选取的安全元数据才能进入响应映射。
      const metadata: Record<string, Prisma.JsonValue> = {};
      for (const [key, value] of Object.entries({
        changed_fields: ['email', 'phone'],
        exercise_count: 2,
        template_count: 3,
      })) {
        if (text.includes(`l.metadata->'${key}'`)) metadata[key] = value;
      }
      return ['admin.account.update', 'fitness.taxonomy.delete'].map((action, index) => ({
        id: BigInt(index + 1),
        action,
        ip: null,
        created_at: NOW,
        actor_display: 'ops_test',
        target_display: '测试对象',
        metadata,
      }));
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs?page=1', headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items.map((entry: { summary: string }) => entry.summary)).toEqual([
      '邮箱已修改，旧会话已撤销；手机号已修改，旧会话已撤销',
      '分类已删除，动作和训练记录保留；已迁移 2 个动作；已调整 3 个训练模板',
    ]);
    expect(response.body).not.toContain('changed_fields');
    expect(response.body).not.toContain('exercise_count');
    expect(response.body).not.toContain('template_count');
  });

  it('操作类型目录与展示名称同源，未获审计权限不能读取', async () => {
    const { app, db } = await application();
    const result = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-actions', headers });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toContainEqual({ value: 'device.revoke', label: '撤销用户设备' });
    expect(result.json()).toContainEqual({ value: 'fitness.exercise.update', label: '修改动作' });
    expect(result.json().some((entry: { value: string }) => entry.value.endsWith('.publish'))).toBe(false);
    db.adminSession.findUnique.mockResolvedValue(session(['users:read']));
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/audit-actions', headers })).statusCode).toBe(403);
  });
});

describe('业务分页与安全展示边界', () => {
  it('空结果页码及筛选依据真实总数，不添加昵称搜索', () => {
    expect(adminPage({ page: 8 }, 0)).toMatchObject({ page: 1, page_size: 10, total: 0 });
    expect(adminUserWhere({ search: ' 123 ', is_enabled: true })).toEqual({
      isEnabled: true,
      OR: [{ phoneE164: { contains: '123', mode: 'insensitive' } }, { sesameNumber: { contains: '123' } }],
    });
    expect(() => adminOperationReason(undefined)).toThrow('操作原因');
    expect(() => adminAvatarFile('Temp', '..\\secret.png')).toThrow('头像不存在');
  });

  it('日志过滤参数绑定，通配符不扩大查询，倒置时间范围拒绝', () => {
    const condition = adminAuditConditions({
      actor_search: "x%' OR TRUE --",
      target_search: '用户_',
      action: 'user.disable',
    });
    expect(condition.sql).not.toContain('OR TRUE');
    expect(condition.values).toContain("%x\\%' OR TRUE --%");
    expect(condition.values).toContain('%用户\\_%');
    expect(() =>
      adminAuditConditions({ created_from: '2026-10-10T00:00:00Z', created_to: '2026-10-09T00:00:00Z' }),
    ).toThrow('有效的时间范围');
  });

  it('日志只展示服务端白名单摘要，未知事件不暴露原始元数据', () => {
    const row = {
      id: 9007199254740993n,
      action: 'admin.password.reset',
      ip: null,
      created_at: NOW,
      actor_display: 'ops_test',
      target_display: 'operator_a',
      metadata: { reason: '用户申请 +8613800138000', password: 'secret-password', token: 'secret-token' },
    };
    const value = adminAuditResponse(row);
    expect(value.id).toBe('9007199254740993');
    expect(value.action_label).toBe('重置后台用户密码');
    expect(value.summary).toBe('密码已更新，旧会话已撤销');
    for (const field of ['actor', 'action', 'target', 'request_id']) expect(value).not.toHaveProperty(field);
    expect(JSON.stringify(value)).not.toContain('secret-');
    expect(value.reason).not.toContain('+8613800138000');
    expect(
      adminAuditResponse({ ...row, action: 'fitness.exercise.publish', metadata: { enabled: true } }),
    ).toMatchObject({
      action_label: '发布动作',
      summary: '状态：启用',
    });
    expect(adminAuditResponse({ ...row, action: 'unknown', actor_display: null, target_display: null })).toMatchObject({
      action_label: '其他操作',
      actor_display: null,
      target_display: null,
      summary: null,
      reason: null,
    });
  });

  it('写入快照清理秘密键与完整手机号，保留业务名称而非用户UUID', async () => {
    const db = repository();
    await writeAuditLog(db as unknown as PrismaClient, {
      actor: `admin:${ADMIN_ID}`,
      action: 'user.disable',
      target: { type: 'user', id: USER_ID },
      requestId: 'request',
      metadata: {
        reason: '联系 +8613800138000',
        password: 'secret',
        token_hash: 'secret',
        nested: { cookie: 'secret' },
      },
    });
    const metadata = db.auditLog.create.mock.calls[0]![0].data.metadata;
    expect(metadata).toMatchObject({ actor_username: 'ops_test', target_display: '小芝麻（芝麻号 123456789）' });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(metadata)).not.toContain('+8613800138000');
  });
});
