import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { ApiError } from '../src/shared/errors.js';
import { assertGuardedTestDatabase, testFixtureDatabaseUrl } from './existing-test-database.js';

const DATABASE_URL = testFixtureDatabaseUrl();
const RUN = randomUUID();
const ORIGIN = 'https://admin.example.test';
const PASSWORD = 'creation-test-only-password';
const mediaId = createHash('sha256').update(RUN).digest('hex');
const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
const adminIds = new Set<string>();
const groupIds = new Set<string>();
const contentIds = new Set<string>();
const bannerIds = new Set<string>();
const taxonomies: Array<{ kind: string; id: string }> = [];
const apps: Array<ReturnType<typeof buildApp>> = [];
let failNextReceipt = false;

// 只在回执写入点注入一次失败，实体和审计仍由真实数据库事务执行。
const injected = prisma.$extends({
  query: {
    adminCreationReceipt: {
      async create({ args, query }) {
        if (failNextReceipt) {
          failNextReceipt = false;
          throw new Error('幂等回执故障注入');
        }
        return await query(args);
      },
    },
  },
});

const config: ApiConfig = {
  databaseUrl: DATABASE_URL,
  jwtSecret: 'admin-creation-test-at-least-32-byte-secret',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 2_592_000,
  storagePath: resolve(import.meta.dirname, '../../../Temp', `admin-creation-${RUN}`),
  exchangeRateUpstream: 'https://api.frankfurter.dev',
  exchangeRateCacheTtlSeconds: 43_200,
  githubReleaseToken: '',
  port: 8080,
  host: '127.0.0.1',
  corsOrigins: [],
  adminOrigins: [ORIGIN],
  rateLimitMax: 10_000,
  authRateLimitMax: 10_000,
  trustProxyCidrs: [],
  syncRetentionMinCursor: 0,
};

type Actor = { id: string; cookie: string; sessionId: string; groupId: string };
type Kind = 'exercise' | 'template' | 'plan';
type CreationCase = {
  label: string;
  path: string;
  action: string;
  entity: 'fitness' | 'banner' | 'taxonomy' | 'account' | 'group';
  kind?: Kind | 'body_part' | 'equipment';
  body: () => Record<string, unknown>;
};

let app: ReturnType<typeof buildApp>;
let actor: Actor;
const baseContent: Partial<Record<Kind, Record<string, unknown>>> = {};

/** 失败时附加业务验收目标，保留底层数据库或断言诊断。 */
async function verify<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new Error(message, { cause });
  }
}

