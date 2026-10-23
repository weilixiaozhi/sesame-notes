import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ensureOwnerMember } from '../src/modules/accounting/index.js';
import { hashPassword } from '../src/modules/auth/index.js';
import { categoryState } from '../src/shared/category-version.js';
import { guardedTestDatabaseUrl, testFixtureDatabaseUrl } from './existing-test-database.js';
import { createOwnedFixture, linkOwnedFixtureDependencies, removeOwnedFixture } from './owned-fixture-directory.js';
import { testStoragePath } from './test-storage-path.js';

const runFile = promisify(execFile);
const apiDirectory = resolve(import.meta.dirname, '..');
const migrationName = '20261015000000_complete_default_category_catalog';
const previousMigration = '20261014000000_analytics_page_event_names';
const catalog = JSON.parse(
  readFileSync(new URL('../src/modules/accounting/default-category-catalog.json', import.meta.url), 'utf8'),
) as {
  items: Array<{
    id: string;
    key: string;
    name: string;
    kind: 'expense';
    level: 1 | 2;
    sort_order: number;
    icon: string | null;
    parent_id: string | null;
  }>;
};
const maintenanceDevice = '00000000-0000-4000-8000-000000000061';
const controllerUrl = testFixtureDatabaseUrl();
const databaseName = `sesame_test_category_repair_${randomUUID().replaceAll('-', '')}`;
const target = new URL(controllerUrl);
target.pathname = `/${databaseName}`;
// 隔离库使用默认连接配置，连接身份只包含本机端点与本轮唯一库名。
target.search = '';
const databaseUrl = guardedTestDatabaseUrl(target.toString(), {
  SESAME_ENV: 'test',
  NODE_ENV: 'test',
  DATABASE_URL: target.toString(),
});
const controller = new PrismaClient({ datasourceUrl: controllerUrl });
const database = new PrismaClient({ datasourceUrl: databaseUrl });
let project: string | undefined;
let created = false;
let app: ReturnType<typeof buildApp> | undefined;
type Account = { id: string; phone: string; password: string; deviceId: string };
type Session = { access_token: string; device_id: string; user: { user_id: string } };
type CatalogItem = (typeof catalog.items)[number];

/** 通过真实部署入口应用迁移，临时连接仅指向本次随机数据库。 */
async function migrate(setup: string) {
  try {
    await runFile(process.execPath, [setup], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        SESAME_ENV: 'test',
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        E2E_DATABASE_URL: databaseUrl,
      },
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error('默认分类修复部署迁移失败', { cause });
  }
}

