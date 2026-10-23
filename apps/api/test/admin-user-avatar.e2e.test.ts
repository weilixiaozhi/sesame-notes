import { randomInt, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { hashAdminPassword } from '../src/modules/admin/index.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { createOwnedFixture, removeOwnedFixture } from './owned-fixture-directory.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const RUN = randomUUID().replaceAll('-', '').slice(0, 18);
const ORIGIN = 'https://admin.example.test';
const PASSWORD = 'avatar-admin-password-42';
const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
const adminIds: string[] = [];
const groupIds: string[] = [];
const userIds: string[] = [];
let storage = '';
let app: ReturnType<typeof buildApp>;
let writerCookie = '';
let readerCookie = '';
let source = '';
let failAudit = false;
let revokeWriterAfterAuthentication = false;

/** 所有后台写请求附带同源 Cookie 和自定义头，验证真实权限链路。 */
function headers(cookie = writerCookie) {
  return { cookie, origin: ORIGIN, 'x-admin-request': '1' };
}

/** 用独立账号登录后台，读写差异由真实用户组权限决定。 */
async function loginAdmin(kind: 'writer' | 'reader', passwordHash: string): Promise<string> {
  try {
    const group = await prisma.adminGroup.create({
      data: {
        name: `头像管理-${kind}-${RUN}`,
        permissions: kind === 'writer' ? ['users:read', 'users:write'] : ['users:read'],
        pageIds: ['users'],
      },
    });
    groupIds.push(group.id);
    const admin = await prisma.adminAccount.create({
      data: {
        username: `avatar_${kind}_${RUN}`,
        displayName: '头像验收管理员',
        passwordHash,
        identityType: 'standard_user',
        groupId: group.id,
      },
    });
    adminIds.push(admin.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      headers: { origin: ORIGIN, 'x-admin-request': '1' },
      payload: { username: admin.username, password: PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    const cookies = response.headers['set-cookie'];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies]).find((value) =>
      value?.startsWith('__Secure-sesame_admin_session='),
    );
    expect(cookie).toBeDefined();
    return cookie!.split(';')[0]!;
  } catch (cause) {
    throw new Error('头像验收后台账号准备失败', { cause });
  }
}

/** 创建可实际访问本人头像的应用用户，每个用例使用独立账号隔离版本。 */
async function createUser() {
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        country_code: '+86',
        phone: `138${randomInt(100_000_000).toString().padStart(8, '0')}`,
        password: PASSWORD,
        device: { installation_id: randomUUID(), name: '头像验收', platform: 'test' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const session = response.json<{ access_token: string; user: { user_id: string } }>();
    userIds.push(session.user.user_id);
    return { id: session.user.user_id, token: session.access_token };
  } catch (cause) {
    throw new Error('头像验收应用用户准备失败', { cause });
  }
}

/** 提交真实图片；版本号由界面当前资料快照提供。 */
async function upload(userId: string, version = 0, cookie = writerCookie, data = source) {
  try {
    return await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${userId}/avatar`,
      headers: headers(cookie),
      payload: { content_type: 'image/png', data_base64: data, avatar_version: version, reason: '用户申请设置头像' },
    });
  } catch (cause) {
    throw new Error('头像上传请求执行失败', { cause });
  }
}

/** 只读取本用例目录，缺少目录代表尚未写入任何文件。 */
async function avatarFiles() {
  try {
    return (await readdir(resolve(storage, 'avatars'))).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

beforeAll(async () => {
  try {
    storage = await createOwnedFixture('admin-avatar');
    const config: ApiConfig = {
      databaseUrl: DATABASE_URL,
      jwtSecret: 'avatar-test-secret-that-is-at-least-32-bytes-long',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      storagePath: storage,
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
    // 扩展只对本次应用注入审计故障，仍用真实数据库事务验证回滚和文件补偿。
    const injected = prisma.$extends({
      query: {
        adminSession: {
          /** 在入口认证完成时模拟另一个管理操作收回写权限，验证提交前会重验。 */
          async update({ args, query }) {
            const result = await query(args);
            if (revokeWriterAfterAuthentication) {
              revokeWriterAfterAuthentication = false;
              await prisma.adminGroup.update({
                where: { id: groupIds[0]! },
                data: { permissions: ['users:read'] },
              });
            }
            return result;
          },
        },
        auditLog: {
          /** 在真实事务中拒绝审计写入，头像资料必须随之回滚。 */
          async create({ args, query }) {
            if (failAudit && args.data.action.startsWith('user.avatar.')) throw new Error('模拟头像审计写入失败');
            return query(args);
          },
        },
      },
    });
    app = buildApp({ logger: false, config, prisma: injected as unknown as PrismaClient });
    await app.ready();
    source = (
      await sharp({ create: { width: 8, height: 6, channels: 4, background: '#55aa88' } })
        .png()
        .toBuffer()
    ).toString('base64');
    const passwordHash = await hashAdminPassword(PASSWORD);
    writerCookie = await loginAdmin('writer', passwordHash);
    readerCookie = await loginAdmin('reader', passwordHash);
  } catch (cause) {
    throw new Error('后台头像集成验收初始化失败', { cause });
  }
}, 30_000);

afterAll(async () => {
  try {
    failAudit = false;
    await app?.close();
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (adminIds.length) await prisma.adminAccount.deleteMany({ where: { id: { in: adminIds } } });
    if (groupIds.length) await prisma.adminGroup.deleteMany({ where: { id: { in: groupIds } } });
  } catch (cause) {
    throw new Error('后台头像验收夹具清理失败', { cause });
  } finally {
    await prisma.$disconnect();
    if (storage) await removeOwnedFixture(storage);
  }
});

describe('后台应用用户头像设置', () => {
  it('设置后后台与本人都可读取真实图片，删除会清理文件并留下版本审计', async () => {
    const user = await createUser();
    const created = await upload(user.id);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toEqual({ avatar_url: `/api/v1/admin/users/${user.id}/avatar?v=1`, avatar_version: 1 });
    const profile = await prisma.userProfile.findUniqueOrThrow({ where: { userId: user.id } });
    for (const request of [
      { url: created.json().avatar_url, headers: headers() },
      { url: `/api/v1/profile/avatar/${user.id}?v=1`, headers: { authorization: `Bearer ${user.token}` } },
    ]) {
      const image = await app.inject({ method: 'GET', ...request });
      expect(image.statusCode, image.body).toBe(200);
      const metadata = await sharp(image.rawPayload).metadata();
      expect(metadata).toMatchObject({ format: 'png', width: 8, height: 6 });
      expect(metadata.exif).toBeUndefined();
    }
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${user.id}/avatar`,
      headers: headers(),
      payload: { avatar_version: 1, reason: '用户申请删除头像' },
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await avatarFiles()).not.toContain(profile.avatarFileId);
    expect(await prisma.userProfile.findUnique({ where: { userId: user.id } })).toMatchObject({
      avatarFileId: null,
      avatarVersion: 2,
    });
    const image = await app.inject({ method: 'GET', url: `/api/v1/admin/users/${user.id}/avatar`, headers: headers() });
    expect(image.statusCode).toBe(404);
    const audit = await prisma.auditLog.findMany({
      where: { target: { path: ['id'], equals: user.id }, action: { startsWith: 'user.avatar.' } },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((entry) => entry.action)).toEqual(['user.avatar.update', 'user.avatar.delete']);
    expect(audit[1]!.metadata).toMatchObject({ previous_avatar_version: 1, avatar_version: 2 });
    expect(JSON.stringify(audit.map((entry) => entry.metadata))).not.toContain(source);
    expect(JSON.stringify(audit.map((entry) => entry.metadata))).not.toContain(profile.avatarFileId);
  });

  it('只读管理员不能上传或删除，普通用户凭据也不能调用后台写接口', async () => {
    const user = await createUser();
    const before = await avatarFiles();
    expect((await upload(user.id, 0, readerCookie)).statusCode).toBe(403);
    const deletion = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/users/${user.id}/avatar`,
      headers: headers(readerCookie),
      payload: { avatar_version: 0, reason: '越权删除测试' },
    });
    expect(deletion.statusCode).toBe(403);
    const bearerOnly = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${user.id}/avatar`,
      headers: { origin: ORIGIN, 'x-admin-request': '1', authorization: `Bearer ${user.token}` },
      payload: { content_type: 'image/png', data_base64: source, avatar_version: 0, reason: '身份隔离测试' },
    });
    expect(bearerOnly.statusCode).toBe(401);
    expect(await avatarFiles()).toEqual(before);
  });

  it('本人上传契约保持兼容，后台旧版本不会覆盖本人刚更新的头像', async () => {
    const user = await createUser();
    const own = await app.inject({
      method: 'PUT',
      url: '/api/v1/profile/avatar',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { content_type: 'image/png', data_base64: source },
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toEqual({ avatar_url: `/api/v1/profile/avatar/${user.id}?v=1`, avatar_version: 1 });
    const before = await avatarFiles();
    const conflict = await upload(user.id);
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json().code).toBe('AVATAR_VERSION_CONFLICT');
    expect(await avatarFiles()).toEqual(before);
    const ownDelete = await app.inject({
      method: 'DELETE',
      url: '/api/v1/profile/avatar',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(ownDelete.statusCode, ownDelete.body).toBe(204);
  });

  it('入口认证后被收回写权限时不修改头像，并补偿预写入的文件', async () => {
    const user = await createUser();
    const before = await avatarFiles();
    revokeWriterAfterAuthentication = true;
    try {
      const denied = await upload(user.id);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json().code).toBe('ADMIN_PERMISSION_DENIED');
      expect(await avatarFiles()).toEqual(before);
      expect(await prisma.userProfile.findUnique({ where: { userId: user.id } })).toMatchObject({
        avatarFileId: null,
        avatarVersion: 0,
      });
      expect(await prisma.auditLog.count({ where: { target: { path: ['id'], equals: user.id } } })).toBe(0);
    } finally {
      revokeWriterAfterAuthentication = false;
      await prisma.adminGroup.update({
        where: { id: groupIds[0]! },
        data: { permissions: ['users:read', 'users:write'] },
      });
    }
  });

  it('并发使用同一版本时仅一笔提交，失败请求不会留下文件或审计', async () => {
    const user = await createUser();
    const before = await avatarFiles();
    const responses = await Promise.all([upload(user.id), upload(user.id)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const current = await prisma.userProfile.findUniqueOrThrow({ where: { userId: user.id } });
    expect(current.avatarVersion).toBe(1);
    expect(await avatarFiles()).toEqual([...before, current.avatarFileId!].sort());
    expect(await prisma.auditLog.count({ where: { target: { path: ['id'], equals: user.id } } })).toBe(1);
  });

  it('头像审计失败时回滚资料并补偿新图，删除失败时保留旧图', async () => {
    const user = await createUser();
    expect((await upload(user.id)).statusCode).toBe(200);
    const before = await avatarFiles();
    const previous = await prisma.userProfile.findUniqueOrThrow({ where: { userId: user.id } });
    failAudit = true;
    try {
      const replacement = await upload(user.id, 1);
      expect(replacement.statusCode, replacement.body).toBe(500);
      const deletion = await app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/users/${user.id}/avatar`,
        headers: headers(),
        payload: { avatar_version: 1, reason: '验证删除事务回滚' },
      });
      expect(deletion.statusCode, deletion.body).toBe(500);
    } finally {
      failAudit = false;
    }
    expect(await avatarFiles()).toEqual(before);
    expect(await prisma.userProfile.findUnique({ where: { userId: user.id } })).toMatchObject({
      avatarFileId: previous.avatarFileId,
      avatarVersion: previous.avatarVersion,
    });
    expect(await prisma.auditLog.count({ where: { target: { path: ['id'], equals: user.id } } })).toBe(1);
  });

  it('失效用户和伪装图片被拒绝，写入前后的失败都不留下图片文件', async () => {
    const user = await createUser();
    const before = await avatarFiles();
    const invalid = await upload(user.id, 0, writerCookie, Buffer.from('not-an-image').toString('base64'));
    expect(invalid.statusCode, invalid.body).toBe(422);
    const missing = await upload(randomUUID());
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json().code).toBe('USER_NOT_FOUND');
    expect(await avatarFiles()).toEqual(before);
  });
});
