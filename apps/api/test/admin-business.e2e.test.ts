import { testFixtureDatabaseUrl } from './existing-test-database.js';

import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { hashAdminPassword } from '../src/modules/admin/index.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const RUN = randomUUID();
const PASSWORD = 'admin-native-test-passphrase-42';
const ORIGIN = 'https://admin.example.test';
const STORAGE = resolve('../../Temp', `admin-business-native-${RUN}`);
const AVATAR = `${randomUUID()}.png`;
const AVATAR_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=',
  'base64',
);
const MARKER = randomInt(1_000_000, 9_999_999).toString();
const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'business-native-test-at-least-32-byte-secret',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: STORAGE,
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  adminOrigins: [ORIGIN],
  rateLimitMax: 1000,
  authRateLimitMax: 1000,
  syncRetentionMinCursor: 0,
  trustProxyCidrs: [],
};
const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
const app = buildApp({ logger: false, config, prisma });
const adminId = randomUUID();
const userIds = Array.from({ length: 13 }, () => randomUUID());
const deviceId = randomUUID();
const otherDeviceId = randomUUID();
const adminUsername = `native_${RUN.replaceAll('-', '').slice(0, 18)}`;
let adminCookie = '';
let readerCookie = '';
let readerId: string | undefined;
let groupId: string | undefined;

/** 登录调用真实认证入口，测试不直接伪造后台会话。 */
async function login(username: string): Promise<string> {
  const result = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    headers: { origin: ORIGIN, 'x-admin-request': '1' },
    payload: { username, password: PASSWORD },
  });
  expect(result.statusCode, result.body).toBe(200);
  const values = result.headers['set-cookie'];
  const cookie = (Array.isArray(values) ? values : [values]).find((value) =>
    value?.startsWith('__Secure-sesame_admin_session='),
  );
  expect(cookie).toBeDefined();
  return cookie!.split(';')[0]!;
}

/** 后台请求始终携带同源标识，普通身份测试只替换真实登录所得 Cookie。 */
function headers(cookie = adminCookie) {
  return { cookie, origin: ORIGIN, 'x-admin-request': '1' };
}

