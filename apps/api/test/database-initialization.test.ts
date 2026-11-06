import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { BASELINE_MIGRATION, CURRENT_HISTORY } from '../prisma/current-baseline.mjs';
import {
  assertLifecycleSuite,
  createLifecycleDatabase,
  lifecycleDatabaseSpec,
  haltLifecycleRun,
} from './lifecycle-test-database.js';
import { runLifecycleSetup } from './lifecycle-setup.js';
import { fitnessPreferences } from './fitness-fixtures.js';
import { recurringOccurrenceId, registeredMemberId } from '../src/modules/accounting/index.js';
import { createOwnedFixture, linkOwnedFixtureDependencies, removeOwnedFixture } from './owned-fixture-directory.js';
const apiDirectory = join(import.meta.dirname, '..');
assertLifecycleSuite('database-initialization.test.ts', process.env);

const PROBE_MIGRATION = '20990101000000_current_probe';
const BROKEN_MIGRATION = '20990102000000_broken_probe';
const CLEANUP_MIGRATION = '20261103000000_remove_unused_storage_columns';
const DOMAIN_CLEANUP_MIGRATION = '20261104000000_remove_unused_domain_columns';
const cleanupColumns: Record<string, string[]> = {
  ledger_invites: ['created_at'],
  ledger_members: ['created_at'],
  categories: ['created_at'],
  recurring_transactions: ['created_at'],
  transactions: ['updated_by_device_id'],
  day_events: ['updated_by_device_id'],
};