/** 结构部署已自动完成协议升级；读取持久切点及审计验证无需额外运维步骤。 */
async function expectAutomaticProtocolUpgrade(): Promise<string> {
  try {
    const cursor = (await database.syncChange.aggregate({ _max: { changeId: true } }))._max.changeId ?? 0n;
    const epoch = await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
    expect(epoch.syncCutoverCursor).toBe(cursor);
    expect(epoch.syncCutoverAt).toBeInstanceOf(Date);
    const audits = await database.auditLog.findMany({ where: { action: 'sync.protocol_cutover' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      mode: 'automatic_upgrade',
      source: 'db-init',
      original_cursor: cursor.toString(),
      result_cursor: cursor.toString(),
    });
    return cursor.toString();
  } catch (cause) {
    throw new Error('默认分类升级夹具的自动协议迁移验证失败', { cause });
  }
}

/** 复制升级前真实历史并创建本轮唯一库，不复用开发或业务数据库。 */
beforeAll(async () => {
  try {
    project = await createOwnedFixture('default-category-upgrade');
    const source = join(apiDirectory, 'prisma');
    await cp(source, join(project, 'prisma'), {
      recursive: true,
      filter: (path) =>
        dirname(path) !== join(source, 'migrations') ||
        !/^\d{14}_/.test(basename(path)) ||
        basename(path) <= previousMigration,
    });
    await linkOwnedFixtureDependencies(project);
    if (databaseName.length > 63) throw new Error('迁移测试数据库名称超过 PostgreSQL 标识符长度限制');
    await controller.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const [identity] = await database.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (identity?.name !== databaseName) throw new Error('迁移测试数据库实际名称与本次隔离身份不一致');
    await database.$disconnect();
    await migrate(join(project, 'prisma/setup.mjs'));
  } catch (cause) {
    throw new Error('默认分类修复旧版本数据库准备失败', { cause });
  }
}, 120_000);

/** 只清理本次创建的隔离库和经过所有权验证的 Temp 工程。 */
afterAll(async () => {
  try {
    if (app) await app.close();
    await database.$disconnect();
    if (created) await controller.$executeRawUnsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    if (project) await removeOwnedFixture(project);
  } catch (cause) {
    throw new Error('默认分类修复测试资源清理失败', { cause });
  } finally {
    await controller.$disconnect();
  }
}, 120_000);

/** 旧账号由物理数据构造，注册流程不会参与迁移前夹具。 */
async function legacyAccount(): Promise<Account> {
  try {
    const phone = `138${randomInt(100000000).toString().padStart(8, '0')}`;
    const password = 'legacy-category-repair-password';
    const user = await database.user.create({
      data: {
        phoneE164: `+86${phone}`,
        sesameNumber: randomInt(100000000, 1000000000).toString(),
        passwordHash: await hashPassword(password),
        devices: { create: { installationId: randomUUID(), name: '旧设备', platform: 'test' } },
      },
      include: { devices: true },
    });
    return { id: user.id, phone, password, deviceId: user.devices[0]!.id };
  } catch (cause) {
    throw new Error('旧账号与设备夹具创建失败', { cause });
  }
}

/** 读取官方身份；字段来自目录，保护场景的覆盖值由用例显式指定。 */
function item(key: string): CatalogItem {
  const found = catalog.items.find((row) => row.key === key);
  if (!found) throw new Error(`分类测试目录缺少身份：${key}`);
  return found;
}

/** 插入历史分类，保留用户已修改的时间与设备来源。 */
async function seed(
  account: Account,
  definition: CatalogItem,
  changes: Partial<Prisma.CategoryUncheckedCreateInput> = {},
) {
  try {
    return await database.category.create({
      data: {
        id: definition.id,
        ownerId: account.id,
        name: definition.name,
        kind: definition.kind,
        level: definition.level,
        sortOrder: definition.sort_order,
        parentId: definition.parent_id,
        icon: definition.icon,
        updatedAt: new Date(0),
        updatedByDeviceId: account.deviceId,
        ...changes,
      },
    });
  } catch (cause) {
    throw new Error('旧分类夹具创建失败', { cause });
  }
}

/** 全量快照包含墓碑，避免仅比较可见条目掩盖用户内容被改写。 */
function rows(account: Account) {
  return database.category.findMany({ where: { ownerId: account.id }, orderBy: { id: 'asc' } });
}

/** 逐条比较迁移事件与生产分类状态，校验 SQL 冻结指纹的每个字段。 */
async function expectRepairEvents(account: Account, count: number) {
  const categories = new Map((await rows(account)).map((row) => [row.id, row]));
  const events = await database.syncChange.findMany({
    where: { userId: account.id, entityType: 'category', deviceId: maintenanceDevice },
    orderBy: { changeId: 'asc' },
  });
  expect(events).toHaveLength(count);
  const beforeChild = new Set<string>();
  for (const event of events) {
    const row = categories.get(event.entityId)!;
    expect(row).toBeDefined();
    expect(row.updatedByDeviceId).toBeNull();
    expect(row.updatedAt).toEqual(new Date(0));
    expect(event).toMatchObject({ scope: 'user', ledgerId: null, action: 'upsert' });
    expect(event.payload).toEqual(categoryState(row));
    if (row.parentId && events.some((parent) => parent.entityId === row.parentId))
      expect(beforeChild.has(row.parentId)).toBe(true);
    beforeChild.add(row.id);
  }
  return events;
}

/** 两次登录取得独立设备会话，验证历史账号登录不会重新执行修复。 */
async function login(account: Account): Promise<Session> {
  const response = await app!.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      country_code: '+86',
      phone: account.phone,
      password: account.password,
      device: { installation_id: randomUUID(), name: '迁移后另一设备', platform: 'test' },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Session>();
}

/** 通过正式认证调用读取或命令接口，不直接修改同步投影。 */
function call(session: Session, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, key?: string) {
  return app!.inject({
    method,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${session.access_token}`, ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload ? { payload } : {}),
  });
}

it('真实部署补齐旧目录并保留用户事实，完成切点后可跨设备完整恢复', async () => {
  try {
    const partial = await legacyAccount();
    const empty = await legacyAccount();
    const protectedAccount = await legacyAccount();
    // 20 个父分类加 9 个子分类构成完整可引用的 29 项旧快照。
    const legacyItems = [
      ...catalog.items.filter((row) => row.level === 1),
      ...catalog.items.filter((row) => row.level === 2).slice(0, 9),
    ];
    for (const definition of legacyItems) await seed(partial, definition);
    const trip = await database.category.create({
      data: { ownerId: partial.id, name: '旅行', kind: 'expense', icon: 'plane', sortOrder: 81 },
    });
    const legacyRows = await rows(partial);
    expect(legacyRows).toHaveLength(30);
    const ledger = await database.$transaction(async (tx) => {
      const value = await tx.ledger.create({
        data: { ownerId: partial.id, syncId: randomUUID(), name: '迁移前账本', currency: 'CNY' },
      });
      await ensureOwnerMember(tx, value.id, partial.id, {
        createdAt: new Date(),
        updatedAt: new Date(),
        updatedByDeviceId: partial.deviceId,
      });
      return value;
    });
    const transaction = await database.transaction.create({
      data: {
        ownerId: partial.id,
        ledgerId: ledger.id,
        txType: 'expense',
        amount: '128.1234567891',
        nativeAmount: '128.1234567891',
        currencyCode: 'CNY',
        happenedAt: new Date('2026-09-05T12:13:14.567Z'),
        categoryId: item('housing').id,
        categoryName: '住房',
        categoryKind: 'expense',
        note: '旧账单正文保持原样',
        editHistory: {
          create: { version: 1, changes: { note: ['原备注', '旧账单正文保持原样'] } },
        },
      },
      include: { splits: true, editHistory: true },
    });

    const renamed = await seed(protectedAccount, item('dining'), {
      name: '用户三餐',
      icon: 'wallet',
      sortOrder: 73,
      updatedAt: new Date('2026-08-02T03:04:05.678Z'),
    });
    await seed(protectedAccount, item('beverage'), { deletedAt: new Date('2026-08-03T00:00:00Z') });
    await seed(protectedAccount, item('housing'), { level: 2, parentId: renamed.id });
    const pets = await seed(protectedAccount, item('pets'));
    await database.categoryConflict.create({
      data: {
        ownerId: protectedAccount.id,
        categoryId: pets.id,
        templateKey: 'pets',
        sourceDeviceId: protectedAccount.deviceId,
        sourceMutationId: randomUUID(),
        requestHash: 'a'.repeat(64),
        action: 'delete',
        localPayload: {},
        localUpdatedAt: new Date(),
      },
    });
    await database.category.createMany({
      data: [
        { ownerId: protectedAccount.id, name: '\u3000购物\u00A0', kind: 'expense', icon: 'wallet' },
        { ownerId: protectedAccount.id, name: '交通', kind: 'expense', deletedAt: new Date('2026-08-04T00:00:00Z') },
      ],
    });
    const removed = item('subscription');
    await database.syncChange.create({
      data: {
        userId: protectedAccount.id,
        scope: 'user',
        entityType: 'category',
        entityId: removed.id,
        action: 'delete',
        mutationId: randomUUID(),
        deviceId: protectedAccount.deviceId,
        payload: { id: removed.id },
        updatedAt: new Date('2026-08-05T00:00:00Z'),
      },
    });
    const protectedBefore = await rows(protectedAccount);
    const cursorBefore = (await database.syncChange.aggregate({ _max: { changeId: true } }))._max.changeId ?? 0n;

    // 实际部署只应用尚未完成的迁移，不能绕过 Prisma 记录直接调用补种逻辑。
    await database.$disconnect();
    await migrate(join(apiDirectory, 'prisma/setup.mjs'));
    const repaired = await rows(partial);
    expect(repaired).toHaveLength(62);
    expect(
      repaired
        .filter((row) => row.id !== trip.id)
        .map((row) => row.id)
        .sort(),
    ).toEqual(catalog.items.map((row) => row.id).sort());
    expect(repaired.filter((row) => legacyRows.some((old) => old.id === row.id))).toEqual(legacyRows);
    expect(
      await database.transaction.findUniqueOrThrow({
        where: { id: transaction.id },
        include: { splits: true, editHistory: true },
      }),
    ).toEqual(transaction);
    await expectRepairEvents(partial, 32);
    expect(await rows(empty)).toHaveLength(61);
    await expectRepairEvents(empty, 61);

    const protectedAfter = await rows(protectedAccount);
    expect(protectedAfter.filter((row) => protectedBefore.some((old) => old.id === row.id))).toEqual(protectedBefore);
    for (const key of ['shopping', 'transport', 'subscription'])
      expect(protectedAfter.some((row) => row.id === item(key).id)).toBe(false);
    const blockedParents = new Set(
      ['beverage', 'housing', 'pets', 'shopping', 'transport', 'subscription'].map((key) => item(key).id),
    );
    expect(protectedAfter.filter((row) => row.parentId && blockedParents.has(row.parentId))).toEqual([]);
    expect(protectedAfter.some((row) => row.id === item('dining_breakfast').id && row.parentId === renamed.id)).toBe(
      true,
    );
    await expectRepairEvents(protectedAccount, protectedAfter.length - protectedBefore.length);
    expect(await database.categoryConflict.count({ where: { ownerId: protectedAccount.id, status: 'pending' } })).toBe(
      1,
    );

    const cutoverCursor = await expectAutomaticProtocolUpgrade();

    app = buildApp({
      logger: false,
      prisma: database,
      config: {
        ...loadConfig({
          DATABASE_URL: databaseUrl,
          JWT_SECRET: 'legacy-category-repair-test-secret-long-enough',
          STORAGE_PATH: testStoragePath('legacy-default-category-repair'),
        }),
        authRateLimitMax: 1000,
        rateLimitMax: 1000,
      },
    });
    await app.ready();
    const first = await login(partial);
    const second = await login(partial);
    expect(first.device_id).not.toBe(second.device_id);
    for (const session of [first, second]) {
      const pulled = await call(session, 'GET', `/sync/pull?since=${cursorBefore}&limit=1000`);
      expect(pulled.statusCode, pulled.body).toBe(410);
      expect(pulled.json().code).toBe('SYNC_CURSOR_EXPIRED');
      const current = await call(session, 'GET', `/sync/pull?since=${cutoverCursor}&limit=1000`);
      expect(current.statusCode, current.body).toBe(200);
      expect(current.json().changes).toEqual([]);
      const full = await call(session, 'GET', `/sync/full?ledger_id=${ledger.id}`);
      expect(full.statusCode, full.body).toBe(200);
      expect(full.json<{ categories: unknown[] }>().categories).toHaveLength(62);
    }

    // 部署后用户删除一个新增分类，再次部署和普通同步不能把它恢复。
    const toDelete = repaired.find((row) => row.id === item('housing_rent').id)!;
    const deletion = await call(
      first,
      'DELETE',
      `/ledgers/${ledger.id}/categories/${toDelete.id}?expected_version_token=${categoryState(toDelete).version_token}`,
      undefined,
      randomUUID(),
    );
    expect(deletion.statusCode, deletion.body).toBe(204);
    const afterDeletion = await rows(partial);
    const afterEvents = await database.syncChange.findMany({
      where: { userId: partial.id },
      orderBy: { changeId: 'asc' },
    });
    await migrate(join(apiDirectory, 'prisma/setup.mjs'));
    const sync = await call(second, 'GET', `/sync/pull?since=${cutoverCursor}&limit=1000`);
    expect(sync.statusCode, sync.body).toBe(200);
    expect(await rows(partial)).toEqual(afterDeletion);
    expect(await database.syncChange.findMany({ where: { userId: partial.id }, orderBy: { changeId: 'asc' } })).toEqual(
      afterEvents,
    );
    expect(
      await database.transaction.findUniqueOrThrow({
        where: { id: transaction.id },
        include: { splits: true, editHistory: true },
      }),
    ).toEqual(transaction);
    const applied = await database.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM _prisma_migrations WHERE migration_name=${migrationName} AND finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(applied[0]!.count).toBe(1n);
  } catch (cause) {
    throw new Error('默认分类一次性迁移、保护规则或跨设备读取回归失败', { cause });
  }
}, 120_000);
