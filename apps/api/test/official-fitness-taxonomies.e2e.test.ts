import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { hashAdminPassword } from '../src/modules/admin/index.js';
import { fitnessLibrary as library } from '../src/modules/fitness/testing.js';
import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { fitnessExercise, fitnessPreferences, fitnessWorkout } from './fitness-fixtures.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const ORIGIN = 'https://admin.example.test';
const RUN = randomUUID().replaceAll('-', '').slice(0, 16);
const PASSWORD = 'fitness-taxon-admin-password-42';
const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
const adminIds: string[] = [];
const groupIds: string[] = [];
const taxonIds: string[] = [];
const contentIds: string[] = [];
const userIds: string[] = [];
let app: ReturnType<typeof buildApp>;
let writer = '';
let reader = '';
let failAudit = false;
type Kind = 'body_part' | 'equipment';
type Taxon = {
  id: string;
  kind: Kind;
  name: { zh: string; zh_hant: string; en: string };
  sort_order: number;
  version: number;
  is_deleted: boolean;
  exercise_count: number;
  template_count: number;
};

const traditionalNames: ReadonlyArray<readonly [Kind, string, string]> = [
  ['body_part', 'back', '背部'],
  ['body_part', 'cardio', '有氧'],
  ['body_part', 'chest', '胸部'],
  ['body_part', 'lower arms', '前臂'],
  ['body_part', 'lower legs', '小腿'],
  ['body_part', 'neck', '頸部'],
  ['body_part', 'shoulders', '肩部'],
  ['body_part', 'upper arms', '上臂'],
  ['body_part', 'upper legs', '大腿'],
  ['body_part', 'waist', '腰腹'],
  ['equipment', 'assisted', '輔助器械'],
  ['equipment', 'band', '彈力帶'],
  ['equipment', 'barbell', '槓鈴'],
  ['equipment', 'body weight', '自重'],
  ['equipment', 'bosu ball', '半球平衡球'],
  ['equipment', 'cable', '滑輪器材'],
  ['equipment', 'dumbbell', '啞鈴'],
  ['equipment', 'elliptical machine', '橢圓機'],
  ['equipment', 'ez barbell', '曲桿槓鈴'],
  ['equipment', 'hammer', '錘子'],
  ['equipment', 'kettlebell', '壺鈴'],
  ['equipment', 'leverage machine', '固定器材'],
  ['equipment', 'medicine ball', '藥球'],
  ['equipment', 'olympic barbell', '奧林匹克槓鈴'],
  ['equipment', 'resistance band', '阻力帶'],
  ['equipment', 'roller', '泡沫軸'],
  ['equipment', 'rope', '繩索'],
  ['equipment', 'skierg machine', '滑雪訓練機'],
  ['equipment', 'sled machine', '腿推器材'],
  ['equipment', 'smith machine', '史密斯機'],
  ['equipment', 'stability ball', '健身球'],
  ['equipment', 'stationary bike', '健身單車'],
  ['equipment', 'stepmill machine', '登階機'],
  ['equipment', 'tire', '輪胎'],
  ['equipment', 'trap bar', '六角槓鈴'],
  ['equipment', 'upper body ergometer', '上肢功率車'],
  ['equipment', 'weighted', '負重器材'],
  ['equipment', 'wheel roller', '健腹輪'],
];

