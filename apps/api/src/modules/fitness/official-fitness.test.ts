import cookie from '@fastify/cookie';
import type { OfficialFitnessContent, Prisma, PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { registerErrorHandler } from '../../shared/errors.js';
import type { ApiConfig } from '../../shared/api-config.js';
import { enforceAdminRouteProtection } from '../admin/index.js';
import {
  normalizeOfficialContent,
  officialResponse,
  officialExerciseIds,
  registerOfficialFitnessRoutes,
  requireOfficialVersion,
  validateOfficialContent,
} from './official-fitness.js';
import { registerOfficialFitnessMediaRoutes, validateFitnessGif } from './official-fitness-media.js';
import { registerFitnessLibraryRoutes } from './fitness-library.js';
import { fitnessMediaFile } from './fitness-media-storage.js';
import { validateFitnessPayload } from './fitness-rules.js';
import { fitnessPreferences } from '../../../test/fitness-fixtures.js';
import library from './fitness-library.json' with { type: 'json' };

const NOW = new Date('2026-10-10T01:00:00.000Z');
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://admin.example.test';
const headers = { cookie: `__Secure-sesame_admin_session=${'a'.repeat(64)}`, origin: ORIGIN, 'x-admin-request': '1' };
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

/** 内存仓储保留真实身份守卫，仅替代数据库读写。 */
function repository() {
  const db = {
    officialFitnessContent: {
      findMany: vi.fn().mockResolvedValue([row()]),
      findFirst: vi.fn().mockResolvedValue(row()),
      findUnique: vi.fn().mockResolvedValue(row()),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn(),
      update: vi.fn(),
    },
    officialFitnessState: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 1, contentVersion: 1 }),
      update: vi.fn(),
    },
    officialFitnessTaxon: {
      findMany: vi.fn().mockResolvedValue([
        {
          kind: 'body_part',
          id: 'chest',
          nameZh: '胸部',
          nameHant: '胸部',
          nameEn: 'chest',
          deletedAt: null,
        },
        ...[...new Set(['barbell', ...library.templates.flatMap((template) => template.equipment)])].map((id) => ({
          kind: 'equipment',
          id,
          nameZh: id,
          nameHant: id,
          nameEn: id,
          deletedAt: null,
        })),
      ]),
    },
    officialFitnessMedia: { findUnique: vi.fn().mockResolvedValue(null) },
    adminSession: {
      findUnique: vi.fn().mockResolvedValue({
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
          displayName: '运营',
          identityType: 'standard_user',
          isEnabled: true,
          deletedAt: null,
          version: 1,
          groupId: 'group',
          group: {
            id: 'group',
            name: '运营',
            version: 1,
            isEnabled: true,
            deletedAt: null,
            permissions: ['fitness:read', 'fitness:write'],
            pageIds: [],
          },
        },
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    adminAccount: { findUnique: vi.fn().mockResolvedValue({ username: 'ops_test' }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((operation: (tx: typeof db) => unknown) => operation(db));
  db.officialFitnessContent.create.mockImplementation(({ data }: { data: Partial<OfficialFitnessContent> }) =>
    row(data),
  );
  db.officialFitnessContent.update.mockImplementation(
    ({ data }: { data: Partial<OfficialFitnessContent> & { version: { increment: number } } }) =>
      row({ ...data, version: 2 }),
  );
  return db;
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

  it.each(['/api/v1/fitness/catalog', '/api/v1/fitness/library'])(
    '%s 返回持久化版本并保留条件缓存语义',
    async (url) => {
      const { app, db } = await application();
      db.officialFitnessState.findUniqueOrThrow.mockResolvedValue({ id: 1, contentVersion: 40 });
      const response = await app.inject({ url });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().content_version).toBe(40);
      expect(response.headers.etag).toMatch(/^"fitness-[0-9a-f]{24}"$/);
      const cached = await app.inject({ url, headers: { 'if-none-match': String(response.headers.etag) } });
      expect(cached.statusCode, cached.body).toBe(304);
      expect(cached.body).toBe('');
    },
  );

  it('版本记录缺失时后台保存失败，保留数据库原因且不写成功审计', async () => {
    const { app, db } = await application();
    const cause = Object.assign(new Error('官方目录版本记录不存在'), { code: 'P2025' });
    db.officialFitnessState.update.mockRejectedValue(cause);
    const log = vi.spyOn(app.log, 'error');
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/fitness/exercises/0025',
        headers,
        payload: { version: 1, is_enabled: false },
      });
      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toMatchObject({ code: 'DATABASE_OPERATION_FAILED' });
      expect(db.auditLog.create).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]![0]).toMatchObject({
        err: { cause: { message: '官方健身目录版本更新失败', cause } },
      });
    } catch (error) {
      throw new Error('官方内容保存的版本原子性验收失败', { cause: error });
    } finally {
      log.mockRestore();
    }
  });

  it('后台列表必须具备独立身份，公开目录显示已保存正文并保留停用动作', async () => {
    const { app, db } = await application();
    expect((await app.inject({ url: '/api/v1/admin/fitness/exercises' })).statusCode).toBe(401);
    const list = await app.inject({ url: '/api/v1/admin/fitness/exercises', headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items[0].content.instructions_en).toEqual(['Extend arms']);
    db.officialFitnessContent.findMany.mockResolvedValue([
      row({ content: { ...exercise, name_zh: '已保存标题' }, isEnabled: false }),
    ]);
    const catalog = await app.inject({ url: '/api/v1/fitness/catalog' });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().exercises[0]).toMatchObject({
      name_zh: '已保存标题',
      is_enabled: false,
      media_url: '/api/v1/fitness/media/builtin-0025',
    });
    expect(
      (await app.inject({ url: '/api/v1/fitness/catalog', headers: { 'if-none-match': String(catalog.headers.etag) } }))
        .statusCode,
    ).toBe(304);
  });

  it('管理和公开接口仅提供正式动作资料，未知字段不能进入保存正文', async () => {
    const { app, db } = await application();
    const stored = row({ content: exercise });
    db.officialFitnessContent.findMany.mockResolvedValue([stored]);
    const list = await app.inject({ url: '/api/v1/admin/fitness/exercises', headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items[0].content).not.toHaveProperty('aliases');
    expect(officialResponse(stored).content).not.toHaveProperty('aliases');
    expect(() => normalizeOfficialContent('exercise', { ...exercise, aliases: ['未知字段'] }, stored.id)).toThrow(
      '官方内容字段不完整或格式不正确',
    );
    const catalog = await app.inject({ url: '/api/v1/fitness/catalog' });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().exercises[0]).not.toHaveProperty('aliases');
    const { id: _id, ...content } = exercise;
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fitness/exercises',
      headers,
      payload: { content },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json().content).not.toHaveProperty('aliases');
    expect(db.officialFitnessContent.create.mock.calls[0]![0].data.content).not.toHaveProperty('aliases');
  });

  it('新增立即保存正文并分配唯一永久身份，缓存版本与审计处于同一事务', async () => {
    const { app, db } = await application();
    const { id: _id, ...content } = exercise;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/fitness/exercises',
      headers,
      payload: { content },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ content: { name_zh: '卧推' }, is_enabled: true });
    expect(created.json()).not.toHaveProperty('published_content');
    expect(created.json()).not.toHaveProperty('has_unpublished_changes');
    expect(created.json().id).toMatch(/^[a-f0-9-]{36}$/);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.officialFitnessState.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 1 },
      data: { contentVersion: { increment: 1 } },
    });
  });

  it('保存拒绝过期版本，成功保存立即推进全局版本并更新正文', async () => {
    const { app, db } = await application();
    const conflict = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/fitness/exercises/0025',
      headers,
      payload: { version: 9 },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(db.officialFitnessContent.update).not.toHaveBeenCalled();
    expect(db.officialFitnessState.update).not.toHaveBeenCalled();
    const { id: _id, ...content } = exercise;
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/fitness/exercises/0025',
      headers,
      payload: { version: 1, content: { ...content, name_zh: '修改后的卧推' } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(db.officialFitnessState.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 1 },
      data: { contentVersion: { increment: 1 } },
    });
    expect(db.officialFitnessContent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: { ...exercise, name_zh: '修改后的卧推' }, isEnabled: true }),
      }),
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/fitness/exercises/0025/publish',
          headers,
          payload: { version: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('禁止悬空模板和计划引用，也禁止停用仍在使用的下层官方内容', async () => {
    const db = repository();
    const tx = db as unknown as Prisma.TransactionClient;
    const template = library.templates[0]!;
    await expect(
      validateOfficialContent(tx, row({ id: template.id, kind: 'template', content: template })),
    ).rejects.toMatchObject({ code: 'FITNESS_REFERENCE_UNAVAILABLE' });
    await expect(
      validateOfficialContent(tx, row({ id: library.plans[0]!.id, kind: 'plan', content: library.plans[0]! })),
    ).rejects.toMatchObject({ code: 'FITNESS_REFERENCE_UNAVAILABLE' });
    db.officialFitnessContent.findMany.mockResolvedValue([
      row({
        id: template.id,
        kind: 'template',
        content: { ...template, exercises: [{ ...template.exercises[0]!, exercise_id: '0025' }] },
      }),
    ]);
    await expect(validateOfficialContent(tx, row({ isEnabled: false }))).rejects.toMatchObject({
      code: 'FITNESS_CONTENT_REFERENCED',
    });
  });

  it('禁用官方动作保留同步白名单，未知 UUID 不因格式正确被放行', async () => {
    const db = repository();
    const id = '11111111-1111-4111-8111-111111111111';
    db.officialFitnessContent.findMany.mockResolvedValue([row({ id, isEnabled: false })]);
    const ids = await officialExerciseIds(db as unknown as Prisma.TransactionClient);
    expect(() =>
      validateFitnessPayload('fitness_preferences', { ...fitnessPreferences(), pinned_exercise_ids: [id] }, ids),
    ).not.toThrow();
    expect(() =>
      validateFitnessPayload(
        'fitness_preferences',
        { ...fitnessPreferences(), pinned_exercise_ids: ['99999999-9999-4999-8999-999999999999'] },
        ids,
      ),
    ).toThrow('置顶动作标识无效');
    expect(officialResponse(row({ content: { ...exercise, name_zh: '修改后的卧推' } })).content).toMatchObject({
      name_zh: '修改后的卧推',
    });
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
    await expect(
      requireOfficialVersion(db as unknown as Prisma.TransactionClient, 'template', '0025', 1),
    ).rejects.toMatchObject({ code: 'FITNESS_CONTENT_NOT_FOUND' });
  });
});
