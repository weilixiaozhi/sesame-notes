import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient, type Prisma } from '@prisma/client';
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
const officialIds: string[] = [];

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
    await prisma.officialFitnessContent.deleteMany({ where: { id: { in: officialIds } } });
    await prisma.adminAccount.deleteMany({ where: { username: { in: [writerName, readerName] } } });
    if (groupId) await prisma.adminGroup.delete({ where: { id: groupId } });
    await prisma.$disconnect();
    if (directory) await removeOwnedFixture(directory);
  } catch (cause) {
    throw new Error('Banner 集成测试资源清理失败', { cause });
  }
});

describe('Banner 轮播管理与客户端兼容', () => {
  it('每张独立跳转和排序，旧客户端只取首张，逐张删除后由客户端使用默认入口', async () => {
    try {
      const initial = await app!.inject({ method: 'GET', url: '/api/v1/admin/banners', headers: headers() });
      expect(initial.statusCode, initial.body).toBe(200);
      expect(initial.json().items).toEqual([]);
      expect((await app!.inject({ method: 'GET', url: '/api/v1/banners?format=carousel' })).json()).toEqual({
        items: [],
      });
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
      const imagePath = upload.json().image_path as string;
      expect((await app!.inject({ method: 'GET', url: imagePath })).statusCode).toBe(404);
      const preview = await app!.inject({
        method: 'GET',
        url: `/api/v1/admin/banners/media/${uploadedId}`,
        headers: { cookie: readerCookie },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.rawPayload).toEqual(await readFile(bannerMediaFile(directory!, uploadedId!)));

      const planId = randomUUID();
      const templateId = randomUUID();
      for (const [kind, id] of [
        ['plan', planId],
        ['template', templateId],
      ] as const) {
        const sample = await prisma.officialFitnessContent.findFirstOrThrow({ where: { kind, isEnabled: true } });
        const original = sample.content as Record<string, unknown>;
        await prisma.officialFitnessContent.create({
          data: {
            id,
            kind,
            isEnabled: true,
            updatedBy: writerName,
            content: {
              ...original,
              id,
              name: { zh: `轮播${kind}${runId}`, zh_hant: '輪播測試', en: 'Carousel test' },
            } as Prisma.InputJsonObject,
          },
        });
        officialIds.push(id);
      }
      const options = await app!.inject({
        method: 'GET',
        url: '/api/v1/admin/banners/targets?kind=plan',
        headers: headers(readerCookie),
      });
      expect(options.statusCode, options.body).toBe(200);
      expect(options.json().items.map((item: { id: string }) => item.id)).toContain(planId);

      const base = {
        slot: 'fitness-plan-library',
        image_id: uploadedId,
        target: 'fitness-plan-library',
        target_id: null,
        sort_order: 20,
      };
      const denied = await app!.inject({
        method: 'POST',
        url: '/api/v1/admin/banners',
        headers: headers(readerCookie),
        payload: base,
      });
      expect(denied.statusCode).toBe(403);
      expect(
        (
          await app!.inject({
            method: 'POST',
            url: '/api/v1/admin/banners',
            headers: headers(),
            payload: { ...base, target: 'official-template', target_id: planId },
          })
        ).json().code,
      ).toBe('BANNER_TARGET_UNAVAILABLE');
      expect(
        (
          await app!.inject({
            method: 'POST',
            url: '/api/v1/admin/banners',
            headers: headers(),
            payload: { ...base, target: 'official-plan', target_id: null },
          })
        ).json().code,
      ).toBe('BANNER_TARGET_REQUIRED');
      const first = await app!.inject({
        method: 'POST',
        url: '/api/v1/admin/banners',
        headers: headers(),
        payload: base,
      });
      expect(first.statusCode, first.body).toBe(201);
      const firstId = first.json().id as string;
      const second = await app!.inject({
        method: 'POST',
        url: '/api/v1/admin/banners',
        headers: headers(),
        payload: { ...base, target: 'official-plan', target_id: planId, sort_order: 10 },
      });
      expect(second.statusCode, second.body).toBe(201);
      const secondId = second.json().id as string;
      expect(second.json()).toMatchObject({
        target_id: planId,
        target_name: `轮播plan${runId}`,
        source: 'remote',
        updated_by: writerName,
      });
      const third = await app!.inject({
        method: 'POST',
        url: '/api/v1/admin/banners',
        headers: headers(),
        payload: {
          ...base,
          slot: 'fitness-template-library',
          target: 'official-template',
          target_id: templateId,
          sort_order: 0,
        },
      });
      expect(third.statusCode, third.body).toBe(201);
      const thirdId = third.json().id as string;
      const carousel = (await app!.inject({ method: 'GET', url: '/api/v1/banners?format=carousel' })).json().items;
      expect(carousel.map((entry: { id: string }) => entry.id)).toEqual([secondId, firstId, thirdId]);
      expect(carousel[0]).toMatchObject({ target: 'official-plan', target_id: planId, version: 1, sort_order: 10 });
      expect(carousel[0]).not.toHaveProperty('updated_by');
      const legacy = (await app!.inject({ method: 'GET', url: '/api/v1/banners' })).json().items;
      expect(legacy).toHaveLength(2);
      expect(legacy.map((entry: { target: string }) => entry.target)).toEqual([
        'fitness-plan-library',
        'fitness-template-library',
      ]);
      expect(new Set(legacy.map((entry: { slot: string }) => entry.slot)).size).toBe(2);
      expect((await app!.inject({ method: 'GET', url: imagePath })).statusCode).toBe(200);

      const races = await Promise.all(
        ['fitness-exercises', 'fitness-plans'].map((target) =>
          app!.inject({
            method: 'PATCH',
            url: `/api/v1/admin/banners/${secondId}`,
            headers: headers(),
            payload: { ...base, target, sort_order: 10, version: 1 },
          }),
        ),
      );
      expect(races.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(races.find((response) => response.statusCode === 200)!.json().version).toBe(2);
      await prisma.officialFitnessContent.update({ where: { id: templateId }, data: { isEnabled: false } });
      const afterUnavailable = (await app!.inject({ method: 'GET', url: '/api/v1/banners?format=carousel' })).json()
        .items;
      expect(afterUnavailable.some((entry: { id: string }) => entry.id === thirdId)).toBe(false);
      await prisma.officialFitnessContent.update({ where: { id: templateId }, data: { isEnabled: true } });

      const removed = await app!.inject({
        method: 'DELETE',
        url: `/api/v1/admin/banners/${firstId}`,
        headers: headers(),
        payload: { version: 1 },
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect((await prisma.appBanner.findUniqueOrThrow({ where: { id: firstId } })).deletedAt).not.toBeNull();
      expect(
        (
          await app!.inject({
            method: 'DELETE',
            url: `/api/v1/admin/banners/${firstId}`,
            headers: headers(),
            payload: { version: 1 },
          })
        ).statusCode,
      ).toBe(404);
      const staleDelete = await app!.inject({
        method: 'DELETE',
        url: `/api/v1/admin/banners/${secondId}`,
        headers: headers(),
        payload: { version: 1 },
      });
      expect(staleDelete.statusCode, staleDelete.body).toBe(409);
      const removedSecond = await app!.inject({
        method: 'DELETE',
        url: `/api/v1/admin/banners/${secondId}`,
        headers: headers(),
        payload: { version: 2 },
      });
      expect(removedSecond.statusCode, removedSecond.body).toBe(200);
      const rows = (await app!.inject({ method: 'GET', url: '/api/v1/admin/banners', headers: headers() })).json()
        .items;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: thirdId, source: 'remote' });
      const removedThird = await app!.inject({
        method: 'DELETE',
        url: `/api/v1/admin/banners/${thirdId}`,
        headers: headers(),
        payload: { version: 1 },
      });
      expect(removedThird.statusCode, removedThird.body).toBe(200);
      expect((await app!.inject({ method: 'GET', url: '/api/v1/banners?format=carousel' })).json()).toEqual({
        items: [],
      });
      expect((await app!.inject({ method: 'GET', url: '/api/v1/banners' })).json()).toEqual({ items: [] });
      expect((await app!.inject({ method: 'GET', url: imagePath })).statusCode).toBe(404);
      const last = (await app!.inject({ method: 'GET', url: '/api/v1/admin/banners', headers: headers() })).json()
        .items;
      expect(last).toEqual([]);
      const removedResetRoute = await app!.inject({
        method: 'POST',
        url: '/api/v1/admin/banners/fitness-plan-library/reset',
        headers: headers(),
        payload: { revisions: [] },
      });
      expect(removedResetRoute.statusCode, removedResetRoute.body).toBe(404);
    } catch (cause) {
      throw new Error('Banner 轮播管理与兼容契约验证失败', { cause });
    }
  });

  it('官方内容下拉完整返回超过一百条的可用选项，排除已停用内容', async () => {
    try {
      const sample = await prisma.officialFitnessContent.findFirstOrThrow({
        where: { kind: 'template', isEnabled: true },
      });
      const original = sample.content as Record<string, unknown>;
      const data = Array.from({ length: 102 }, (_, index) => {
        const id = randomUUID();
        officialIds.push(id);
        return {
          id,
          kind: 'template',
          isEnabled: index < 101,
          updatedBy: writerName,
          content: {
            ...original,
            id,
            name: { zh: `完整下拉${index}${runId}`, zh_hant: '完整選項', en: 'Complete option' },
          } as Prisma.InputJsonObject,
        };
      });
      await prisma.officialFitnessContent.createMany({ data });
      const response = await app!.inject({
        method: 'GET',
        url: '/api/v1/admin/banners/targets?kind=template',
        headers: headers(readerCookie),
      });
      expect(response.statusCode, response.body).toBe(200);
      const ids = new Set(response.json().items.map((item: { id: string }) => item.id));
      for (const row of data.slice(0, 101)) expect(ids.has(row.id)).toBe(true);
      expect(ids.has(data[101]!.id)).toBe(false);
    } catch (cause) {
      throw new Error('官方内容下拉完整性验证失败', { cause });
    }
  });
});
