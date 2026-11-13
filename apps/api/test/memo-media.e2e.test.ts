import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { cleanupMemoMediaFiles } from '../src/modules/memos/index.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { testStoragePath } from './test-storage-path.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const API_BASE = '/api/v1';

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'e2e-test-secret-that-is-at-least-32-bytes-long',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: testStoragePath('memo-media'),
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
const createdUsers: string[] = [];

/** 生成每次调用唯一且可登录的手机号（+86 区号，11 位）。 */
function uniquePhone(): string {
  return `138${randomUUID().replace(/\D/g, '').slice(0, 8)}`;
}

async function inject(
  method: 'get' | 'post' | 'put',
  path: string,
  options: { token?: string; body?: Record<string, unknown> } = {},
) {
  return app.inject({
    method,
    url: `${API_BASE}${path}`,
    payload: options.body,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

/** 注册独立账号并返回访问令牌；测试账号按创建顺序在结束时清理。 */
async function registerUser(): Promise<{ token: string; userId: string }> {
  const response = await inject('post', '/auth/register', {
    body: {
      country_code: '+86',
      phone: uniquePhone(),
      password: 'password-123456',
      device: { installation_id: randomUUID(), name: 'memo-media-device', platform: 'e2e' },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const session = JSON.parse(response.body) as { access_token: string; user: { user_id: string } };
  createdUsers.push(session.user.user_id);
  return { token: session.access_token, userId: session.user.user_id };
}

/** 生成固定尺寸 PNG，服务端会重编码并返回真实输出尺寸。 */
async function pngBase64(width: number, height: number): Promise<string> {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 130, b: 200 } },
  })
    .png()
    .toBuffer();
  return bytes.toString('base64');
}

beforeAll(() => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  app = buildApp({ config, prisma, logger: false });
});

afterAll(async () => {
  await app.close();
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describe('备忘录图片上传与读取', () => {
  it('同一标识同内容幂等，不同内容拒绝覆盖，读取返回原始字节', async () => {
    const { token } = await registerUser();
    const mediaId = randomUUID();
    const data = await pngBase64(64, 32);
    const first = await inject('put', `/memo-media/${mediaId}`, {
      token,
      body: { content_type: 'image/png', data_base64: data },
    });
    expect(first.statusCode, first.body).toBe(200);
    const metadata = JSON.parse(first.body) as { id: string; width: number; height: number; byte_size: number };
    expect(metadata).toMatchObject({ id: mediaId, width: 64, height: 32 });
    expect(metadata.byte_size).toBeGreaterThan(0);

    const repeated = await inject('put', `/memo-media/${mediaId}`, {
      token,
      body: { content_type: 'image/png', data_base64: data },
    });
    expect(repeated.statusCode).toBe(200);
    expect(JSON.parse(repeated.body)).toMatchObject({ sha256: JSON.parse(first.body).sha256 });

    const otherData = await pngBase64(32, 32);
    const conflict = await inject('put', `/memo-media/${mediaId}`, {
      token,
      body: { content_type: 'image/png', data_base64: otherData },
    });
    expect(conflict.statusCode).toBe(409);
    expect(JSON.parse(conflict.body).code).toBe('MEMO_MEDIA_CONFLICT');

    const download = await inject('get', `/memo-media/${mediaId}`, { token });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('image/png');
    expect(download.headers.etag).toContain(JSON.parse(first.body).sha256);
    // 下载字节必须与元数据摘要一致：重编码可能因输入而异，但读取的始终是保存结果。
    expect(createHash('sha256').update(download.rawPayload).digest('hex')).toBe(JSON.parse(first.body).sha256);
    const meta = await sharp(download.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'png', width: 64, height: 32 });
  });

  it('其他账号、未登录与无效图片都不能读取或写入', async () => {
    const owner = await registerUser();
    const stranger = await registerUser();
    const mediaId = randomUUID();
    const data = await pngBase64(16, 16);
    expect(
      (
        await inject('put', `/memo-media/${mediaId}`, {
          token: owner.token,
          body: { content_type: 'image/png', data_base64: data },
        })
      ).statusCode,
    ).toBe(200);

    expect((await inject('get', `/memo-media/${mediaId}`, { token: stranger.token })).statusCode).toBe(404);
    expect((await inject('get', `/memo-media/${mediaId}`)).statusCode).toBe(401);
    const spoofed = await inject('put', `/memo-media/${randomUUID()}`, {
      token: owner.token,
      body: { content_type: 'image/jpeg', data_base64: data },
    });
    expect(spoofed.statusCode).toBe(422);
    expect(JSON.parse(spoofed.body).code).toBe('MEMO_MEDIA_INVALID');
  });
});

describe('备忘录图片孤儿清理', () => {
  it('超过宽限期且未被正文引用的文件被删除，被引用的文件保留', async () => {
    const { token, userId } = await registerUser();
    const referencedId = randomUUID();
    const staleId = randomUUID();
    const data = await pngBase64(24, 24);
    for (const id of [referencedId, staleId]) {
      const response = await inject('put', `/memo-media/${id}`, {
        token,
        body: { content_type: 'image/png', data_base64: data },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    const bookId = randomUUID();
    const now = new Date();
    await prisma.memoBook.create({
      data: { id: bookId, ownerId: userId, name: '清理验证本', type: 'normal', createdAt: now, updatedAt: now },
    });
    await prisma.memoEntry.create({
      data: {
        id: randomUUID(),
        memoBookId: bookId,
        bookType: 'normal',
        title: '清理验证',
        bodyFormat: 'delta_v1',
        body: { ops: [{ insert: { memo_image: referencedId } }, { insert: '\n' }] },
        createdAt: now,
        updatedAt: now,
      },
    });
    const directory = resolve(config.storagePath, 'memo-media', userId);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const files = { [referencedId]: `${referencedId}.png`, [staleId]: `${staleId}.png` };
    for (const fileName of Object.values(files)) await utimes(resolve(directory, fileName), old, old);

    const log = { warn: () => {}, error: () => {} } as unknown as FastifyBaseLogger;
    await cleanupMemoMediaFiles(prisma, config.storagePath, log);

    expect(await prisma.memoMedia.count({ where: { id: referencedId } })).toBe(1);
    expect(await prisma.memoMedia.count({ where: { id: staleId } })).toBe(0);
    await expect(stat(resolve(directory, files[referencedId]!))).resolves.toBeTruthy();
    await expect(stat(resolve(directory, files[staleId]!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('未登记元数据的旧文件同样被回收', async () => {
    const { userId } = await registerUser();
    const directory = resolve(config.storagePath, 'memo-media', userId);
    const orphan = `${randomUUID()}.webp`;
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, orphan), 'orphan');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await utimes(resolve(directory, orphan), old, old);
    await cleanupMemoMediaFiles(prisma, config.storagePath, {
      warn: () => {},
      error: () => {},
    } as unknown as FastifyBaseLogger);
    await expect(readFile(resolve(directory, orphan))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
