import cookie from '@fastify/cookie';
import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../shared/api-config.js';
import { registerErrorHandler } from '../../shared/errors.js';
import { registerOfficialFitnessMediaRoutes } from './official-fitness-media.js';
import { fitnessMediaFile } from './fitness-media-storage.js';
import { createOwnedFixture, removeOwnedFixture } from '../../../test/owned-fixture-directory.js';

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>();
  return { ...actual, default: vi.fn(actual.default) };
});

const fixtures: Array<{ storagePath: string; app?: ReturnType<typeof Fastify> }> = [];
const originalFileCacheLimit = sharp.cache().files.max;

// 临时素材在用例结束时回收，测试期间不让 libvips 文件缓存跨用例持有素材句柄。
beforeAll(() => sharp.cache({ files: 0 }));
afterAll(() => sharp.cache({ files: originalFileCacheLimit }));

/** 每个用例独享受控缓存目录，只替代素材数据库，不连接共享测试库。 */
async function application(referenced = true) {
  try {
    const fixture: (typeof fixtures)[number] = { storagePath: await createOwnedFixture('fitness-preview') };
    fixtures.push(fixture);
    const app = Fastify({ logger: false });
    fixture.app = app;
    await app.register(cookie);
    registerErrorHandler(app);
    const db = {
      officialFitnessMedia: { findUnique: vi.fn().mockResolvedValue({ id: 'media' }) },
      officialFitnessContent: { findFirst: vi.fn().mockResolvedValue(referenced ? { id: 'exercise' } : null) },
    };
    const storagePath = fixture.storagePath;
    registerOfficialFitnessMediaRoutes(app, db as unknown as PrismaClient, { storagePath } as ApiConfig);
    await app.ready();
    return { app, db, storagePath };
  } catch (cause) {
    throw new Error('动作预览测试夹具准备失败', { cause });
  }
}

afterEach(async () => {
  try {
    await Promise.all(
      fixtures.splice(0).map(async ({ app, storagePath }) => {
        try {
          await app?.close();
        } finally {
          // 关闭失败或夹具准备异常时仍回收已登记的唯一目录，不认领其他运行的缓存。
          await removeOwnedFixture(storagePath);
        }
      }),
    );
  } catch (cause) {
    throw new Error('动作预览测试夹具回收失败', { cause });
  } finally {
    vi.mocked(sharp).mockClear();
  }
});

describe('动作静态预览', () => {
  it.each(['constructor', 'toString', '__proto__'])('内置素材只接受目录自身身份：%s', async (key) => {
    const { app } = await application();
    const response = await app.inject({ url: `/api/v1/fitness/media/builtin-${key}` });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe('FITNESS_MEDIA_NOT_FOUND');
    expect(sharp).not.toHaveBeenCalled();
  });

  it('原始地址保留 GIF 动画，预览地址返回真实单帧 WebP 并支持条件读取', async () => {
    const { app } = await application();
    const original = await app.inject({ url: '/api/v1/fitness/media/builtin-0025' });
    expect(original.statusCode, original.body).toBe(200);
    expect(original.headers['content-type']).toBe('image/gif');
    const source = await sharp(original.rawPayload, { animated: true }).metadata();
    expect(source.pages).toBeGreaterThan(1);

    const response = await app.inject({ url: '/api/v1/fitness/media/builtin-0025?preview=1' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['cache-control']).toBe('public, max-age=86400');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    const preview = await sharp(response.rawPayload, { animated: true }).metadata();
    expect(preview.format).toBe('webp');
    expect(preview.pages ?? 1).toBe(1);
    expect(preview.width).toBeLessThanOrEqual(320);
    expect(preview.height).toBeLessThanOrEqual(320);
    expect(response.rawPayload.length).toBeLessThan(original.rawPayload.length);
    const unchanged = await app.inject({
      url: '/api/v1/fitness/media/builtin-0025?preview=1',
      headers: { 'if-none-match': `"another", W/${response.headers.etag}` },
    });
    expect(unchanged.statusCode, unchanged.body).toBe(304);
    expect(unchanged.rawPayload.length).toBe(0);
    expect(unchanged.headers.etag).toBe(response.headers.etag);
  });

  it('同时请求只解码一次，后续读取命中磁盘缓存', async () => {
    const { app, storagePath } = await application();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ url: '/api/v1/fitness/media/builtin-0025?preview=1' })),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.headers.etag)).size).toBe(1);
    expect(sharp).toHaveBeenCalledTimes(1);
    expect(await readdir(resolve(storagePath, 'fitness-media', 'previews-v1'))).toHaveLength(1);
    const cached = await app.inject({ url: '/api/v1/fitness/media/builtin-0025?preview=1' });
    expect(cached.rawPayload).toEqual(responses[0]!.rawPayload);
    expect(sharp).toHaveBeenCalledTimes(1);
  });

  it('已缓存上传素材仍先检查保存引用，后台预览也必须登录', async () => {
    const { app, db, storagePath } = await application();
    const original = await readFile(fitnessMediaFile(storagePath, 'builtin-0025'));
    const id = createHash('sha256').update(original).digest('hex');
    await mkdir(resolve(storagePath, 'fitness-media'), { recursive: true });
    await writeFile(fitnessMediaFile(storagePath, id), original, { flag: 'wx' });
    const response = await app.inject({ url: `/api/v1/fitness/media/${id}?preview=1` });
    expect(response.statusCode, response.body).toBe(200);
    expect(db.officialFitnessContent.findFirst).toHaveBeenCalledWith({
      where: { kind: 'exercise', content: { path: ['media_id'], equals: id } },
      select: { id: true },
    });
    db.officialFitnessContent.findFirst.mockResolvedValue(null);
    const unavailable = await app.inject({
      url: `/api/v1/fitness/media/${id}?preview=1`,
      headers: { 'if-none-match': String(response.headers.etag) },
    });
    expect(unavailable.statusCode, unavailable.body).toBe(404);
    expect((await app.inject({ url: `/api/v1/admin/fitness/media/${id}?preview=1` })).statusCode).toBe(401);
  });

  it('无效预览参数不能进入图片解码', async () => {
    const { app } = await application();
    expect((await app.inject({ url: '/api/v1/fitness/media/builtin-0025?preview=2' })).statusCode).toBe(400);
    expect(sharp).not.toHaveBeenCalled();
  });
});
