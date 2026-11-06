import cookie from '@fastify/cookie';
import type { OfficialFitnessContent, PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { registerErrorHandler } from '../../shared/errors.js';
import type { ApiConfig } from '../../shared/api-config.js';
import { enforceAdminRouteProtection } from '../admin/index.js';
import { normalizeOfficialContent, registerOfficialFitnessRoutes } from './official-fitness.js';
import { registerOfficialFitnessMediaRoutes, validateFitnessGif } from './official-fitness-media.js';
import { registerFitnessLibraryRoutes } from './fitness-library.js';
import { fitnessMediaFile } from './fitness-media-storage.js';
import library from './fitness-library.json' with { type: 'json' };

const NOW = new Date('2026-10-10T01:00:00.000Z');
const ORIGIN = 'https://admin.example.test';
const apps: ReturnType<typeof Fastify>[] = [];
const exercise = {
  id: '0025',
  name_zh: '卧推',
  name_zh_hant: '臥推',
  name_en: 'Bench press',
  body_part: 'chest',
  equipment: 'barbell',
  target: 'pectorals',
  secondary_muscles: [],
  instructions_zh: ['伸展手臂'],
  instructions_zh_hant: ['伸展手臂'],
  instructions_en: ['Extend arms'],
  attribution: '',
  gif_asset: 'assets/fitness/videos/0025-EIeI8Vf.gif',
};

/** 构造已保存资料，管理端与客户端使用同一份正文。 */
function row(overrides: Partial<OfficialFitnessContent> = {}): OfficialFitnessContent {
  return {
    id: '0025',
    kind: 'exercise',
    version: 1,
    content: structuredClone(exercise),
    isEnabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    updatedBy: 'ops_test',
    ...overrides,
  };
}

/** 只替代公开目录、版本和媒体引用查询，响应仍经过生产路由。 */
function repository() {
  try {
    const db = {
      officialFitnessContent: {
        findMany: vi.fn().mockResolvedValue([row()]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      officialFitnessState: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 1, contentVersion: 1 }),
      },
      officialFitnessTaxon: {
        findMany: vi.fn(),
      },
      officialFitnessMedia: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(),
    };
    db.$transaction.mockImplementation((operation: (tx: typeof db) => unknown) => operation(db));
    return db;
  } catch (cause) {
    throw new Error('官方目录只读夹具准备失败', { cause });
  }
}

/** 所有请求使用生产路由、封闭 schema 和独立后台认证。 */
async function application(db = repository()) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  registerErrorHandler(app);
  enforceAdminRouteProtection(app);
  const config = { adminOrigins: [ORIGIN], storagePath: resolve('Temp/official-fitness-tests') } as ApiConfig;
  registerOfficialFitnessRoutes(app, db as unknown as PrismaClient, config);
  registerFitnessLibraryRoutes(app, db as unknown as PrismaClient);
  registerOfficialFitnessMediaRoutes(app, db as unknown as PrismaClient, config);
  await app.ready();
  return { app, db };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('官方健身目录', () => {
  it.each(['/api/v1/fitness/catalog', '/api/v1/fitness/library'])(
    '目录版本缺失时 %s 明确失败且只记录一次原始原因',
    async (url) => {
      const { app, db } = await application();
      const cause = Object.assign(new Error('官方目录版本记录不存在'), { code: 'P2025' });
      db.officialFitnessState.findUniqueOrThrow.mockRejectedValue(cause);
      const log = vi.spyOn(app.log, 'error');
      try {
        const response = await app.inject({ url });
        expect(response.statusCode, response.body).toBe(500);
        expect(response.json()).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
        expect(response.json()).not.toHaveProperty('content_version');
        expect(response.headers).not.toHaveProperty('etag');
        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0]![0]).toMatchObject({ err: { cause } });
      } catch (error) {
        throw new Error('官方内容缺失版本的 HTTP 验收失败', { cause: error });
      } finally {
        log.mockRestore();
      }
    },
  );

  it('公开内容库返回持久化版本并保留条件缓存语义', async () => {
    const url = '/api/v1/fitness/library';
    const { app, db } = await application();
    db.officialFitnessState.findUniqueOrThrow.mockResolvedValue({ id: 1, contentVersion: 40 });
    const response = await app.inject({ url });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().content_version).toBe(40);
    expect(response.headers.etag).toMatch(/^"fitness-[0-9a-f]{24}"$/);
    expect(db.officialFitnessTaxon.findMany).not.toHaveBeenCalled();
    const cached = await app.inject({ url, headers: { 'if-none-match': String(response.headers.etag) } });
    expect(cached.statusCode, cached.body).toBe(304);
    expect(cached.body).toBe('');
  });

  it('周期安排和自重字段遵守现有训练契约，身份与修订不能被正文覆盖', () => {
    const plan = library.plans[0]!;
    expect(() => normalizeOfficialContent('plan', { ...plan, days: [plan.days[0], plan.days[0]] }, plan.id)).toThrow();
    const template = library.templates[0]!;
    expect(() =>
      normalizeOfficialContent(
        'template',
        { ...template, exercises: [{ ...template.exercises[0], weight_mode: 'body_weight', weight_kg: '12' }] },
        template.id,
      ),
    ).toThrow();
    expect(normalizeOfficialContent('exercise', exercise, 'replacement').id).toBe('replacement');
    expect(() => normalizeOfficialContent('exercise', { ...exercise, name_zh: '  ' }, 'replacement')).toThrow();
    expect(() => normalizeOfficialContent('exercise', { ...exercise, attribution: '\u0000' }, 'replacement')).toThrow();
  });

  it('媒体路径只接受白名单或内容摘要，并拒绝伪 GIF 和损坏 GIF', async () => {
    expect(() => fitnessMediaFile('/data', '../../password')).toThrow();
    expect(() => fitnessMediaFile('/data', 'builtin-unknown')).toThrow();
    const path = fitnessMediaFile('/data', 'builtin-0025');
    const gif = await readFile(path);
    const valid = await validateFitnessGif('exercise.gif', gif.toString('base64'));
    expect(valid.width).toBeGreaterThan(0);
    expect(valid.frames).toBeGreaterThan(1);
    await expect(validateFitnessGif('../x.gif', gif.toString('base64'))).rejects.toMatchObject({
      code: 'FITNESS_MEDIA_FILENAME',
    });
    await expect(validateFitnessGif('x.gif', Buffer.from('not gif').toString('base64'))).rejects.toMatchObject({
      code: 'FITNESS_MEDIA_FORMAT',
    });
    await expect(validateFitnessGif('x.gif', Buffer.from('GIF89aINVALID').toString('base64'))).rejects.toMatchObject({
      code: 'FITNESS_MEDIA_DECODE',
    });
  });

  it('尚未被动作引用的上传媒体不能通过公开接口读取', async () => {
    const { app, db } = await application();
    db.officialFitnessMedia.findUnique.mockResolvedValue({ id: 'a'.repeat(64) } as never);
    db.officialFitnessContent.findFirst.mockResolvedValue(null as never);
    const response = await app.inject({ url: `/api/v1/fitness/media/${'a'.repeat(64)}` });
    expect(response.statusCode, response.body).toBe(404);
  });
});
