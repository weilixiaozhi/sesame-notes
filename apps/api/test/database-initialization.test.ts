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

const dayConstraintDefinitions = JSON.parse(
  readFileSync(new URL('./fixtures/day-database-constraints.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const memoConstraintDefinitions = JSON.parse(
  readFileSync(new URL('./fixtures/memo-database-constraints.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const fitnessConstraintDefinitions = JSON.parse(
  readFileSync(new URL('./fixtures/fitness-database-constraints.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const adminConstraintDefinitions = JSON.parse(
  readFileSync(new URL('./fixtures/admin-database-constraints.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const bannerConstraintDefinitions = JSON.parse(
  readFileSync(new URL('./fixtures/banner-database-constraints.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const analyticsConstraintDefinitions = JSON.parse(
  readFileSync(new URL('./fixtures/analytics-database-constraints.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const officialFitnessConstraintDefinitions = JSON.parse(
  readFileSync(new URL('./fixtures/official-fitness-database-constraints.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const apiDirectory = join(import.meta.dirname, '..');
assertLifecycleSuite('database-initialization.test.ts', process.env);

const PROBE_MIGRATION = '20990101000000_current_probe';
const BROKEN_MIGRATION = '20990102000000_broken_probe';
const CLEANUP_MIGRATION = '20261103000000_remove_unused_storage_columns';
const DOMAIN_CLEANUP_MIGRATION = '20261104000000_remove_unused_domain_columns';
const cleanupColumns: Record<string, string[]> = {
  official_fitness_media: ['mime_type'],
  ledger_invites: ['code_prefix', 'created_at'],
  ledger_members: ['created_at'],
  categories: ['created_at'],
  recurring_transactions: ['created_at'],
  transactions: ['updated_by_device_id'],
  day_events: ['updated_by_device_id'],
  product_analytics_events: ['received_at'],
  admin_sessions: ['user_agent', 'ip', 'created_at'],
  mutation_reservations: ['created_at'],
  idempotency_keys: ['created_at'],
  admin_accounts: ['deleted_by'],
  admin_groups: ['deleted_by'],
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

/** 写入待精简列的非空值及其对应业务，保证删列验收覆盖真实已有行。 */
async function seedRetiredMetadata(database: PrismaClient, userId: string): Promise<void> {
  try {
    const ledger = await database.ledger.findFirstOrThrow({ where: { ownerId: userId } });
    const admin = await database.adminAccount.create({
      data: { username: 'storage_cleanup', displayName: '保留的后台用户', passwordHash: 'fixture-password-hash' },
    });
    const removedAdmin = await database.adminAccount.create({
      data: { username: 'removed_cleanup', displayName: '保留的已删除后台用户', passwordHash: 'fixture-password-hash' },
    });
    const removedGroup = await database.adminGroup.create({ data: { name: '保留的已删除组' } });
    await database.$executeRaw`
      UPDATE admin_accounts SET deleted_at='2026-11-01'::timestamptz,is_enabled=false,
        deleted_by='fixture-actor',updated_by='fixture-actor' WHERE id=${removedAdmin.id}::uuid
    `;
    await database.$executeRaw`
      UPDATE admin_groups SET deleted_at='2026-11-01'::timestamptz,is_enabled=false,
        deleted_by='fixture-actor',updated_by='fixture-actor' WHERE id=${removedGroup.id}::uuid
    `;
    await database.$executeRaw`
      INSERT INTO ledger_invites(id,code_hash,code_prefix,ledger_id,created_by_id,expires_at)
      VALUES (${randomUUID()}::uuid,${'1'.repeat(64)},'prefix01',${ledger.id}::uuid,${userId}::uuid,'2099-01-01'::timestamptz)
    `;
    await database.$executeRaw`
      INSERT INTO official_fitness_media(id,file_name,mime_type,byte_size,width,height,frames)
      VALUES (${'2'.repeat(64)},'保留的素材.gif','image/gif',12,2,3,4)
    `;
    await database.$executeRaw`
      INSERT INTO product_analytics_events(actor_key,event_id,kind,occurred_at,received_at,platform)
      VALUES (${'3'.repeat(64)},${randomUUID()}::uuid,'active','2026-11-01'::timestamptz,'2026-11-02'::timestamptz,'app')
    `;
    await database.$executeRaw`
      INSERT INTO admin_sessions(id,admin_id,token_hash,created_at,last_seen_at,expires_at,ip,user_agent)
      VALUES (${randomUUID()}::uuid,${admin.id}::uuid,${'4'.repeat(64)},'2026-11-01'::timestamptz,
        '2026-11-02'::timestamptz,'2099-01-01'::timestamptz,'127.0.0.9','fixture-agent')
    `;
    await database.mutationReservation.create({
      data: { scope: 'device', userId, scopeId: randomUUID(), mutationId: randomUUID(), requestHash: '5'.repeat(64) },
    });
    const epoch = await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
    await database.idempotencyKey.create({
      data: {
        userId,
        key: 'preserved-replay',
        requestHash: '6'.repeat(64),
        response: { preserved: true },
        expiresAt: new Date('2099-01-01'),
        generation: epoch.idempotencyGeneration,
      },
    });
  } catch (cause) {
    throw new Error('精简列存量数据夹具创建失败', { cause });
  }
}

/** 只接受当前精简列全部消失，其他业务约束继续使用完整定义校验。 */
async function expectRetiredColumnsAbsent(database: PrismaClient): Promise<void> {
  try {
    for (const [table, columns] of Object.entries(cleanupColumns)) {
      const actual = await database.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${table}
      `;
      for (const column of columns) expect(actual.map((entry) => entry.column_name)).not.toContain(column);
    }
    await expectCurrentDefinitions(database);
  } catch (cause) {
    throw new Error('物理删列及保留约束验收失败', { cause });
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

/** 独立列出当前业务约束的最终定义，核对完整 CHECK 集合及单 Owner 部分唯一索引。 */
async function expectCurrentDefinitions(database: PrismaClient): Promise<void> {
  const checks = await database.$queryRaw<Array<{ name: string; definition: string }>>`
    SELECT tbl.relname || '.' || con.conname AS name, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class tbl ON tbl.oid = con.conrelid
    WHERE con.connamespace = 'public'::regnamespace AND con.contype = 'c'
  `;
  expect.soft(Object.fromEntries(checks.map(({ name, definition }) => [name, definition]))).toEqual({
    ...dayConstraintDefinitions,
    ...memoConstraintDefinitions,
    ...fitnessConstraintDefinitions,
    ...adminConstraintDefinitions,
    ...bannerConstraintDefinitions,
    ...analyticsConstraintDefinitions,
    ...officialFitnessConstraintDefinitions,
    'category_conflicts.category_conflicts_state_check':
      "CHECK (((candidate_version > 0) AND ((action)::text = ANY ((ARRAY['upsert'::character varying, 'delete'::character varying])::text[])) AND ((((status)::text = 'pending'::text) AND (resolution IS NULL) AND (resolved_at IS NULL) AND (resolution_mutation_id IS NULL) AND (resolution_hash IS NULL) AND (resolution_result IS NULL)) OR (((status)::text = 'resolved'::text) AND (resolution IS NOT NULL) AND ((resolution)::text = ANY ((ARRAY['cloud'::character varying, 'local'::character varying])::text[])) AND (resolved_at IS NOT NULL) AND (resolution_mutation_id IS NOT NULL) AND (resolution_hash IS NOT NULL) AND (resolution_result IS NOT NULL)))))",
    'categories.categories_kind_check': "CHECK (((kind)::text = 'expense'::text))",
    'categories.categories_level_check':
      'CHECK ((((level = 1) AND (parent_id IS NULL)) OR ((level = 2) AND (parent_id IS NOT NULL))))',
    'exchange_rate_overrides.exchange_rate_overrides_currency_check':
      "CHECK ((((base_currency)::text ~ '^[A-Z]{3}$'::text) AND ((quote_currency)::text ~ '^[A-Z]{3}$'::text) AND ((base_currency)::text <> (quote_currency)::text)))",
    'exchange_rate_overrides.exchange_rate_overrides_rate_check': 'CHECK ((rate > (0)::numeric))',
    'ledger_invites.ledger_invites_role_check': "CHECK (((role)::text = 'editor'::text))",
    'ledger_members.ledger_members_registered_id_v5_check': `CHECK (((member_type <> 'REGISTERED'::"LedgerMemberType") OR (id = uuid_generate_v5(ledger_id, ('user:'::text || (linked_account_id)::text)))))`,
    'ledger_members.ledger_members_role_check': `CHECK ((role = ANY (ARRAY['owner'::"LedgerMemberRole", 'editor'::"LedgerMemberRole"])))`,
    'ledger_members.ledger_members_type_account_check': `CHECK ((((member_type = 'REGISTERED'::"LedgerMemberType") AND (linked_account_id IS NOT NULL)) OR ((member_type = 'PLACEHOLDER'::"LedgerMemberType") AND (linked_account_id IS NULL))))`,
    'ledgers.ledgers_currency_check': "CHECK (((currency)::text ~ '^[A-Z]{3}$'::text))",
    'ledgers.ledgers_month_start_day_check': 'CHECK (((month_start_day >= 1) AND (month_start_day <= 31)))',
    'recurring_transactions.recurring_transactions_amount_check': 'CHECK ((amount > (0)::numeric))',
    'recurring_transactions.recurring_transactions_currency_check':
      "CHECK (((currency_code)::text ~ '^[A-Z]{3}$'::text))",
    'recurring_transactions.recurring_transactions_frequency_check':
      "CHECK (((frequency)::text = ANY ((ARRAY['daily'::character varying, 'weekly'::character varying, 'monthly'::character varying, 'yearly'::character varying])::text[])))",
    'recurring_transactions.recurring_transactions_rule_check':
      'CHECK ((("interval" >= 1) AND ((day_of_month IS NULL) OR ((day_of_month >= 1) AND (day_of_month <= 31))) AND ((day_of_week IS NULL) OR ((day_of_week >= 1) AND (day_of_week <= 7))) AND ((month_of_year IS NULL) OR ((month_of_year >= 1) AND (month_of_year <= 12))) AND ((end_date IS NULL) OR (end_date >= start_date))))',
    'recurring_transactions.recurring_transactions_type_check': "CHECK (((tx_type)::text = 'expense'::text))",
    'server_epochs.server_epochs_id_check': 'CHECK ((id = 0))',
    'server_epochs.server_epochs_sync_cursor_floor_check': 'CHECK ((sync_cursor_floor >= 0))',
    'server_epochs.server_epochs_sync_cutover_check':
      'CHECK ((((sync_cutover_cursor IS NULL) AND (sync_cutover_at IS NULL)) OR ((sync_cutover_cursor IS NOT NULL) AND (sync_cutover_cursor >= 0) AND (sync_cutover_at IS NOT NULL))))',
    'sync_changes.sync_changes_action_check':
      "CHECK (((action)::text = ANY ((ARRAY['upsert'::character varying, 'delete'::character varying])::text[])))",
    'sync_changes.sync_changes_entity_type_check':
      "CHECK (((entity_type)::text = ANY ((ARRAY['ledger'::character varying, 'ledger_archive'::character varying, 'transaction'::character varying, 'category'::character varying, 'recurring_transaction'::character varying, 'exchange_rate_override'::character varying, 'member'::character varying, 'day_book'::character varying, 'day_event'::character varying, 'memo_book'::character varying, 'memo_entry'::character varying, 'fitness_space'::character varying, 'fitness_template'::character varying, 'fitness_plan'::character varying, 'fitness_workout'::character varying, 'fitness_preferences'::character varying])::text[])))",
    'sync_changes.sync_changes_scope_check':
      "CHECK (((((scope)::text = 'user'::text) AND (ledger_id IS NULL)) OR (((scope)::text = 'ledger'::text) AND (ledger_id IS NOT NULL))))",
    'transaction_splits.transaction_splits_amount_check': 'CHECK ((amount > (0)::numeric))',
    'transaction_splits.transaction_splits_participant_check': 'CHECK ((member_id IS NOT NULL))',
    'transactions.transactions_aa_mode_check': 'CHECK (((aa_mode IS NULL) OR (aa_mode = ANY (ARRAY[0, 1, 2]))))',
    'transactions.transactions_amount_check': 'CHECK (((amount > (0)::numeric) AND (native_amount > (0)::numeric)))',
    'transactions.transactions_currency_check': "CHECK (((currency_code)::text ~ '^[A-Z]{3}$'::text))",
    'transactions.transactions_category_kind_check':
      "CHECK (((category_kind IS NULL) OR ((category_kind)::text = 'expense'::text)))",
    'transactions.transactions_type_check': "CHECK (((tx_type)::text = 'expense'::text))",
    'transactions.transactions_revision_check': 'CHECK ((revision >= 1))',
    'user_profiles.user_profiles_avatar_version_check': 'CHECK ((avatar_version >= 0))',
    'users.users_phone_e164_check': "CHECK (((phone_e164)::text ~ '^\\+[1-9][0-9]{1,14}$'::text))",
    'users.users_sesame_number_check': "CHECK ((sesame_number ~ '^[1-9][0-9]{8}$'::text))",
  });
  expect(
    await database.$queryRaw`SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid = to_regclass('public.admin_groups_live_name_key')`,
  ).toEqual([
    {
      definition:
        'CREATE UNIQUE INDEX admin_groups_live_name_key ON public.admin_groups USING btree (name) WHERE (deleted_at IS NULL)',
    },
  ]);
  expect(
    await database.$queryRaw`SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_accounts' AND column_name='group_id'`,
  ).toEqual([{ is_nullable: 'NO' }]);
  const indexes = await database.$queryRaw<Array<{ definition: string }>>`
    SELECT pg_get_indexdef(indexrelid) AS definition
    FROM pg_index
    WHERE indexrelid = to_regclass('public.ledger_members_one_owner_per_ledger')
  `;
  expect.soft(indexes).toEqual([
    {
      definition: `CREATE UNIQUE INDEX ledger_members_one_owner_per_ledger ON public.ledger_members USING btree (ledger_id) WHERE (role = 'owner'::"LedgerMemberRole")`,
    },
  ]);
  const fitnessIndexes = await database.$queryRaw<Array<{ definition: string }>>`
    SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index
    WHERE indexrelid = to_regclass('public.fitness_one_running_per_space')
  `;
  expect.soft(fitnessIndexes).toEqual([
    {
      definition:
        "CREATE UNIQUE INDEX fitness_one_running_per_space ON public.fitness_entities USING btree (fitness_space_id) WHERE (((status)::text = 'in_progress'::text) AND (deleted_at IS NULL))",
    },
  ]);
  // 三条分类引用只依赖复合主键，不能残留同列唯一索引或丢失外键保护。
  expect(await database.$queryRaw`SELECT to_regclass('public.categories_id_owner_id_key')::text AS name`).toEqual([
    { name: null },
  ]);
  const categoryReferences = await database.$queryRaw<Array<{ name: string; index_name: string }>>`
    SELECT constraint_row.conname AS name, index.relname AS index_name FROM pg_constraint constraint_row
    JOIN pg_class index ON index.oid = constraint_row.conindid
    WHERE constraint_row.contype = 'f' AND constraint_row.confrelid = 'public.categories'::regclass
    ORDER BY constraint_row.conname
  `;
  expect(categoryReferences).toEqual(
    [
      'categories_parent_owner_fkey',
      'category_conflicts_category_fkey',
      'recurring_transactions_category_owner_fkey',
      'transactions_category_owner_fkey',
    ].map((name) => ({ name, index_name: 'categories_pkey' })),
  );
  expect(
    await database.$queryRaw`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'memo_entries' AND column_name = 'title'
    `,
  ).toEqual([{ data_type: 'json', is_nullable: 'NO' }]);
}

/** 验证派生引用双向索引、来源级联及目标可晚到的外键边界。 */
async function expectFitnessReferenceIndex(database: PrismaClient): Promise<void> {
  try {
    const indexes = await database.$queryRaw<Array<{ name: string; definition: string }>>`
      SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS definition
      FROM pg_index WHERE indrelid = 'public.fitness_entity_references'::regclass ORDER BY name
    `;
    expect(indexes).toEqual([
      {
        name: 'fitness_entity_references_pkey',
        definition:
          'CREATE UNIQUE INDEX fitness_entity_references_pkey ON public.fitness_entity_references USING btree (entity_id, target_id)',
      },
      {
        name: 'fitness_entity_references_target_id_entity_id_idx',
        definition:
          'CREATE INDEX fitness_entity_references_target_id_entity_id_idx ON public.fitness_entity_references USING btree (target_id, entity_id)',
      },
    ]);
    expect(
      await database.$queryRaw`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'public.fitness_entity_references'::regclass AND contype = 'f'
      `,
    ).toEqual([
      { definition: 'FOREIGN KEY (entity_id) REFERENCES fitness_entities(id) ON UPDATE CASCADE ON DELETE CASCADE' },
    ]);
    expect(
      await database.$queryRaw`
        SELECT tgdeferrable AS deferrable, tginitdeferred AS deferred
        FROM pg_trigger WHERE tgrelid = 'public.fitness_entities'::regclass AND tgname = 'fitness_space_references'
      `,
    ).toEqual([{ deferrable: true, deferred: true }]);
    expect(
      await database.$queryRaw`
        SELECT table_name, column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND
          ((table_name = 'product_analytics_events' AND column_name = 'id') OR
           (table_name IN ('official_fitness_content', 'official_fitness_taxonomies', 'admin_groups') AND column_name = 'updated_at'))
        ORDER BY table_name
      `,
    ).toEqual([
      { table_name: 'admin_groups', column_name: 'updated_at', column_default: 'CURRENT_TIMESTAMP' },
      { table_name: 'official_fitness_content', column_name: 'updated_at', column_default: 'CURRENT_TIMESTAMP' },
      { table_name: 'official_fitness_taxonomies', column_name: 'updated_at', column_default: 'CURRENT_TIMESTAMP' },
      { table_name: 'product_analytics_events', column_name: 'id', column_default: 'gen_random_uuid()' },
    ]);
  } catch (cause) {
    throw new Error('健身来源索引及数据库默认值验收失败', { cause });
  }
}

/** 验证数据库函数支持可选默认热身休息，并继续拒绝非法数值及未声明字段。 */
async function expectFitnessWarmupRestSeconds(database: PrismaClient): Promise<void> {
  try {
    const base = fitnessPreferences();
    const cases = [
      { payload: base, valid: true },
      ...[0, 30, 2147483647].map((value) => ({
        payload: { ...base, default_warmup_rest_seconds: value },
        valid: true,
      })),
      ...[-1, 0.5, 2147483648, '30', null].map((value) => ({
        payload: { ...base, default_warmup_rest_seconds: value },
        valid: false,
      })),
      { payload: { ...base, default_warmup_rest_seconds: 30, unknown: true }, valid: false },
      { payload: { ...base, default_warmup_rest_seconds: 30, default_rest_seconds: -1 }, valid: false },
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
      await expectRetiredColumnsAbsent(database);
      await expectFitnessWarmupRestSeconds(database);
      await expectFitnessReferenceIndex(database);
      expect(expectedAppliedMigrations()).toEqual([
        { migration_name: BASELINE_MIGRATION, applied: true },
        { migration_name: CLEANUP_MIGRATION, applied: true },
        { migration_name: DOMAIN_CLEANUP_MIGRATION, applied: true },
      ]);
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

it('存量基线精简物理列后保留全部其余行、序列、幂等凭据与同步水位', async () => {
  await withMigrationDatabase(async (url, database, setup) => {
    try {
      await initialize(url, database, setup);
      const userId = await seedCurrentData(database);
      await seedRetiredMetadata(database, userId);
      const before = await contentSnapshot(database, true);
      const epoch = await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      await initialize(url, database);
      await expectRetiredColumnsAbsent(database);
      expect(await contentSnapshot(database, true)).toEqual(before);
      expect(await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toEqual(epoch);
      expect(
        await database.$queryRaw`
        SELECT migration_name,finished_at IS NOT NULL AS applied FROM _prisma_migrations ORDER BY migration_name
      `,
      ).toEqual(expectedAppliedMigrations());
      const receipt = await database.idempotencyKey.findUniqueOrThrow({
        where: { userId_key: { userId, key: 'preserved-replay' } },
      });
      expect(receipt.response).toEqual({ preserved: true });
      expect(receipt.generation).toBe(epoch.idempotencyGeneration);
      const history = await migrationSnapshot(database);
      await initialize(url, database);
      expect(await contentSnapshot(database, true)).toEqual(before);
      expect(await migrationSnapshot(database)).toEqual(history);
    } catch (cause) {
      throw new Error('存量物理列精简与幂等验收失败', { cause });
    }
  });
}, 180_000);

it('精简增量末列存在依赖时整次DDL回滚，已删除列与约束全部恢复', async () => {
  await withMigrationDatabase(async (url, database, setup) => {
    let project: string | undefined;
    try {
      await initialize(url, database, setup);
      const userId = await seedCurrentData(database);
      await seedRetiredMetadata(database, userId);
      const before = await contentSnapshot(database);
      const constraints = await database.$queryRaw`
        SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='official_fitness_media'::regclass ORDER BY conname
      `;
      project = await createProject({
        '20261102120000_dependency_probe':
          'CREATE VIEW public.storage_cleanup_dependency AS SELECT created_at FROM public.idempotency_keys;\n',
      });
      await expect(initialize(url, database, project)).rejects.toThrow('当前数据库初始化失败');
      expect(await contentSnapshot(database)).toEqual(before);
      expect(
        await database.$queryRaw`
        SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='official_fitness_media'::regclass ORDER BY conname
      `,
      ).toEqual(constraints);
      expect(
        await database.$queryRaw`
        SELECT finished_at IS NULL AS failed FROM _prisma_migrations WHERE migration_name=${CLEANUP_MIGRATION}
      `,
      ).toEqual([{ failed: true }]);
    } catch (cause) {
      throw new Error('精简增量失败回滚验收失败', { cause });
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
      await expectRetiredColumnsAbsent(database);
      expect(await contentSnapshot(database, true)).toEqual(before);
      expect(await foreignKeySnapshot(database)).toEqual(foreignKeys.filter(({ name }) => !retiredKeys.includes(name)));
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
