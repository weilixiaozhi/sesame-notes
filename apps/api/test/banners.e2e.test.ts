import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashAdminPassword } from '../src/modules/admin/index.js';
import { bannerMediaFile } from '../src/modules/banners/index.js';
import { createOwnedFixture, removeOwnedFixture } from './owned-fixture-directory.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { loadTestApiConfig } from './test-api-config.js';

const ORIGIN = 'https://admin.example.test';
const PASSWORD = 'banner-integration-passphrase-2026';
const runId = randomUUID().replaceAll('-', '').slice(0, 18);
const writerName = `banner_${runId}`;
const readerName = `bread_${runId}`;
const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });
let app: ReturnType<typeof buildApp> | undefined;
let directory: string | undefined;
let groupId: string | undefined;
let writerCookie = '';
let readerCookie = '';
let uploadedId: string | undefined;

/** 经过正式登录入口取得独立管理会话，测试请求不伪造认证上下文。 */
async function login(username: string): Promise<string> {
  try {
    const response = await app!.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/login',
      headers: { origin: ORIGIN, 'x-admin-request': '1' },
      payload: { username, password: PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    const cookies = response.headers['set-cookie'];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies]).find((value) =>
      value?.startsWith('__Secure-sesame_admin_session='),
    );
    if (!cookie) throw new Error('后台登录未返回会话 Cookie');
    return cookie.split(';')[0]!;
  } catch (cause) {
    throw new Error('Banner 集成测试登录失败', { cause });
  }
}

/** 受保护写请求提供来源与自定义头，读取图片时单独验证只有 Cookie 也可预览。 */
function headers(cookie = writerCookie) {
  return { cookie, origin: ORIGIN, 'x-admin-request': '1' };
}

beforeAll(async () => {
  try {
    directory = await createOwnedFixture('api-fix-banner');
    const group = await prisma.adminGroup.create({
      data: { name: `Banner 只读-${runId}`, permissions: ['banners:read'], pageIds: ['banners'] },
    });
    groupId = group.id;
    const passwordHash = await hashAdminPassword(PASSWORD);
    await prisma.adminAccount.createMany({
      data: [
        { username: writerName, displayName: 'Banner 运营', passwordHash, identityType: 'super_admin', groupId },
        { username: readerName, displayName: 'Banner 只读', passwordHash, identityType: 'standard_user', groupId },
      ],
    });
    const config = loadTestApiConfig({
      ...process.env,
      JWT_SECRET: 'banner-test-secret-at-least-thirty-two-characters',
      STORAGE_PATH: directory,
      ADMIN_ORIGINS: ORIGIN,
    });
    app = buildApp({ logger: false, config, prisma });
    await app.ready();
    writerCookie = await login(writerName);
    readerCookie = await login(readerName);
  } catch (cause) {
    throw new Error('Banner 集成测试准备失败', { cause });
  }
}, 30_000);

afterAll(async () => {
  try {
    await app?.close();
    await prisma.appBanner.deleteMany({ where: { updatedBy: writerName } });
    if (uploadedId) await prisma.appBannerMedia.deleteMany({ where: { id: uploadedId, createdBy: writerName } });
    await prisma.adminAccount.deleteMany({ where: { username: { in: [writerName, readerName] } } });
    if (groupId) await prisma.adminGroup.delete({ where: { id: groupId } });
    await prisma.$disconnect();
    if (directory) await removeOwnedFixture(directory);
  } catch (cause) {
    throw new Error('Banner 集成测试资源清理失败', { cause });
  }
});

describe('Banner 公开展示与管理生命周期', () => {
  it('默认、上传预览、启用、修改跳转、版本冲突、权限和停用回退均遵循真实数据库契约', async () => {
    try {
      const initial = await app!.inject({ method: 'GET', url: '/api/v1/admin/banners', headers: headers() });
      expect(initial.statusCode, initial.body).toBe(200);
      expect(initial.json().items).toHaveLength(2);
      expect(initial.json().items.every((entry: { version: number }) => entry.version === 0)).toBe(true);
      const anonymous = await app!.inject({ method: 'GET', url: '/api/v1/banners' });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.json()).toEqual({ items: [] });
      expect((await app!.inject({ method: 'GET', url: '/api/v1/admin/banners' })).statusCode).toBe(401);

      const bytes = await sharp({ create: { width: 600, height: 200, channels: 3, background: '#263f59' } })
        .png()
        .toBuffer();
      const upload = await app!.inject({
        method: 'POST',
        url: '/api/v1/admin/banners/media',
        headers: headers(),
        payload: { filename: '训练入口.png', data_base64: bytes.toString('base64') },
      });
      expect(upload.statusCode, upload.body).toBe(201);
      uploadedId = upload.json().id;
      const publicPath = upload.json().image_path as string;
      expect((await app!.inject({ method: 'GET', url: publicPath })).statusCode).toBe(404);
      const preview = await app!.inject({
        method: 'GET',
        url: `/api/v1/admin/banners/media/${uploadedId}`,
        headers: { cookie: readerCookie },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.headers['content-type']).toBe('image/webp');
      expect(preview.headers['cache-control']).toBe('no-store');
      expect(preview.rawPayload).toEqual(await readFile(bannerMediaFile(directory!, uploadedId!)));

      const url = '/api/v1/admin/banners/fitness-plan-library';
      const payload = { version: 0, image_id: uploadedId, target: 'fitness-plan-library', is_enabled: true };
      expect((await app!.inject({ method: 'PUT', url, headers: headers(readerCookie), payload })).statusCode).toBe(403);
      expect(
        (
          await app!.inject({
            method: 'PUT',
            url,
            headers: headers(),
            payload: { ...payload, target: 'https://evil.test' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app!.inject({ method: 'PUT', url, headers: headers(), payload: { ...payload, image_id: null } })).json()
          .code,
      ).toBe('BANNER_IMAGE_REQUIRED');

      const saved = await app!.inject({ method: 'PUT', url, headers: headers(), payload });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ version: 1, target: 'fitness-plan-library', image_path: publicPath });
      expect((await app!.inject({ method: 'GET', url: publicPath })).statusCode).toBe(200);
      expect((await app!.inject({ method: 'GET', url: '/api/v1/banners' })).json().items).toEqual([saved.json()]);

      const competing = await Promise.all(
        ['fitness-template-library', 'fitness-exercises'].map((target) =>
          app!.inject({ method: 'PUT', url, headers: headers(), payload: { ...payload, version: 1, target } }),
        ),
      );
      expect(competing.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const winner = competing.find((response) => response.statusCode === 200)!.json();
      expect(winner.version).toBe(2);
      expect(['fitness-template-library', 'fitness-exercises']).toContain(winner.target);

      const disabled = await app!.inject({
        method: 'PUT',
        url,
        headers: headers(),
        payload: { ...payload, version: 2, is_enabled: false },
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect((await app!.inject({ method: 'GET', url: '/api/v1/banners' })).json()).toEqual({ items: [] });
      expect((await app!.inject({ method: 'GET', url: publicPath })).statusCode).toBe(404);
      const audit = await prisma.auditLog.count({
        where: { action: 'banner.update', target: { path: ['id'], equals: 'fitness-plan-library' } },
      });
      expect(audit).toBeGreaterThanOrEqual(3);
    } catch (cause) {
      throw new Error('Banner 管理与客户端公开契约验证失败', { cause });
    }
  });
});