/** 迁移只在当前连接的临时同名表执行，真实种子、管理员编辑和缓存版本均不受测试影响。 */
async function withTraditionalNameFixture(
  run: (tx: Prisma.TransactionClient, apply: () => Promise<void>) => Promise<void>,
): Promise<void> {
  try {
    const source = await readFile(
      resolve(import.meta.dirname, '../prisma/migrations/20261010008000_official_fitness_taxonomies/migration.sql'),
      'utf8',
    );
    const seed = source.match(
      /INSERT INTO "official_fitness_taxonomies"[\s\S]*?AS defaults\(kind, id, name, position\);/,
    )?.[0];
    if (!seed) throw new Error('分类种子 SQL 未找到');
    const migration = await readFile(
      resolve(
        import.meta.dirname,
        '../prisma/migrations/20261010009000_fitness_taxonomy_traditional_names/migration.sql',
      ),
      'utf8',
    );
    const statements = migration
      .replace(/--[^\r\n]*/g, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE official_fitness_taxonomies (LIKE public.official_fitness_taxonomies INCLUDING ALL) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE official_fitness_state (LIKE public.official_fitness_state INCLUDING ALL) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe(seed);
        await tx.$executeRaw`INSERT INTO official_fitness_state (id, content_version) VALUES (1, 40)`;
        /** Prisma 已建立事务，只执行迁移正文；事务中的数据修正与缓存推进仍完整使用实际 SQL。 */
        async function apply(): Promise<void> {
          for (const statement of statements.slice(1, -1)) await tx.$executeRawUnsafe(statement);
        }
        await run(tx, apply);
      },
      { timeout: 15_000 },
    );
  } catch (cause) {
    throw new Error('健身分类繁体名称迁移验收失败', { cause });
  }
}

/** 后台写请求通过真实 Cookie、来源和动作权限校验。 */
function headers(cookie = writer) {
  return { cookie, origin: ORIGIN, 'x-admin-request': '1' };
}

/** 字典写操作均使用实际路由和操作原因，接口响应保留给断言检查。 */
async function mutate(
  method: 'POST' | 'PATCH' | 'DELETE',
  kind: Kind,
  id = '',
  payload: Record<string, unknown> = {},
  cookie = writer,
) {
  try {
    return await app.inject({
      method,
      url: `/api/v1/admin/fitness/taxonomies/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`,
      headers: headers(cookie),
      payload: { reason: '分类集成验收', ...payload },
    });
  } catch (cause) {
    throw new Error('健身分类请求执行失败', { cause });
  }
}

/** 创建独立字典身份，不改动任何已存在的种子分类。 */
async function createTaxon(kind: Kind, label = '验收分类'): Promise<Taxon> {
  try {
    const response = await mutate('POST', kind, '', { name: { zh: label, zh_hant: label, en: 'Test taxonomy' } });
    expect(response.statusCode, response.body).toBe(201);
    const taxon = response.json<Taxon>();
    taxonIds.push(taxon.id);
    return taxon;
  } catch (cause) {
    throw new Error('健身分类验收夹具创建失败', { cause });
  }
}