/** 读取正式迁移目录，验证新库只执行当前基线与后续显式增量。 */
function expectedAppliedMigrations() {
  try {
    return readdirSync(join(apiDirectory, 'prisma/migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .map((migration_name) => ({ migration_name, applied: true }));
  } catch (cause) {
    throw new Error('当前迁移清单读取失败', { cause });
  }
}

/** 释放夹具连接后执行正式部署入口，维护事务独占当前租约库。 */
async function initialize(
  url: string,
  database: PrismaClient,
  setup = join(apiDirectory, 'prisma/setup.mjs'),
): Promise<void> {
  try {
    await database.$disconnect();
    await runLifecycleSetup(url, setup, apiDirectory);
  } catch (cause) {
    throw new Error('当前数据库初始化失败，请查看完整部署输出', { cause });
  }
}

/** 复制当前基线到根目录 Temp，在专属项目内验证文件完整性和后续增量事务。 */
async function createProject(migrations: Record<string, string> = {}, throughMigration?: string): Promise<string> {
  let project: string | undefined;
  try {
    project = await createOwnedFixture('prisma-current-baseline');
    const directory = join(project, 'prisma');
    const migrationRoot = join(apiDirectory, 'prisma/migrations');
    await cp(join(apiDirectory, 'prisma'), directory, {
      recursive: true,
      // 专属旧库夹具复制指定版本及之前的正式迁移。
      filter: (source) => {
        const child = relative(migrationRoot, source);
        return (
          !throughMigration ||
          !child ||
          child.startsWith('..') ||
          child === 'migration_lock.toml' ||
          child.split(sep)[0]! <= throughMigration
        );
      },
    });
    await linkOwnedFixtureDependencies(project);
    for (const [name, sql] of Object.entries(migrations)) {
      await mkdir(join(directory, 'migrations', name), { recursive: true });
      await writeFile(join(directory, 'migrations', name, 'migration.sql'), sql);
    }
    return join(directory, 'setup.mjs');
  } catch (cause) {
    if (project) await removeOwnedFixture(project);
    throw new Error('当前基线验收项目创建失败', { cause });
  }
}

/** 在隔离库中保留指定迁移版本，用于验证登记、升级和拒绝边界。 */
async function withMigrationDatabase(
  run: (url: string, database: PrismaClient, setup: string) => Promise<void>,
  throughMigration = BASELINE_MIGRATION,
): Promise<void> {
  let project: string | undefined;
  try {
    project = await createProject({}, throughMigration);
    await withIsolatedDatabase((url, database) => run(url, database, project!));
  } catch (cause) {
    throw new Error('指定版本数据库夹具验收失败', { cause });
  } finally {
    if (project) await removeOwnedFixture(dirname(dirname(project)));
  }
}

/** 只创建和清理本轮登记的数据库，异常时停止继续派生夹具。 */
async function withIsolatedDatabase(run: (url: string, database: PrismaClient) => Promise<void>): Promise<void> {
  const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', process.env), process.env);
  const failures: unknown[] = [];
  try {
    await run(lease.url, lease.prisma);
  } catch (cause) {
    failures.push(cause);
    try {
      haltLifecycleRun(process.env, '当前基线验收或夹具清理失败。');
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await lease.close();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length) throw new AggregateError(failures, '当前基线隔离验收失败');
}

/** 按表计算业务内容摘要，断言中只显示摘要，覆盖账号、种子、审计和同步事实。 */
async function contentSnapshot(database: PrismaClient, omitRetiredColumns = false): Promise<Record<string, string>> {
  try {
    const tables = await database.$queryRaw<Array<{ name: string }>>`
      SELECT tablename AS name FROM pg_tables
      WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename
    `;
    const snapshot: Record<string, string> = {};
    for (const { name } of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('业务表名无效');
      const retired = omitRetiredColumns ? (cleanupColumns[name] ?? []) : [];
      const projection = retired.length
        ? `to_jsonb(item) - ARRAY[${retired.map((column) => `'${column}'`).join(',')}]::text[]`
        : 'to_jsonb(item)';
      const [row] = await database.$queryRawUnsafe<Array<{ content: string }>>(
        `SELECT COALESCE(jsonb_agg(${projection} ORDER BY (${projection})::text),'[]'::jsonb)::text AS content FROM public."${name}" item`,
      );
      snapshot[name] = createHash('sha256').update(row!.content).digest('hex');
    }
    const counters = await database.$queryRaw<Array<{ name: string; value: string | null }>>`
      SELECT sequencename AS name,last_value::text AS value FROM pg_sequences
      WHERE schemaname='public' ORDER BY sequencename
    `;
    snapshot['@sequences'] = createHash('sha256').update(JSON.stringify(counters)).digest('hex');
    return snapshot;
  } catch (cause) {
    throw new Error('当前库业务内容摘要读取失败', { cause });
  }
}

/** 写入当前合法数据及管理员编辑，迁移记录收敛不得重写这些业务事实。 */
async function seedCurrentData(database: PrismaClient): Promise<string> {
  try {
    const user = await database.user.create({
      data: {
        phoneE164: '+8613900000000',
        sesameNumber: '100000001',
        passwordHash: 'current-baseline-fixture',
        createdAt: new Date('2026-10-30T01:02:03.456Z'),
      },
    });
    await database.$transaction(async (tx) => {
      const ledger = await tx.ledger.create({
        data: { ownerId: user.id, syncId: randomUUID(), name: '保留的现有账本', currency: 'CNY' },
      });
      // 账本与所有者成员共同提交，满足当前数据库的一等所有者约束。
      await tx.ledgerMember.create({
        data: {
          id: registeredMemberId(ledger.id, user.id),
          ledgerId: ledger.id,
          linkedAccountId: user.id,
          displayName: '保留的所有者成员',
          memberType: 'REGISTERED',
          status: 'ACTIVE',
          role: 'owner',
        },
      });
    });
    await database.category.create({
      data: { id: randomUUID(), ownerId: user.id, name: '保留的自定义分类', kind: 'expense', level: 1 },
    });
    await database.syncChange.create({
      data: {
        userId: user.id,
        scope: 'user',
        entityType: 'category',
        entityId: randomUUID(),
        action: 'upsert',
        mutationId: randomUUID(),
        deviceId: randomUUID(),
        payload: { name: '保留的同步原文', extra: null },
        updatedAt: new Date('2026-10-30T01:02:04.789Z'),
      },
    });
    await database.officialFitnessTaxon.update({
      where: { kind_id: { kind: 'equipment', id: 'dumbbell' } },
      data: { nameZh: '保留的管理员器械名', version: { increment: 1 }, updatedBy: 'current-admin' },
    });
    await database.serverEpoch.update({
      where: { id: 0 },
      data: {
        syncCutoverCursor: 1001n,
        syncCutoverAt: new Date('2026-10-30T01:02:05.123Z'),
        syncCursorFloor: 1009n,
      },
    });
    // 已删除事件可能留下较高水位，序列仍须继续分配高于已发布水位的新事件身份。
    await database.$queryRaw`SELECT setval('public.sync_changes_change_id_seq',1013,true)`;
    return user.id;
  } catch (cause) {
    throw new Error('当前业务数据夹具创建失败', { cause });
  }
}

/** 写入升级前的业务关联和旧设备标记，保留可逐项核对的同步事件与编辑历史。 */
async function seedDomainMetadata(database: PrismaClient, userId: string): Promise<void> {
  try {
    const ledger = await database.ledger.findFirstOrThrow({ where: { ownerId: userId } });
    const category = await database.category.findFirstOrThrow({ where: { ownerId: userId } });
    const memberId = registeredMemberId(ledger.id, userId);
    const now = new Date('2026-11-01T08:00:00.123Z');
    const device = await database.device.create({ data: { userId, installationId: randomUUID() } });
    await database.ledgerMember.update({
      where: { id: memberId },
      data: { joinedAt: now, updatedAt: now, updatedByDeviceId: device.id },
    });
    await database.category.update({
      where: { id_ownerId: { id: category.id, ownerId: userId } },
      data: { updatedAt: now, updatedByDeviceId: device.id },
    });
    await database.ledgerInvite.create({
      data: { ledgerId: ledger.id, createdById: userId, codeHash: '7'.repeat(64), expiresAt: new Date('2099-01-01') },
    });
    const rule = await database.recurringTransaction.create({
      data: {
        ledgerId: ledger.id,
        ownerId: userId,
        categoryId: category.id,
        txType: 'expense',
        amount: '128.56',
        currencyCode: 'CNY',
        frequency: 'daily',
        startDate: now,
        lastGeneratedDate: now,
        timeZone: 'Asia/Shanghai',
        updatedAt: now,
        updatedByDeviceId: device.id,
      },
    });
    const transaction = await database.transaction.create({
      data: {
        id: recurringOccurrenceId(ledger.id, rule.id, '2026-11-01'),
        ledgerId: ledger.id,
        ownerId: userId,
        txType: 'expense',
        amount: '128.56',
        nativeAmount: '128.56',
        currencyCode: 'CNY',
        happenedAt: now,
        note: '保留的周期账单备注',
        categoryId: category.id,
        categoryName: category.name,
        categoryKind: category.kind,
        recurringId: rule.id,
        occurrenceDate: '2026-11-01',
        createdByMemberId: memberId,
        lastEditedByMemberId: memberId,
        payerMemberId: memberId,
        revision: 2,
        lastEditedAt: now,
        updatedAt: now,
      },
    });
    const changes = { note: transaction.note };
    await database.transactionEditHistory.create({
      data: { transactionId: transaction.id, ledgerId: ledger.id, operatorMemberId: memberId, version: 2, changes },
    });
    const book = await database.dayBook.create({ data: { ownerId: userId, name: '保留的日子本' } });
    const dayEvent = await database.dayEvent.create({
      data: {
        dayBookId: book.id,
        name: '保留的生日',
        category: 'birthday',
        repeatType: 'yearly',
        statisticType: 'year',
        eventCalendarType: 'solar',
        eventOriginalYear: 1990,
        eventOriginalMonth: 6,
        eventOriginalDay: 15,
        eventIsLeapMonth: false,
        eventSolarDate: new Date('1990-06-15'),
        revision: 2,
        updatedAt: now,
      },
    });
    // 使用原生 SQL 在升级前的真实列中写入设备 ID，当前 ORM 只操作现行字段。
    await database.$executeRaw`UPDATE transactions SET updated_by_device_id=${device.id}::uuid WHERE id=${transaction.id}::uuid`;
    await database.$executeRaw`UPDATE day_events SET updated_by_device_id=${device.id}::uuid WHERE id=${dayEvent.id}::uuid`;
    await database.syncChange.createMany({
      data: [
        {
          userId,
          ledgerId: ledger.id,
          scope: 'ledger',
          entityType: 'transaction',
          entityId: transaction.id,
          action: 'upsert',
          mutationId: randomUUID(),
          deviceId: device.id,
          payload: { revision: 2, ...changes },
          updatedAt: now,
        },
        {
          userId,
          dayBookId: book.id,
          scope: 'user',
          entityType: 'day_event',
          entityId: dayEvent.id,
          action: 'upsert',
          mutationId: randomUUID(),
          deviceId: device.id,
          payload: { revision: 2, name: dayEvent.name },
          updatedAt: now,
        },
      ],
    });
  } catch (cause) {
    throw new Error('待升级业务关系与历史数据夹具创建失败', { cause });
  }
}

/** 比较全部业务外键定义，核对删列仅移除对应设备引用。 */
async function foreignKeySnapshot(database: PrismaClient) {
  try {
    return await database.$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT conrelid::regclass::text || '.' || conname AS name,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f' ORDER BY name
    `;
  } catch (cause) {
    throw new Error('业务外键定义读取失败', { cause });
  }
}

/** 在结构已是当前版本的租约库中模拟既有部署记录，不执行任何历史 SQL。 */
async function restoreCurrentHistory(database: PrismaClient): Promise<void> {
  try {
    await database.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM _prisma_migrations`;
      for (const entry of CURRENT_HISTORY) {
        await tx.$executeRaw`
          INSERT INTO _prisma_migrations (id,checksum,finished_at,migration_name,started_at,applied_steps_count)
          VALUES (${randomUUID()},${entry.checksums[0]},CURRENT_TIMESTAMP,${entry.name},CURRENT_TIMESTAMP,1)
        `;
      }
    });
  } catch (cause) {
    throw new Error('当前部署记录夹具创建失败', { cause });
  }
}

/** 读取迁移记录的完整内容，验证拒绝路径不会偷偷修改部署状态。 */
async function migrationSnapshot(database: PrismaClient) {
  try {
    return await database.$queryRaw`SELECT * FROM _prisma_migrations ORDER BY migration_name`;
  } catch (cause) {
    throw new Error('迁移记录读取失败', { cause });
  }
}

/** 验证数据库函数支持可选默认热身休息，并继续拒绝非法数值及未声明字段。 */
async function expectFitnessWarmupRestSeconds(database: PrismaClient): Promise<void> {
  try {
    const base = fitnessPreferences();
    const cases = [
      { payload: base, valid: true },
      { payload: { ...base, default_warmup_rest_seconds: 0 }, valid: true },
      { payload: { ...base, default_warmup_rest_seconds: -1 }, valid: false },
      { payload: { ...base, default_warmup_rest_seconds: 30, unknown: true }, valid: false },
    ];
    for (const entry of cases) {
      const rows = await database.$queryRaw<Array<{ valid: boolean }>>`
        SELECT fitness_payload_valid('fitness_preferences', ${JSON.stringify(entry.payload)}::jsonb) AS valid
      `;
      expect(rows[0]!.valid, JSON.stringify(entry.payload)).toBe(entry.valid);
    }
  } catch (cause) {
    throw new Error('健身默认热身休息数据库规则验收失败', { cause });
  }
}

it('空库直接建立当前业务约束与种子，重复部署保持对象和数据不变', async () => {
  await withIsolatedDatabase(async (url, database) => {
    try {
      await initialize(url, database);
      await expectFitnessWarmupRestSeconds(database);
      expect(await database.officialFitnessContent.count()).toBeGreaterThan(100);
      expect(await database.officialFitnessTaxon.count()).toBe(38);
      expect(
        await database.adminGroup.count({
          where: { id: 'a0000000-0000-4000-8000-000000000000', isEnabled: true, deletedAt: null },
        }),
      ).toBe(1);
      const epoch = await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      expect(epoch).toMatchObject({ syncCutoverCursor: 0n, syncCutoverAt: expect.any(Date), syncCursorFloor: 0n });
      const before = await contentSnapshot(database);
      const history = await migrationSnapshot(database);
      const objects =
        await database.$queryRaw`SELECT oid,xmin::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid`;
      await initialize(url, database);
      expect(await contentSnapshot(database)).toEqual(before);
      expect(await migrationSnapshot(database)).toEqual(history);
      expect(
        await database.$queryRaw`SELECT oid,xmin::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid`,
      ).toEqual(objects);
    } catch (cause) {
      throw new Error('当前空库建库与幂等验收失败', { cause });
    }
  });
}, 180_000);

it('当前存量库仅收敛迁移记录，全部业务数据和同步代际逐字保留', async () => {
  await withMigrationDatabase(async (url, database, setup) => {
    try {
      await initialize(url, database, setup);
      await seedCurrentData(database);
      await restoreCurrentHistory(database);
      const before = await contentSnapshot(database);
      const epoch = await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      await initialize(url, database, setup);
      expect(await contentSnapshot(database)).toEqual(before);
      expect(await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toEqual(epoch);
      expect(
        await database.$queryRaw`SELECT migration_name,finished_at IS NOT NULL AS applied FROM _prisma_migrations`,
      ).toEqual([{ migration_name: BASELINE_MIGRATION, applied: true }]);
      const history = await migrationSnapshot(database);
      await initialize(url, database, setup);
      expect(await contentSnapshot(database)).toEqual(before);
      expect(await migrationSnapshot(database)).toEqual(history);
    } catch (cause) {
      throw new Error('当前存量数据保留验收失败', { cause });
    }
  });
}, 180_000);

it('非当前结构、损坏部署记录和未完成同步状态均拒绝收敛，不改业务或记录', async () => {
  await withMigrationDatabase(async (url, database, setup) => {
    try {
      await initialize(url, database, setup);
      await seedCurrentData(database);
      await restoreCurrentHistory(database);
      const before = await contentSnapshot(database);
      await database.$executeRaw`UPDATE _prisma_migrations SET checksum=${'0'.repeat(64)} WHERE migration_name=${CURRENT_HISTORY[0]!.name}`;
      const damaged = await migrationSnapshot(database);
      await expect(initialize(url, database, setup)).rejects.toThrow('当前数据库初始化失败');
      expect(await migrationSnapshot(database)).toEqual(damaged);
      expect(await contentSnapshot(database)).toEqual(before);
      await restoreCurrentHistory(database);
      await database.$executeRawUnsafe('ALTER TABLE users ADD COLUMN unsupported_probe TEXT');
      const drifted = await migrationSnapshot(database);
      await expect(initialize(url, database, setup)).rejects.toThrow('当前数据库初始化失败');
      expect(await migrationSnapshot(database)).toEqual(drifted);
      await database.$executeRawUnsafe('ALTER TABLE users DROP COLUMN unsupported_probe');
      expect(await contentSnapshot(database)).toEqual(before);
      await database.serverEpoch.update({ where: { id: 0 }, data: { syncCutoverCursor: null, syncCutoverAt: null } });
      const incomplete = await contentSnapshot(database);
      await expect(initialize(url, database, setup)).rejects.toThrow('当前数据库初始化失败');
      expect(await migrationSnapshot(database)).toEqual(drifted);
      expect(await contentSnapshot(database)).toEqual(incomplete);
    } catch (cause) {
      throw new Error('当前基线拒绝边界验收失败', { cause });
    }
  });
}, 180_000);

it('基线登记写入失败时回滚整组迁移记录，业务内容与同步水位保持原值', async () => {
  await withMigrationDatabase(async (url, database, setup) => {
    try {
      await initialize(url, database, setup);
      await seedCurrentData(database);
      await restoreCurrentHistory(database);
      const before = await contentSnapshot(database);
      const history = await migrationSnapshot(database);
      // 故障只作用于本轮元数据新登记，用独立测试命名空间保持业务结构完整。
      await database.$executeRawUnsafe('CREATE SCHEMA baseline_failure');
      await database.$executeRawUnsafe(`
        CREATE FUNCTION baseline_failure.reject_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION '模拟当前基线登记写入失败';
        END
        $$
      `);
      await database.$executeRawUnsafe(`
        CREATE TRIGGER reject_baseline_insert BEFORE INSERT ON public._prisma_migrations
        FOR EACH ROW WHEN (NEW.migration_name='${BASELINE_MIGRATION}')
        EXECUTE FUNCTION baseline_failure.reject_baseline()
      `);
      await expect(initialize(url, database, setup)).rejects.toThrow('当前数据库初始化失败');
      expect(await migrationSnapshot(database)).toEqual(history);
      expect(await contentSnapshot(database)).toEqual(before);
    } catch (cause) {
      throw new Error('当前基线登记事务回滚验收失败', { cause });
    }
  });
}, 180_000);

it('已登记基线文件被篡改时拒绝部署，保留全部数据与迁移记录', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let project: string | undefined;
    try {
      await initialize(url, database);
      await seedCurrentData(database);
      const before = await contentSnapshot(database);
      const history = await migrationSnapshot(database);
      project = await createProject();
      const file = join(dirname(project), 'migrations', BASELINE_MIGRATION, 'migration.sql');
      await writeFile(file, `${readFileSync(file, 'utf8')}\n-- integrity probe\n`);
      await expect(initialize(url, database, project)).rejects.toThrow('当前数据库初始化失败');
      expect(await contentSnapshot(database)).toEqual(before);
      expect(await migrationSnapshot(database)).toEqual(history);
    } catch (cause) {
      throw new Error('基线文件完整性验收失败', { cause });
    } finally {
      if (project) await removeOwnedFixture(dirname(dirname(project)));
    }
  });
}, 180_000);