/** 每个测试生成唯一显示名与登录名，清理范围以服务端返回的明确身份记录。 */
function uniqueName(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** 从当前种子内容派生合法的新增载荷，不覆盖种子身份或修订。 */
function fitnessBody(kind: Kind): Record<string, unknown> {
  try {
    const content = structuredClone(baseContent[kind]);
    if (!content) throw new Error(`隔离库缺少 ${kind} 种子内容`);
    delete content.id;
    delete content.revision;
    if (kind === 'exercise') content.name_zh = uniqueName('幂等动作');
    else content.name = { zh: uniqueName('幂等内容'), zh_hant: '測試內容', en: 'Creation test' };
    return { content, is_enabled: false };
  } catch (cause) {
    throw new Error('构造官方内容幂等载荷失败', { cause });
  }
}

/** 两个分类类型使用相同请求结构，以单独验证路径参数参与请求身份。 */
function taxonomyBody(): Record<string, unknown> {
  return {
    name: { zh: uniqueName('幂等分类'), zh_hant: '測試分類', en: 'Creation taxonomy' },
    sort_order: 0,
    reason: '验证新增请求恢复',
  };
}

const creationCases: CreationCase[] = [
  ...(['exercise', 'template', 'plan'] as const).map((kind) => ({
    label: kind,
    path: `/api/v1/admin/fitness/${kind === 'exercise' ? 'exercises' : kind === 'template' ? 'templates' : 'plans'}`,
    action: `fitness.${kind}.create`,
    entity: 'fitness' as const,
    kind,
    body: () => fitnessBody(kind),
  })),
  {
    label: 'Banner',
    path: '/api/v1/admin/banners',
    action: 'banner.create',
    entity: 'banner',
    body: () => ({
      slot: 'fitness-plan-library',
      image_id: mediaId,
      target: 'fitness-exercises',
      target_id: null,
      sort_order: 0,
    }),
  },
  ...(['body_part', 'equipment'] as const).map((kind) => ({
    label: kind,
    path: `/api/v1/admin/fitness/taxonomies/${kind}`,
    action: 'fitness.taxonomy.create',
    entity: 'taxonomy' as const,
    kind,
    body: taxonomyBody,
  })),
  {
    label: '后台用户',
    path: '/api/v1/admin/accounts',
    action: 'admin.account.create',
    entity: 'account',
    body: () => ({ username: uniqueName('create'), password: PASSWORD, display_name: '幂等测试账号' }),
  },
  {
    label: '用户组',
    path: '/api/v1/admin/groups',
    action: 'admin.group.create',
    entity: 'group',
    body: () => ({ name: uniqueName('幂等用户组') }),
  },
];

/** 直接创建独立会话夹具，HTTP请求仍经过真实Cookie认证、权限复核和数据库锁。 */
async function createActor(restricted = false): Promise<Actor> {
  return await verify('创建管理员幂等验收身份失败', async () => {
    const group = await prisma.adminGroup.create({
      data: {
        name: uniqueName('幂等身份组'),
        permissions: ['fitness:read', 'fitness:write'],
        pageIds: ['fitness_exercises'],
      },
    });
    groupIds.add(group.id);
    const account = await prisma.adminAccount.create({
      data: {
        username: uniqueName('idem'),
        displayName: '幂等验收身份',
        passwordHash: 'unused-test-session-fixture',
        identityType: restricted ? 'standard_user' : 'super_admin',
        groupId: group.id,
      },
    });
    adminIds.add(account.id);
    const token = randomBytes(48).toString('base64url');
    const session = await prisma.adminSession.create({
      data: {
        adminId: account.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    return {
      id: account.id,
      cookie: `__Secure-sesame_admin_session=${token}`,
      sessionId: session.id,
      groupId: group.id,
    };
  });
}

/** 请求不会自动重试，测试按真实客户端语义决定何时重新发送相同意图。 */
async function post(path: string, body: Record<string, unknown>, key?: string, identity = actor, target = app) {
  return await target.inject({
    method: 'POST',
    url: path,
    headers: {
      cookie: identity.cookie,
      origin: ORIGIN,
      'x-admin-request': '1',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    payload: body,
  });
}

/** 登记真实响应身份，使测试只清理自己创建的实体。 */
function remember(test: CreationCase, value: Record<string, unknown>): string {
  const id = value.id;
  if (typeof id !== 'string') throw new Error(`${test.label} 响应缺少实体标识`);
  if (test.entity === 'fitness') contentIds.add(id);
  else if (test.entity === 'banner') bannerIds.add(id);
  else if (test.entity === 'taxonomy') taxonomies.push({ kind: test.kind!, id });
  else if (test.entity === 'account') adminIds.add(id);
  else groupIds.add(id);
  return id;
}

/** 按实际数据表确认重试只有一个实体，不以相同响应代替数据库检查。 */
async function countEntity(test: CreationCase, id: string): Promise<number> {
  if (test.entity === 'fitness') return await prisma.officialFitnessContent.count({ where: { id } });
  if (test.entity === 'banner') return await prisma.appBanner.count({ where: { id } });
  if (test.entity === 'taxonomy') return await prisma.officialFitnessTaxon.count({ where: { kind: test.kind, id } });
  if (test.entity === 'account') return await prisma.adminAccount.count({ where: { id } });
  return await prisma.adminGroup.count({ where: { id } });
}

/** 查询同一写入对象的追加审计，重放不能再产生成功审计。 */
async function countAudit(identity: Actor, action: string, id?: string): Promise<number> {
  return await prisma.auditLog.count({
    where: {
      actor: `admin:${identity.id}`,
      action,
      ...(id === undefined ? {} : { target: { path: ['id'], equals: id } }),
    },
  });
}

/** 在真实认证事务提交后插入数据库撤权，验证写事务重新检查权限后才读取回执。 */
function authenticationRace(revoke: () => Promise<void>) {
  let intervened = false;
  let transactions = 0;

  /** 保持真实连接与锁，只在认证事务结束和业务事务开始之间安排变更。 */
  async function transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: Parameters<PrismaClient['$transaction']>[1],
  ): Promise<T> {
    try {
      transactions += 1;
      const result = await prisma.$transaction(operation, options);
      if (!intervened) {
        intervened = true;
        await revoke();
      }
      return result;
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      throw new Error('安排管理员认证与写入之间的状态变更失败', { cause });
    }
  }

  const client = new Proxy(prisma, {
    /** 只代理事务调度，模型查询、认证逻辑及回执读写由真实客户端执行。 */
    get(target, property) {
      if (property === '$transaction') return transaction;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { client, observed: () => intervened && transactions === 2 };
}

beforeAll(async () => {
  await verify('管理员新增幂等集成环境准备失败', async () => {
    await assertGuardedTestDatabase(prisma, DATABASE_URL, process.env);
    for (const kind of ['exercise', 'template', 'plan'] as const) {
      const row = await prisma.officialFitnessContent.findFirst({ where: { kind }, orderBy: { id: 'asc' } });
      if (!row || !row.content || typeof row.content !== 'object' || Array.isArray(row.content))
        throw new Error(`当前建库基线缺少 ${kind} 官方内容`);
      baseContent[kind] = row.content;
    }
    await prisma.appBannerMedia.create({
      data: { id: mediaId, fileName: 'idempotency.png', byteSize: 1, width: 1, height: 1 },
    });
    actor = await createActor();
    app = buildApp({ logger: false, config, prisma: injected as unknown as PrismaClient });
    apps.push(app);
    await app.ready();
  });
}, 30_000);

afterAll(async () => {
  try {
    failNextReceipt = false;
    await Promise.all(apps.map((current) => current.close()));
    // 审计由数据库保护并保留；其余只清理本文件登记的明确身份。
    await prisma.appBanner.deleteMany({ where: { id: { in: [...bannerIds] } } });
    await prisma.appBannerMedia.deleteMany({ where: { id: mediaId } });
    await prisma.officialFitnessContent.deleteMany({ where: { id: { in: [...contentIds] } } });
    for (const taxon of taxonomies)
      await prisma.officialFitnessTaxon.deleteMany({ where: { kind: taxon.kind, id: taxon.id } });
    await prisma.adminAccount.deleteMany({ where: { id: { in: [...adminIds] } } });
    await prisma.adminGroup.deleteMany({ where: { id: { in: [...groupIds] } } });
  } catch (cause) {
    throw new Error('管理员新增幂等夹具清理失败，请保留隔离库诊断', { cause });
  } finally {
    await prisma.$disconnect();
  }
}, 30_000);

describe('PostgreSQL 管理员新增幂等与授权边界', () => {
  it.each(creationCases)(
    '$label 提交后忽略首次响应再重试只生成一个实体和一次审计',
    async (test) => {
      await verify(`${test.label} 未知结果恢复失败`, async () => {
        const key = randomUUID();
        const body = test.body();
        const first = await post(test.path, body, key);
        expect(first.statusCode, first.body).toBe(201);
        // 不从首次响应恢复本地结果，按相同键和冻结载荷重新请求服务端。
        const repeated = await post(test.path, structuredClone(body), key);
        expect(repeated.statusCode, repeated.body).toBe(201);
        const value = repeated.json<Record<string, unknown>>();
        const id = remember(test, value);
        expect(value).toEqual(first.json());
        expect(await countEntity(test, id)).toBe(1);
        expect(await countAudit(actor, test.action, id)).toBe(1);
        const receipt = await prisma.adminCreationReceipt.findUniqueOrThrow({
          where: { adminId_key: { adminId: actor.id, key } },
        });
        expect(receipt.response).toEqual(value);
        expect(JSON.stringify(receipt.response)).not.toMatch(/password|token_?hash/i);
        expect(JSON.stringify(receipt.response)).not.toContain(PASSWORD);
      });
    },
    30_000,
  );

  it('同一新增意图并发提交仍收敛为一个实体和一次成功审计', async () => {
    await verify('同键并发新增未收敛', async () => {
      const test = creationCases[4]!;
      const body = test.body();
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 3 }, async () => await post(test.path, body, key)));
      for (const response of responses) expect(response.statusCode, response.body).toBe(201);
      const id = remember(test, responses[0]!.json());
      for (const response of responses) expect(response.json().id).toBe(id);
      expect(await countEntity(test, id)).toBe(1);
      expect(await countAudit(actor, test.action, id)).toBe(1);
    });
  }, 30_000);

  it('相同键的载荷、路由或路径参数变化均明确冲突', async () => {
    await verify('新增标识复用没有阻止不同意图', async () => {
      const test = creationCases[4]!;
      const body = test.body();
      const key = randomUUID();
      const first = await post(test.path, body, key);
      expect(first.statusCode, first.body).toBe(201);
      const id = remember(test, first.json());
      const attempts = [
        await post(test.path, { ...body, reason: '不同操作内容' }, key),
        await post('/api/v1/admin/fitness/taxonomies/equipment', body, key),
        await post('/api/v1/admin/groups', { name: uniqueName('不同路由') }, key),
      ];
      for (const response of attempts) {
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().code).toBe('ADMIN_CREATION_KEY_REUSED');
      }
      expect(await countAudit(actor, test.action, id)).toBe(1);
    });
  }, 30_000);

  it('不同管理员使用相同键保持独立意图作用域', async () => {
    await verify('不同管理员的新增意图相互干扰', async () => {
      const test = creationCases[5]!;
      const other = await createActor();
      const body = test.body();
      const key = randomUUID();
      const first = await post(test.path, body, key);
      const second = await post(test.path, body, key, other);
      expect(first.statusCode, first.body).toBe(201);
      expect(second.statusCode, second.body).toBe(201);
      const firstId = remember(test, first.json());
      const secondId = remember(test, second.json());
      expect(secondId).not.toBe(firstId);
      expect(await prisma.adminCreationReceipt.count({ where: { key } })).toBe(2);
      expect(await countAudit(actor, test.action, firstId)).toBe(1);
      expect(await countAudit(other, test.action, secondId)).toBe(1);
    });
  }, 30_000);

  it.each(['permission', 'session'] as const)(
    'HTTP鉴权后%s失效不能通过已有回执绕过写前复核',
    async (mode) => {
      await verify('幂等回执绕过当前身份或授权', async () => {
        const identity = await createActor(true);
        const test = creationCases[4]!;
        const body = test.body();
        const key = randomUUID();
        const first = await post(test.path, body, key, identity);
        expect(first.statusCode, first.body).toBe(201);
        const id = remember(test, first.json());
        const race = authenticationRace(async () => {
          if (mode === 'permission')
            await prisma.adminGroup.update({
              where: { id: identity.groupId },
              data: { permissions: ['fitness:read'] },
            });
          else await prisma.adminSession.update({ where: { id: identity.sessionId }, data: { revokedAt: new Date() } });
        });
        const racingApp = buildApp({ logger: false, config, prisma: race.client });
        apps.push(racingApp);
        await racingApp.ready();
        const repeated = await post(test.path, body, key, identity, racingApp);
        expect(repeated.statusCode, repeated.body).toBe(mode === 'permission' ? 403 : 401);
        expect(race.observed()).toBe(true);
        expect(await countAudit(identity, test.action, id)).toBe(1);
        expect(await prisma.adminCreationReceipt.count({ where: { adminId: identity.id, key } })).toBe(1);
      });
    },
    30_000,
  );

  it('回执提交失败会回滚实体和审计，同键可重新完成首次新增', async () => {
    await verify('回执失败没有与业务写入原子回滚', async () => {
      const test = creationCases[7]!;
      const body = test.body();
      const key = randomUUID();
      const audits = await countAudit(actor, test.action);
      try {
        failNextReceipt = true;
        const failed = await post(test.path, body, key);
        expect(failed.statusCode, failed.body).toBe(503);
        expect(failed.json().code).toBe('ADMIN_AUTH_UNAVAILABLE');
        expect(failNextReceipt).toBe(false);
        expect(
          await prisma.adminCreationReceipt.findUnique({ where: { adminId_key: { adminId: actor.id, key } } }),
        ).toBeNull();
        expect(await prisma.adminGroup.count({ where: { name: body.name as string } })).toBe(0);
        expect(await countAudit(actor, test.action)).toBe(audits);
      } finally {
        failNextReceipt = false;
      }
      const retried = await post(test.path, body, key);
      expect(retried.statusCode, retried.body).toBe(201);
      const id = remember(test, retried.json());
      expect(await countEntity(test, id)).toBe(1);
      expect(await countAudit(actor, test.action, id)).toBe(1);
    });
  }, 30_000);
});