/** 用独立普通管理员登录，读写能力完全取决于关联用户组。 */
async function loginAdmin(kind: 'writer' | 'reader', passwordHash: string): Promise<string> {
  try {
    const group = await prisma.adminGroup.create({
      data: {
        name: `字典验收-${kind}-${RUN}`,
        permissions: kind === 'writer' ? ['fitness:read', 'fitness:write'] : ['fitness:read'],
        pageIds: ['fitness_exercises'],
      },
    });
    groupIds.push(group.id);
    const admin = await prisma.adminAccount.create({
      data: {
        username: `taxon_${kind}_${RUN}`,
        displayName: '分类验收管理员',
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
    throw new Error('健身分类后台身份准备失败', { cause });
  }
}

/** 动作和模板都使用独立官方正文，停用内容仍属于需要迁移的实际引用。 */
async function createReferences(equipment: string, replacement: string) {
  try {
    const exerciseId = randomUUID();
    const exercise = {
      id: exerciseId,
      name_zh: '字典验收卧推',
      name_zh_hant: '字典驗收臥推',
      name_en: 'Taxonomy bench press',
      body_part: 'chest',
      equipment,
      target: 'pectorals',
      secondary_muscles: [],
      instructions_zh: ['伸展手臂'],
      instructions_zh_hant: ['伸展手臂'],
      instructions_en: ['Extend arms'],
      attribution: '',
      gif_asset: 'assets/fitness/videos/0025-EIeI8Vf.gif',
    };
    await prisma.officialFitnessContent.create({
      data: { id: exerciseId, kind: 'exercise', content: exercise, isEnabled: false },
    });
    contentIds.push(exerciseId);
    const templateId = randomUUID();
    const template = {
      ...library.templates[0]!,
      id: templateId,
      revision: 5,
      equipment: [equipment, replacement],
      exercises: [{ ...library.templates[0]!.exercises[0]!, exercise_id: exerciseId }],
    };
    await prisma.officialFitnessContent.create({
      data: { id: templateId, kind: 'template', content: template, isEnabled: false },
    });
    contentIds.push(templateId);
    return { exerciseId, templateId, exercise, template };
  } catch (cause) {
    throw new Error('健身分类引用夹具创建失败', { cause });
  }
}

/** 保存用户训练与自定义动作的历史分类，官方字典变更不得改写这些私有资料。 */
async function createUserHistory(equipment: string, exerciseId: string) {
  try {
    const user = await prisma.user.create({
      data: {
        phoneE164: `+86138${randomInt(100_000_000).toString().padStart(8, '0')}`,
        sesameNumber: String(randomInt(100_000_000, 999_999_999)),
        passwordHash: 'taxonomy-history-fixture',
      },
    });
    userIds.push(user.id);
    const space = await prisma.fitnessSpace.create({
      data: { id: randomUUID(), ownerId: user.id, name: '字典历史验收', createdAt: new Date(), updatedAt: new Date() },
    });
    const preference = fitnessPreferences();
    const workout = fitnessWorkout();
    const payloads = [
      {
        entityType: 'fitness_preferences',
        payload: {
          ...preference,
          custom_exercises: [
            {
              id: `custom:${randomUUID()}`,
              name: '用户动作',
              body_part: 'chest',
              equipment,
              icon: 'Fitness',
              image: null,
              deleted: false,
            },
          ],
        },
      },
      {
        entityType: 'fitness_workout',
        payload: { ...workout, exercises: [{ ...fitnessExercise(false), exercise_id: exerciseId }] },
      },
    ];
    const records = [];
    for (const item of payloads) {
      records.push(
        await prisma.fitnessEntity.create({
          data: {
            id: item.entityType === 'fitness_preferences' ? space.id : randomUUID(),
            fitnessSpaceId: space.id,
            ...item,
            status: item.entityType === 'fitness_workout' ? workout.status : null,
            createdAt: new Date(item.payload.created_at),
            updatedAt: new Date(item.payload.updated_at),
          },
        }),
      );
    }
    return records;
  } catch (cause) {
    throw new Error('用户健身历史夹具创建失败', { cause });
  }
}

beforeAll(async () => {
  try {
    const config: ApiConfig = {
      databaseUrl: DATABASE_URL,
      jwtSecret: 'taxonomy-test-secret-that-is-at-least-32-bytes-long',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 2_592_000,
      storagePath: resolve('../../Temp', `taxonomy-${RUN}`),
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
    const injected = prisma.$extends({
      query: {
        auditLog: {
          /** 真实事务内模拟追加审计失败，确认分类与所有引用能够一起回滚。 */
          async create({ args, query }) {
            if (failAudit && args.data.action.startsWith('fitness.taxonomy.')) throw new Error('模拟分类审计写入失败');
            return query(args);
          },
        },
      },
    });
    app = buildApp({ logger: false, config, prisma: injected as unknown as PrismaClient });
    await app.ready();
    const passwordHash = await hashAdminPassword(PASSWORD);
    writer = await loginAdmin('writer', passwordHash);
    reader = await loginAdmin('reader', passwordHash);
  } catch (cause) {
    throw new Error('官方健身分类集成验收初始化失败', { cause });
  }
}, 30_000);

afterAll(async () => {
  try {
    failAudit = false;
    await app?.close();
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (contentIds.length) await prisma.officialFitnessContent.deleteMany({ where: { id: { in: contentIds } } });
    if (taxonIds.length) await prisma.officialFitnessTaxon.deleteMany({ where: { id: { in: taxonIds } } });
    if (adminIds.length) await prisma.adminAccount.deleteMany({ where: { id: { in: adminIds } } });
    if (groupIds.length) await prisma.adminGroup.deleteMany({ where: { id: { in: groupIds } } });
  } catch (cause) {
    throw new Error('官方健身分类验收夹具清理失败', { cause });
  } finally {
    await prisma.$disconnect();
  }
});

describe('官方部位与器械字典', () => {
  it('繁体数据迁移覆盖全部 38 个内置分类，仅在名称变化时推进分类与目录版本', async () => {
    await withTraditionalNameFixture(async (tx, apply) => {
      const before = await tx.$queryRaw<Array<{ kind: Kind; id: string; name_zh: string; version: number }>>`
        SELECT kind, id, name_zh, version FROM official_fitness_taxonomies`;
      expect(before).toHaveLength(38);
      expect(traditionalNames).toHaveLength(38);
      await apply();
      const after = await tx.$queryRaw<
        Array<{ kind: Kind; id: string; name_zh: string; name_hant: string; version: number }>
      >`
        SELECT kind, id, name_zh, name_hant, version FROM official_fitness_taxonomies`;
      for (const [kind, id, translated] of traditionalNames) {
        const original = before.find((row) => row.kind === kind && row.id === id)!;
        expect(after.find((row) => row.kind === kind && row.id === id)).toEqual({
          kind,
          id,
          name_zh: original.name_zh,
          name_hant: translated,
          version: original.version + Number(original.name_zh !== translated),
        });
      }
      expect(await tx.$queryRaw`SELECT content_version FROM official_fitness_state WHERE id = 1`).toEqual([
        { content_version: 41 },
      ]);
      await apply();
      expect(await tx.$queryRaw`SELECT content_version FROM official_fitness_state WHERE id = 1`).toEqual([
        { content_version: 41 },
      ]);
    });
  });

  it('繁体数据迁移保留管理员编辑、软删记录及自定义分类', async () => {
    await withTraditionalNameFixture(async (tx, apply) => {
      await tx.$executeRaw`UPDATE official_fitness_taxonomies SET version = 2 WHERE kind = 'equipment' AND id = 'barbell'`;
      await tx.$executeRaw`UPDATE official_fitness_taxonomies SET updated_by = 'operator' WHERE kind = 'equipment' AND id = 'dumbbell'`;
      await tx.$executeRaw`UPDATE official_fitness_taxonomies SET name_hant = '管理員自訂壺鈴' WHERE kind = 'equipment' AND id = 'kettlebell'`;
      await tx.$executeRaw`UPDATE official_fitness_taxonomies SET deleted_at = CURRENT_TIMESTAMP WHERE kind = 'equipment' AND id = 'cable'`;
      await tx.$executeRaw`UPDATE official_fitness_taxonomies SET name_zh = '用户自定义名称' WHERE kind = 'equipment' AND id = 'band'`;
      await tx.$executeRaw`UPDATE official_fitness_taxonomies SET name_en = 'Custom English name' WHERE kind = 'equipment' AND id = 'ez barbell'`;
      await tx.$executeRaw`INSERT INTO official_fitness_taxonomies (kind, id, name_zh, name_hant, name_en, updated_at)
        VALUES ('equipment', 'custom-item', '自定义器械', '自定义器械', 'custom-item', CURRENT_TIMESTAMP)`;
      const before = await tx.$queryRaw`SELECT * FROM official_fitness_taxonomies
        WHERE kind = 'equipment' AND id IN ('barbell', 'dumbbell', 'kettlebell', 'cable', 'band', 'ez barbell', 'custom-item') ORDER BY id`;
      await apply();
      expect(
        await tx.$queryRaw`SELECT * FROM official_fitness_taxonomies
        WHERE kind = 'equipment' AND id IN ('barbell', 'dumbbell', 'kettlebell', 'cable', 'band', 'ez barbell', 'custom-item') ORDER BY id`,
      ).toEqual(before);
      expect(
        await tx.$queryRaw`SELECT name_hant FROM official_fitness_taxonomies WHERE kind = 'equipment' AND id = 'weighted'`,
      ).toEqual([{ name_hant: '負重器材' }]);
    });
  });

  it('目录版本写入失败时繁体名称修正一同回滚', async () => {
    await withTraditionalNameFixture(async (tx, apply) => {
      const before = await tx.$queryRaw`SELECT * FROM official_fitness_taxonomies ORDER BY kind, id`;
      await tx.$executeRaw`ALTER TABLE official_fitness_state ADD CONSTRAINT reject_cache_advance CHECK (content_version = 40)`;
      await tx.$executeRawUnsafe('SAVEPOINT traditional_migration');
      await expect(apply()).rejects.toThrow();
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT traditional_migration');
      expect(await tx.$queryRaw`SELECT * FROM official_fitness_taxonomies ORDER BY kind, id`).toEqual(before);
      expect(await tx.$queryRaw`SELECT content_version FROM official_fitness_state WHERE id = 1`).toEqual([
        { content_version: 40 },
      ]);
    });
  });

  it('内置身份保持有效，只读权限可读取但不能修改分类', async () => {
    const unauthorized = await app.inject({ url: '/api/v1/admin/fitness/taxonomies/body_part' });
    expect(unauthorized.statusCode).toBe(401);
    for (const [kind, expected] of [
      ['body_part', 'chest'],
      ['equipment', 'body weight'],
    ] as const) {
      const list = await app.inject({ url: `/api/v1/admin/fitness/taxonomies/${kind}`, headers: headers(reader) });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json<{ items: Taxon[] }>().items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: expected, kind, is_deleted: false })]),
      );
    }
    const denied = await mutate('POST', 'equipment', '', { name: { zh: '测试', zh_hant: '測試', en: 'Test' } }, reader);
    expect(denied.statusCode).toBe(403);
  });

  it('名称可更新且身份保持不变，版本冲突不覆盖修改，公开目录与缓存同步更新', async () => {
    const taxon = await createTaxon('body_part');
    expect(taxon).toMatchObject({ version: 1, sort_order: 0, exercise_count: 0, template_count: 0 });
    expect(taxon.id).toMatch(/^[a-f0-9-]{36}$/);
    const catalogBefore = await app.inject({ url: '/api/v1/fitness/catalog' });
    const renamed = await mutate('PATCH', 'body_part', taxon.id, {
      version: 1,
      name: { zh: '重命名部位', zh_hant: '重命名部位', en: 'Renamed part' },
      sort_order: 12,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ id: taxon.id, version: 2, sort_order: 12, name: { zh: '重命名部位' } });
    const stale = await mutate('PATCH', 'body_part', taxon.id, { version: 1, sort_order: 99 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('FITNESS_TAXON_CHANGED');
    const catalog = await app.inject({
      url: '/api/v1/fitness/catalog',
      headers: { 'if-none-match': String(catalogBefore.headers.etag) },
    });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().content_version).toBeGreaterThan(catalogBefore.json().content_version);
    expect(catalog.json().taxonomies.body_parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: taxon.id,
          name: { zh: '重命名部位', zh_hant: '重命名部位', en: 'Renamed part' },
        }),
      ]),
    );
    const deleted = await mutate('DELETE', 'body_part', taxon.id, { version: 2 });
    expect(deleted.statusCode).toBe(204);
    const historical = await app.inject({ url: '/api/v1/fitness/catalog' });
    expect(historical.json().taxonomies.body_parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: taxon.id,
          name: { zh: '重命名部位', zh_hant: '重命名部位', en: 'Renamed part' },
          is_deleted: true,
        }),
      ]),
    );
  });

  it('删除使用中的器械要求替代项，并原子迁移停用动作与模板器械且去重', async () => {
    const source = await createTaxon('equipment', '待替换器械');
    const replacement = await createTaxon('equipment', '替代器械');
    const wrongKind = await createTaxon('body_part', '部位不能替换器械');
    const fixture = await createReferences(source.id, replacement.id);
    const history = await createUserHistory(source.id, fixture.exerciseId);
    const list = await app.inject({ url: '/api/v1/admin/fitness/taxonomies/equipment', headers: headers() });
    expect(list.json<{ items: Taxon[] }>().items.find((row) => row.id === source.id)).toMatchObject({
      exercise_count: 1,
      template_count: 1,
    });
    const referenced = await mutate('DELETE', 'equipment', source.id, { version: 1 });
    expect(referenced.statusCode).toBe(409);
    expect(referenced.json().code).toBe('FITNESS_TAXON_REFERENCED');
    const invalid = await mutate('DELETE', 'equipment', source.id, { version: 1, replacement_id: wrongKind.id });
    expect(invalid.statusCode).toBe(400);
    const deleted = await mutate('DELETE', 'equipment', source.id, { version: 1, replacement_id: replacement.id });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const exercise = await prisma.officialFitnessContent.findUniqueOrThrow({ where: { id: fixture.exerciseId } });
    const template = await prisma.officialFitnessContent.findUniqueOrThrow({ where: { id: fixture.templateId } });
    expect(exercise).toMatchObject({ version: 2, isEnabled: false, content: { equipment: replacement.id } });
    expect(template).toMatchObject({
      version: 2,
      isEnabled: false,
      content: { equipment: [replacement.id], revision: 6 },
    });
    const { id: _id, ...staleContent } = fixture.exercise;
    const staleSave = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fitness/exercises/${fixture.exerciseId}`,
      headers: headers(),
      payload: { version: 2, content: staleContent },
    });
    expect(staleSave.statusCode, staleSave.body).toBe(409);
    expect(staleSave.json().code).toBe('FITNESS_TAXON_UNAVAILABLE');
    const { id: _templateId, revision: _revision, ...staleTemplate } = fixture.template;
    const staleTemplateSave = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/fitness/templates/${fixture.templateId}`,
      headers: headers(),
      payload: { version: 2, content: staleTemplate },
    });
    expect(staleTemplateSave.statusCode).toBe(409);
    expect(staleTemplateSave.json().code).toBe('FITNESS_TAXON_UNAVAILABLE');
    for (const saved of history) {
      expect(await prisma.fitnessEntity.findUnique({ where: { id: saved.id } })).toEqual(saved);
    }
  });

  it('审计失败时分类、引用正文与全局版本整体回滚', async () => {
    const source = await createTaxon('equipment');
    const replacement = await createTaxon('equipment');
    const fixture = await createReferences(source.id, replacement.id);
    const state = await prisma.officialFitnessState.findUniqueOrThrow({ where: { id: 1 } });
    const beforeAudits = await prisma.auditLog.count({ where: { target: { path: ['id'], equals: source.id } } });
    failAudit = true;
    try {
      const response = await mutate('DELETE', 'equipment', source.id, { version: 1, replacement_id: replacement.id });
      expect(response.statusCode, response.body).toBe(500);
    } finally {
      failAudit = false;
    }
    expect(
      await prisma.officialFitnessTaxon.findUnique({ where: { kind_id: { kind: 'equipment', id: source.id } } }),
    ).toMatchObject({ version: 1, deletedAt: null });
    expect(await prisma.officialFitnessContent.findUnique({ where: { id: fixture.exerciseId } })).toMatchObject({
      version: 1,
      content: fixture.exercise,
    });
    expect(await prisma.officialFitnessContent.findUnique({ where: { id: fixture.templateId } })).toMatchObject({
      version: 1,
      content: fixture.template,
    });
    expect(await prisma.officialFitnessState.findUnique({ where: { id: 1 } })).toEqual(state);
    expect(await prisma.auditLog.count({ where: { target: { path: ['id'], equals: source.id } } })).toBe(beforeAudits);
  });

  it('并发修改相同版本只提交一次，空白名称和未知字段不能写入', async () => {
    const taxon = await createTaxon('equipment');
    const results = await Promise.all([
      mutate('PATCH', 'equipment', taxon.id, { version: 1, sort_order: 1 }),
      mutate('PATCH', 'equipment', taxon.id, { version: 1, sort_order: 2 }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const blank = await mutate('PATCH', 'equipment', taxon.id, {
      version: 2,
      name: { zh: ' ', zh_hant: '测试', en: 'Test' },
    });
    expect(blank.statusCode).toBe(400);
    const invalid = await mutate('PATCH', 'equipment', taxon.id, { version: 2, id: randomUUID(), sort_order: 3 });
    // 框架按封闭 schema 丢弃额外字段，客户端提交的身份不能改变已保存分类。
    expect(invalid.statusCode).toBe(200);
    expect(
      await prisma.officialFitnessTaxon.findUnique({ where: { kind_id: { kind: 'equipment', id: taxon.id } } }),
    ).toMatchObject({ id: taxon.id, version: 3 });
  });
});