it('当前基线支持后续显式增量，失败事务保留业务数据且不记为已完成', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let project: string | undefined;
    try {
      await initialize(url, database);
      const userId = await seedCurrentData(database);
      const before = await contentSnapshot(database);
      project = await createProject({
        [PROBE_MIGRATION]: 'ALTER TABLE users ADD COLUMN current_probe TEXT;\n',
        [BROKEN_MIGRATION]: 'BEGIN;\nALTER TABLE users DROP COLUMN phone_e164;\nSELECT 1/0;\nCOMMIT;\n',
      });
      await expect(initialize(url, database, project)).rejects.toThrow('当前数据库初始化失败');
      expect(await database.$queryRaw`SELECT phone_e164,current_probe FROM users WHERE id=${userId}::uuid`).toEqual([
        { phone_e164: '+8613900000000', current_probe: null },
      ]);
      await database.$executeRawUnsafe('ALTER TABLE users DROP COLUMN current_probe');
      expect(await contentSnapshot(database)).toEqual(before);
      expect(
        await database.$queryRaw`SELECT migration_name,finished_at IS NOT NULL AS applied FROM _prisma_migrations ORDER BY migration_name`,
      ).toEqual([
        ...expectedAppliedMigrations(),
        { migration_name: PROBE_MIGRATION, applied: true },
        { migration_name: BROKEN_MIGRATION, applied: false },
      ]);
    } catch (cause) {
      throw new Error('当前基线增量与事务回滚验收失败', { cause });
    } finally {
      if (project) await removeOwnedFixture(dirname(dirname(project)));
    }
  });
}, 180_000);