beforeAll(async () => {
  try {
    const passwordHash = await hashAdminPassword(PASSWORD);
    const group = await prisma.adminGroup.create({
      data: { name: `业务验收-${RUN}`, permissions: ['users:read'], pageIds: ['users'] },
    });
    groupId = group.id;
    await prisma.adminAccount.create({
      data: {
        id: adminId,
        username: adminUsername,
        displayName: '原生验收超管',
        passwordHash,
        identityType: 'super_admin',
        groupId: group.id,
      },
    });
    const reader = await prisma.adminAccount.create({
      data: {
        username: `reader_${RUN.replaceAll('-', '').slice(0, 18)}`,
        displayName: '仅用户读取',
        passwordHash,
        identityType: 'standard_user',
        groupId: group.id,
      },
    });
    readerId = reader.id;
    const sesameStart = randomInt(100_000_000, 899_999_000);
    for (const [index, id] of userIds.entries()) {
      await prisma.user.create({
        data: {
          id,
          phoneE164: `+991${MARKER}${index.toString().padStart(2, '0')}`,
          sesameNumber: String(sesameStart + index),
          passwordHash: 'native-user-password-must-not-leak',
          isEnabled: index < 11,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)),
          profile: {
            create: {
              displayName: index === 0 ? '原生用户资料' : `验收用户${index}`,
              gender: index === 0 ? 'FEMALE' : 'UNSPECIFIED',
              primaryCurrency: 'CNY',
              themePrimaryColor: '#3F72AF',
              aiConfig: { apiKey: 'native-ai-key-must-not-leak' },
              ...(index === 0 ? { avatarFileId: AVATAR, avatarVersion: 2 } : {}),
            },
          },
        },
      });
    }
    await prisma.device.createMany({
      data: [
        {
          id: deviceId,
          userId: userIds[0]!,
          installationId: randomUUID(),
          name: '主力手机',
          platform: 'android',
          appVersion: '2.0',
          osVersion: '15',
          deviceModel: 'Pixel',
          lastIp: '192.0.2.10',
        },
        {
          id: otherDeviceId,
          userId: userIds[0]!,
          installationId: randomUUID(),
          name: '另一台电脑',
          platform: 'windows',
          lastIp: '192.0.2.11',
        },
      ],
    });
    await prisma.refreshToken.createMany({
      data: [deviceId, otherDeviceId].map((id) => ({
        userId: userIds[0]!,
        deviceId: id,
        tokenHash: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    });
    await mkdir(resolve(STORAGE, 'avatars'), { recursive: true });
    await writeFile(resolve(STORAGE, 'avatars', AVATAR), AVATAR_BYTES, { flag: 'wx' });
    await app.ready();
    adminCookie = await login(adminUsername);
    readerCookie = await login(reader.username);
  } catch (error) {
    throw new Error('原生后台业务验收准备失败', { cause: error });
  }
}, 30_000);

afterAll(async () => {
  try {
    await app.close();
    // 仅清理本用例创建的明确 ID，避免影响同一隔离库中的其他测试账号。
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.adminAccount.deleteMany({ where: { id: { in: [adminId, ...(readerId ? [readerId] : [])] } } });
    if (groupId) await prisma.adminGroup.delete({ where: { id: groupId } });
    await prisma.$disconnect();
    // 文件路径由本测试生成且位于仓库 Temp；仅删除精确文件和已空目录。
    await unlink(resolve(STORAGE, 'avatars', AVATAR));
    await rmdir(resolve(STORAGE, 'avatars'));
    await rmdir(STORAGE);
  } catch (error) {
    throw new Error('原生后台业务验收资源释放失败', { cause: error });
  }
});

describe('原生 PostgreSQL 后台用户资料、设备和操作日志', () => {
  it('启停接口文档要求原因，实际处理拒绝缺少正文的写入', async () => {
    try {
      const document = app.swagger() as {
        paths: Record<string, { patch: { requestBody: { required?: boolean }; 'x-optional-request-body'?: boolean } }>;
      };
      for (const action of ['disable', 'enable']) {
        const schema = document.paths[`/api/v1/admin/users/{user_id}/${action}`]!.patch;
        expect(schema.requestBody.required).toBe(true);
        expect(schema['x-optional-request-body']).toBeUndefined();
        const response = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/users/${userIds[2]}/${action}`,
          headers: headers(),
        });
        expect(response.statusCode, response.body).toBe(400);
        const changed = await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/users/${userIds[2]}/${action}`,
          headers: headers(),
          payload: { reason: '用户确认操作' },
        });
        expect(changed.statusCode, changed.body).toBe(200);
      }
    } catch (error) {
      throw new Error('启停接口操作原因契约验收失败', { cause: error });
    }
  });

  it('数字分页总数遵循完整搜索与状态条件，游标请求明确拒绝', async () => {
    try {
      const result = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?page=99&page_size=10&is_enabled=true&search=${MARKER}`,
        headers: headers(),
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({ page: 2, page_size: 10, total: 11 });
      expect(result.json().items).toHaveLength(1);
      expect(result.json().items[0]).toMatchObject({
        id: userIds[0],
        phone: `+991${MARKER}00`,
        display_name: '原生用户资料',
        gender: 'FEMALE',
        avatar_url: `/api/v1/admin/users/${userIds[0]}/avatar?v=2`,
        avatar_version: 2,
      });
      expect(result.body).not.toContain('must-not-leak');
      expect(result.json()).not.toHaveProperty('next_cursor');
      expect(result.json().items[0]).not.toHaveProperty('is_admin');
      expect(result.json().items[0]).not.toHaveProperty('device_count');
      const legacy = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?limit=2&search=${MARKER}`,
        headers: headers(),
      });
      expect(legacy.statusCode).toBe(400);
      expect(legacy.json().code).toBe('ADMIN_PAGINATION_INVALID');
    } catch (error) {
      throw new Error('用户分页与资料白名单验收失败', { cause: error });
    }
  });

  it('独立详情和Admin头像读取实际资料，普通Bearer被拒绝', async () => {
    try {
      const result = await app.inject({ method: 'GET', url: `/api/v1/admin/users/${userIds[0]}`, headers: headers() });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        primary_currency: 'CNY',
        avatar_version: 2,
        theme_primary_color: '#3F72AF',
      });
      expect(result.body).not.toContain('ai_config');
      const avatar = await app.inject({ method: 'GET', url: result.json().avatar_url, headers: headers() });
      expect(avatar.statusCode, avatar.body).toBe(200);
      expect(avatar.headers['content-type']).toBe('image/png');
      expect(avatar.headers['cache-control']).toBe('no-store');
      expect(avatar.rawPayload.equals(AVATAR_BYTES)).toBe(true);
      const forbidden = await app.inject({
        method: 'GET',
        url: result.json().avatar_url,
        headers: { authorization: 'Bearer ordinary-user-token' },
      });
      expect(forbidden.statusCode).toBe(401);
    } catch (error) {
      throw new Error('独立用户详情与头像验收失败', { cause: error });
    }
  });

  it('设备读取按权限和所属用户过滤，并且不返回安装标识', async () => {
    try {
      const url = `/api/v1/admin/users/${userIds[0]}/devices?page=1&page_size=10`;
      expect((await app.inject({ method: 'GET', url, headers: headers(readerCookie) })).statusCode).toBe(403);
      const result = await app.inject({ method: 'GET', url, headers: headers() });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ total: 2, page: 1 });
      expect(result.json().items.find((item: { id: string }) => item.id === deviceId)).toMatchObject({
        name: '主力手机',
        last_ip: '192.0.2.10',
        app_version: '2.0',
        os_version: '15',
      });
      expect(result.body).not.toContain('installation');
      expect(result.body).not.toContain('token');
    } catch (error) {
      throw new Error('设备授权与字段验收失败', { cause: error });
    }
  });

  it('撤销单设备不影响其他设备，中文日志可按业务名和时间定位', async () => {
    try {
      const url = `/api/v1/admin/users/${userIds[0]}/devices/${deviceId}/revoke`;
      const result = await app.inject({
        method: 'POST',
        url,
        headers: headers(),
        payload: { reason: '设备遗失，用户已确认' },
      });
      expect(result.statusCode, result.body).toBe(204);
      expect((await prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).revokedAt).not.toBeNull();
      expect((await prisma.device.findUniqueOrThrow({ where: { id: otherDeviceId } })).revokedAt).toBeNull();
      expect(await prisma.refreshToken.count({ where: { deviceId, revokedAt: null } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { deviceId: otherDeviceId, revokedAt: null } })).toBe(1);
      const auditUrl = `/api/v1/admin/audit-logs?page=1&page_size=10&action=device.revoke&actor_search=${adminUsername}&target_search=${encodeURIComponent('主力手机')}&created_from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`;
      const audit = await app.inject({ method: 'GET', url: auditUrl, headers: headers() });
      expect(audit.statusCode, audit.body).toBe(200);
      expect(audit.json()).toMatchObject({
        total: 1,
        items: [
          {
            action_label: '撤销用户设备',
            actor_display: adminUsername,
            reason: '设备遗失，用户已确认',
            summary: '此设备的登录已撤销',
          },
        ],
      });
      expect(audit.json().items[0].target_display).toContain('原生用户资料');
      expect(audit.body).not.toContain(`+991${MARKER}00`);
    } catch (error) {
      throw new Error('原生设备撤销与操作日志验收失败', { cause: error });
    }
  });

  it('审计写入故障使同事务用户修改回滚，不能出现部分成功', async () => {
    const failedClient = prisma.$extends({
      query: {
        auditLog: {
          async create() {
            throw new Error('验收注入的审计不可用');
          },
        },
      },
    });
    const failedApp = buildApp({ logger: false, config, prisma: failedClient as unknown as PrismaClient });
    try {
      await failedApp.ready();
      const before = await prisma.user.findUniqueOrThrow({ where: { id: userIds[1]! } });
      const result = await failedApp.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${userIds[1]}/disable`,
        headers: headers(),
        payload: { reason: '验证事务回滚' },
      });
      expect(result.statusCode).toBe(500);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: userIds[1]! } });
      expect(after.isEnabled).toBe(before.isEnabled);
      expect(
        await prisma.auditLog.count({
          where: { action: 'user.disable', actor: `admin:${adminId}`, target: { path: ['id'], equals: userIds[1] } },
        }),
      ).toBe(0);
    } catch (error) {
      throw new Error('原生审计失败回滚验收失败', { cause: error });
    } finally {
      await failedApp.close();
    }
  });
});