it('从已部署版本删去六列，业务行、编辑历史、设备事件与其余外键逐项保留', async () => {
  await withMigrationDatabase(async (url, database, setup) => {
    try {
      await initialize(url, database, setup);
      const userId = await seedCurrentData(database);
      await seedDomainMetadata(database, userId);
      const before = await contentSnapshot(database, true);
      const foreignKeys = await foreignKeySnapshot(database);
      const retiredKeys = [
        'transactions.transactions_updated_by_device_id_fkey',
        'day_events.day_events_updated_by_device_id_fkey',
      ];
      expect(foreignKeys.map(({ name }) => name)).toEqual(expect.arrayContaining(retiredKeys));
      await initialize(url, database);
      // 增量可以新增业务表，升级前已有表的数据与同步水位必须完整保留。
      expect(await contentSnapshot(database, true)).toMatchObject(before);
      const currentForeignKeys = await foreignKeySnapshot(database);
      expect(currentForeignKeys).toEqual(
        expect.arrayContaining(foreignKeys.filter(({ name }) => !retiredKeys.includes(name))),
      );
      expect(currentForeignKeys.some(({ name }) => retiredKeys.includes(name))).toBe(false);
      expect(
        await database.$queryRaw`
          SELECT migration_name,finished_at IS NOT NULL AS applied FROM _prisma_migrations ORDER BY migration_name
        `,
      ).toEqual(expectedAppliedMigrations());
    } catch (cause) {
      throw new Error('业务字段物理删列与存量数据保留验收失败', { cause });
    }
  }, CLEANUP_MIGRATION);
}, 180_000);

it('日子设备列存在额外依赖时，本次六列和两个设备外键全部回滚', async () => {
  await withMigrationDatabase(async (url, database, setup) => {
    let project: string | undefined;
    try {
      await initialize(url, database, setup);
      const userId = await seedCurrentData(database);
      await seedDomainMetadata(database, userId);
      const before = await contentSnapshot(database);
      const foreignKeys = await foreignKeySnapshot(database);
      project = await createProject({
        '20261103120000_domain_dependency_probe':
          'CREATE VIEW public.domain_cleanup_dependency AS SELECT updated_by_device_id FROM public.day_events;\n',
      });
      await expect(initialize(url, database, project)).rejects.toThrow('当前数据库初始化失败');
      expect(await contentSnapshot(database)).toEqual(before);
      expect(await foreignKeySnapshot(database)).toEqual(foreignKeys);
      // 依赖视图由上一条增量提交，原列仍在且可通过该视图读取非空设备标记。
      expect(
        await database.$queryRaw`SELECT updated_by_device_id IS NOT NULL AS preserved FROM public.domain_cleanup_dependency`,
      ).toEqual([{ preserved: true }]);
      expect(
        await database.$queryRaw`
          SELECT finished_at IS NULL AS failed
          FROM _prisma_migrations WHERE migration_name=${DOMAIN_CLEANUP_MIGRATION}
        `,
      ).toEqual([{ failed: true }]);
    } catch (cause) {
      throw new Error('业务字段物理删列失败回滚验收失败', { cause });
    } finally {
      if (project) await removeOwnedFixture(dirname(dirname(project)));
    }
  }, CLEANUP_MIGRATION);
}, 180_000);
