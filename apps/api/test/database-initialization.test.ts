import { randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import {
  assertLifecycleSuite,
  createLifecycleDatabase,
  lifecycleDatabaseSpec,
  haltLifecycleRun,
} from './lifecycle-test-database.js';
import { runLifecycleSetup } from './lifecycle-setup.js';
import { expect, it } from 'vitest';
import { fitnessPreferences, fitnessTemplate, fitnessTime, fitnessWorkout } from './fitness-fixtures.js';
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

const INIT_MIGRATION = '20260916000000_init';
const CATEGORY_IDENTITY_INDEX_MIGRATION = '20260919000000_category_identity_index';
const FITNESS_WARMUP_REST_SECONDS_MIGRATION = '20260927000000_fitness_warmup_rest_seconds';
const FITNESS_REFERENCE_PREVIOUS_MIGRATION = '20261013000000_analytics_event_sequence';
const SYNC_CUTOVER_PREVIOUS_MIGRATION = '20261019000000_remove_transaction_stats_exclusion';
const SYNC_CURSOR_FLOOR_PREVIOUS_MIGRATION = '20261020000000_sync_protocol_cutover';
const PROBE_MIGRATION = '20990101000000_upgrade_probe';
const BROKEN_MIGRATION = '20990102000000_broken_probe';

/** 从正式迁移目录列出完整部署清单，结构内容仍由独立约束夹具验证。 */
function expectedAppliedMigrations() {
  try {
    return readdirSync(join(apiDirectory, 'prisma/migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .map((migration_name) => ({ migration_name, applied: true }));
  } catch (cause) {
    throw new Error('读取正式迁移清单失败', { cause });
  }
}

/** 释放夹具连接后执行真实部署入口，避免测试进程占用升级所需的独占窗口。 */
async function initialize(
  url: string,
  database: PrismaClient,
  setup = join(apiDirectory, 'prisma/setup.mjs'),
): Promise<void> {
  try {
    await database.$disconnect();
    await runLifecycleSetup(url, setup, apiDirectory);
  } catch (cause) {
    throw new Error('数据库迁移失败，请查看 Prisma 命令错误与输出', { cause });
  }
}

/** 使用版本间共有的物理列创建旧库账号，夹具不依赖当前 Prisma 新增字段。 */
async function createHistoricalUser(
  database: PrismaClient,
  phone: string,
  sesameNumber: string,
): Promise<{ id: string }> {
  try {
    const [user] = await database.$queryRaw<Array<{ id: string }>>`
      INSERT INTO users (id, phone_e164, sesame_number, password_hash)
      VALUES (${randomUUID()}::uuid, ${phone}, ${sesameNumber}, 'historical-upgrade-test')
      RETURNING id
    `;
    if (!user) throw new Error('旧库账号写入未返回身份');
    return user;
  } catch (cause) {
    throw new Error('旧版本数据库账号夹具创建失败', { cause });
  }
}

/** 写入迁移前后格式相同的同步事实，用独立事件验证持久切点与最新事件水位的区别。 */
async function createHistoricalSyncChange(database: PrismaClient, userId: string) {
  try {
    return await database.syncChange.create({
      data: {
        userId,
        scope: 'user',
        entityType: 'category',
        entityId: randomUUID(),
        action: 'upsert',
        mutationId: randomUUID(),
        deviceId: randomUUID(),
        payload: { name: '同步升级验收分类' },
        updatedAt: new Date('2026-10-19T12:00:00.000Z'),
      },
    });
  } catch (cause) {
    throw new Error('同步升级历史事件夹具创建失败', { cause });
  }
}

/**
 * 复制真实迁移历史到临时目录并追加探针迁移。
 *
 * 临时目录位于仓库 Temp，通过专属 node_modules 链接复用已安装的 Prisma CLI，
 * 增量升级验证走真实部署入口，且不改动仓库内的迁移历史。
 */
async function createUpgradeProject(migrations: Record<string, string>, throughMigration?: string): Promise<string> {
  let project: string | undefined;
  try {
    project = await createOwnedFixture('prisma-upgrade');
    const directory = join(project, 'prisma');
    const migrationDirectory = join(apiDirectory, 'prisma/migrations');
    await cp(join(apiDirectory, 'prisma'), directory, {
      recursive: true,
      // 旧版本只包含截止点及之前的迁移，后续新增迁移不会进入升级前的基线。
      filter: (source) => {
        const name = basename(source);
        return (
          throughMigration === undefined ||
          dirname(source) !== migrationDirectory ||
          !/^\d{14}_/.test(name) ||
          name <= throughMigration
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
    if (project) {
      try {
        await removeOwnedFixture(project);
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Owned upgrade fixture setup and cleanup failed.');
      }
    }
    throw new Error('临时迁移验收项目创建失败', { cause });
  }
}

/** 派生随机测试库并只清理本次创建的数据库，避免影响开发库。 */
async function withIsolatedDatabase(run: (url: string, database: PrismaClient) => Promise<void>): Promise<void> {
  const lease = await createLifecycleDatabase(lifecycleDatabaseSpec('migration', process.env), process.env);
  const failures: unknown[] = [];
  try {
    await run(lease.url, lease.prisma);
  } catch (error) {
    failures.push(error);
    try {
      haltLifecycleRun(process.env, 'Migration case or owned fixture cleanup failed.');
    } catch (haltError) {
      failures.push(haltError);
    }
  }
  try {
    await lease.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'Isolated migration case failed.');
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

/** 构造永久来源的三条旧写入路径，并保留跨账号同设备请求标识的独立占用。 */
async function prepareMutationReservationUpgrade(database: PrismaClient, ownerId: string) {
  try {
    const deviceId = randomUUID();
    const pendingMutation = randomUUID();
    const resolvedMutation = randomUUID();
    const resolutionMutation = randomUUID();
    const noChangeMutation = randomUUID();
    const category = await database.category.create({ data: { ownerId, name: '升级分类', kind: 'expense' } });
    const pending = await database.categoryConflict.create({
      data: {
        ownerId,
        categoryId: category.id,
        templateKey: 'upgrade-pending',
        sourceDeviceId: deviceId,
        sourceMutationId: pendingMutation,
        requestHash: 'a'.repeat(64),
        action: 'upsert',
        localPayload: {},
        localUpdatedAt: new Date(fitnessTime),
      },
    });
    const resolved = await database.categoryConflict.create({
      data: {
        ownerId,
        categoryId: category.id,
        templateKey: 'upgrade-resolved',
        sourceDeviceId: deviceId,
        sourceMutationId: resolvedMutation,
        requestHash: 'b'.repeat(64),
        action: 'upsert',
        localPayload: {},
        localUpdatedAt: new Date(fitnessTime),
        status: 'resolved',
        resolution: 'cloud',
        resolutionMutationId: resolutionMutation,
        resolutionHash: 'c'.repeat(64),
        resolutionResult: { accepted: true },
        resolvedAt: new Date(fitnessTime),
      },
    });
    const secondOwner = await database.user.create({
      data: { phoneE164: '+8613900000009', sesameNumber: '100000009', passwordHash: 'reservation-upgrade-test' },
    });
    const receipts = [];
    for (const [userId, requestHash] of [
      [ownerId, 'd'.repeat(64)],
      [secondOwner.id, 'e'.repeat(64)],
    ] as const) {
      receipts.push(
        await database.idempotencyKey.create({
          data: {
            userId,
            key: `category-source:${deviceId}:${noChangeMutation}`,
            requestHash,
            response: { accepted: true },
            expiresAt: new Date('9999-01-01T00:00:00.000Z'),
          },
        }),
      );
    }
    // 普通 HTTP 回执继续留在原表，不得随专用来源前缀一起清理。
    const httpReceipt = await database.idempotencyKey.create({
      data: {
        userId: ownerId,
        key: 'ordinary-http-receipt',
        requestHash: 'f'.repeat(64),
        response: {},
        expiresAt: new Date(fitnessTime),
      },
    });
    return {
      candidates: [pending, resolved],
      httpReceipt,
      reservations: [
        {
          scope: 'device',
          userId: ownerId,
          scopeId: deviceId,
          mutationId: pendingMutation,
          requestHash: pending.requestHash,
          createdAt: pending.createdAt,
        },
        {
          scope: 'device',
          userId: ownerId,
          scopeId: deviceId,
          mutationId: resolvedMutation,
          requestHash: resolved.requestHash,
          createdAt: resolved.createdAt,
        },
        {
          scope: 'account',
          userId: ownerId,
          scopeId: ownerId,
          mutationId: resolutionMutation,
          requestHash: resolved.resolutionHash,
          createdAt: resolved.resolvedAt,
        },
        ...receipts.map((receipt) => ({
          scope: 'device',
          userId: receipt.userId,
          scopeId: deviceId,
          mutationId: noChangeMutation,
          requestHash: receipt.requestHash,
          createdAt: receipt.createdAt,
        })),
      ],
    };
  } catch (cause) {
    throw new Error('永久请求占用升级夹具创建失败', { cause });
  }
}

/** 验证迁移保存来源、解决命令及跨账号边界，同时仅清理原有专用回执。 */
async function expectMutationReservationUpgrade(
  database: PrismaClient,
  before: Awaited<ReturnType<typeof prepareMutationReservationUpgrade>>,
): Promise<void> {
  try {
    expect(await database.mutationReservation.findMany()).toEqual(expect.arrayContaining(before.reservations));
    expect(await database.mutationReservation.count()).toBe(before.reservations.length);
    for (const candidate of before.candidates) {
      expect(await database.categoryConflict.findUniqueOrThrow({ where: { id: candidate.id } })).toEqual(candidate);
    }
    expect(await database.idempotencyKey.count({ where: { key: { startsWith: 'category-source:' } } })).toBe(0);
    expect(await database.idempotencyKey.findUniqueOrThrow({ where: { id: before.httpReceipt.id } })).toEqual(
      before.httpReceipt,
    );
  } catch (cause) {
    throw new Error('永久请求占用迁移未保留指纹、账号边界或回执范围', { cause });
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

it('已应用迁移被修改后拒绝部署，数据库数据保持原样', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let setup: string | undefined;
    try {
      await initialize(url, database);
      const appliedBefore = await database.$queryRaw`
        SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name
      `;
      setup = await createUpgradeProject({});
      const migration = join(dirname(setup), 'migrations', INIT_MIGRATION, 'migration.sql');
      await writeFile(migration, `${readFileSync(migration, 'utf8')}\n-- tampered history\n`);
      await expect(initialize(url, database, setup)).rejects.toThrow('数据库迁移失败');
      // 拒绝篡改后，逐条核对迁移身份、校验和与完成时间，确保历史没有被重写。
      expect(
        await database.$queryRaw`
          SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name
        `,
      ).toEqual(appliedBefore);
    } finally {
      if (setup) await removeOwnedFixture(dirname(dirname(setup)));
    }
  });
}, 180_000);

it('空库应用全部迁移，重复执行不重写已应用结构', async () => {
  await withIsolatedDatabase(async (url, database) => {
    try {
      await initialize(url, database);
      await expectCurrentDefinitions(database);
      await expectFitnessWarmupRestSeconds(database);
      await expectFitnessReferenceIndex(database);
      // 结构对象的 xmin 不变，证明重复执行不会重建函数、约束或索引。
      const objects = () => database.$queryRaw`
        SELECT oid, xmin::text FROM pg_class WHERE relnamespace = 'public'::regnamespace ORDER BY oid
      `;
      const before = await objects();
      const functions = () => database.$queryRaw`
        SELECT oid, xmin::text FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'fitness_payload_valid'
      `;
      const functionsBefore = await functions();
      const cutoverBefore = await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      expect(cutoverBefore).toMatchObject({
        syncCutoverCursor: 0n,
        syncCutoverAt: expect.any(Date),
        syncCursorFloor: 0n,
      });
      expect(await database.auditLog.count({ where: { action: 'sync.protocol_cutover' } })).toBe(1);
      await initialize(url, database);
      expect(await objects()).toEqual(before);
      expect(await functions()).toEqual(functionsBefore);
      expect(await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toEqual(cutoverBefore);
      expect(await database.auditLog.count({ where: { action: 'sync.protocol_cutover' } })).toBe(1);
      await expectCurrentDefinitions(database);
      expect(
        await database.$queryRawUnsafe(
          'SELECT migration_name, finished_at IS NOT NULL AS applied FROM _prisma_migrations ORDER BY migration_name',
        ),
      ).toEqual(expectedAppliedMigrations());
    } catch (cause) {
      throw new Error('空库迁移验收失败，请查看原始错误', { cause });
    }
  });
}, 180_000);

it('存量库部署自动固定同步切点，新增事件后重复部署仍保留原切点及审计', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let previousSetup: string | undefined;
    try {
      previousSetup = await createUpgradeProject({}, SYNC_CUTOVER_PREVIOUS_MIGRATION);
      await initialize(url, database, previousSetup);
      const user = await createHistoricalUser(database, '+8613900000061', '100000061');
      const first = await createHistoricalSyncChange(database, user.id);
      const latest = await createHistoricalSyncChange(database, user.id);
      const accountBefore = await database.user.findUniqueOrThrow({ where: { id: user.id } });
      const epochsBefore = await database.$queryRaw`
        SELECT auth_generation, idempotency_generation FROM server_epochs WHERE id = 0
      `;

      await initialize(url, database);

      const cutover = await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      expect(cutover).toMatchObject({
        syncCutoverCursor: latest.changeId,
        syncCutoverAt: expect.any(Date),
        syncCursorFloor: latest.changeId,
      });
      expect(await database.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(accountBefore);
      expect(await database.syncChange.findMany({ orderBy: { changeId: 'asc' } })).toEqual([first, latest]);
      expect(
        await database.$queryRaw`SELECT auth_generation, idempotency_generation FROM server_epochs WHERE id = 0`,
      ).toEqual(epochsBefore);
      const audit = await database.auditLog.findMany({ where: { action: 'sync.protocol_cutover' } });
      expect(audit).toHaveLength(1);

      // 发布后的事件水位可以增长，重跑部署只能读取第一次切换留下的持久事实。
      const later = await createHistoricalSyncChange(database, user.id);
      expect(later.changeId).toBeGreaterThan(latest.changeId);
      await initialize(url, database);
      expect(await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toEqual(cutover);
      expect(await database.auditLog.findMany({ where: { action: 'sync.protocol_cutover' } })).toEqual(audit);
      expect(await database.syncChange.findMany({ orderBy: { changeId: 'asc' } })).toEqual([first, latest, later]);
    } catch (cause) {
      throw new Error('存量库同步切点自动升级或幂等验收失败', { cause });
    } finally {
      if (previousSetup) await removeOwnedFixture(dirname(dirname(previousSetup)));
    }
  });
}, 180_000);

it('新增持久水位迁移使用较大的协议切点初始化，不推进协议切点', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let previousSetup: string | undefined;
    try {
      previousSetup = await createUpgradeProject({}, SYNC_CURSOR_FLOOR_PREVIOUS_MIGRATION);
      await initialize(url, database, previousSetup);
      const user = await createHistoricalUser(database, '+8613900000063', '100000063');
      const event = await createHistoricalSyncChange(database, user.id);
      const cutover = event.changeId + 10n;
      await database.$executeRaw`UPDATE server_epochs SET sync_cutover_cursor = ${cutover} WHERE id = 0`;
      const [before] = await database.$queryRaw<Array<{ cursor: bigint; completedAt: Date }>>`
          SELECT sync_cutover_cursor AS cursor, sync_cutover_at AS "completedAt" FROM server_epochs WHERE id = 0
        `;

      await initialize(url, database);

      const epoch = await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } });
      expect(epoch.syncCursorFloor).toBe(cutover);
      expect(epoch.syncCutoverCursor).toBe(before!.cursor);
      expect(epoch.syncCutoverAt).toEqual(before!.completedAt);
      expect(await database.syncChange.findMany()).toEqual([event]);
      await initialize(url, database);
      expect(await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toEqual(epoch);
    } catch (cause) {
      throw new Error('持久同步水位迁移初始化验收失败', { cause });
    } finally {
      if (previousSetup) await removeOwnedFixture(dirname(dirname(previousSetup)));
    }
  });
}, 180_000);

it.each(['其他连接', '审计失败'] as const)(
  '同步自动升级遇到%s时不写切点，解除阻碍后可以安全重试',
  async (scenario) => {
    await withIsolatedDatabase(async (url, database) => {
      let previousSetup: string | undefined;
      const otherConnection = new PrismaClient({ datasourceUrl: url });
      let auditTriggerCreated = false;
      try {
        previousSetup = await createUpgradeProject({}, SYNC_CUTOVER_PREVIOUS_MIGRATION);
        await initialize(url, database, previousSetup);
        const user = await createHistoricalUser(database, '+8613900000062', '100000062');
        const event = await createHistoricalSyncChange(database, user.id);
        const accountBefore = await database.user.findUniqueOrThrow({ where: { id: user.id } });
        if (scenario === '其他连接') {
          // 保留第二个数据库客户端，模拟尚未退出的服务；部署入口只能关闭自己的夹具连接。
          await otherConnection.$queryRaw`SELECT 1`;
        } else {
          await database.$executeRawUnsafe(`
            CREATE FUNCTION sync_upgrade_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.action = 'sync.protocol_cutover' THEN RAISE EXCEPTION '同步升级审计拒绝'; END IF;
              RETURN NEW;
            END $$
          `);
          await database.$executeRawUnsafe(`
            CREATE TRIGGER sync_upgrade_reject_audit BEFORE INSERT ON audit_logs
            FOR EACH ROW EXECUTE FUNCTION sync_upgrade_reject_audit()
          `);
          auditTriggerCreated = true;
        }

        await expect(initialize(url, database)).rejects.toThrow('数据库迁移失败');

        expect(await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toMatchObject({
          syncCutoverCursor: null,
          syncCutoverAt: null,
        });
        expect(await database.auditLog.count({ where: { action: 'sync.protocol_cutover' } })).toBe(0);
        expect(await database.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(accountBefore);
        expect(await database.syncChange.findMany()).toEqual([event]);

        await otherConnection.$disconnect();
        if (auditTriggerCreated) {
          await database.$executeRawUnsafe('DROP TRIGGER sync_upgrade_reject_audit ON audit_logs');
          await database.$executeRawUnsafe('DROP FUNCTION sync_upgrade_reject_audit()');
          auditTriggerCreated = false;
        }
        await initialize(url, database);
        expect(await database.serverEpoch.findUniqueOrThrow({ where: { id: 0 } })).toMatchObject({
          syncCutoverCursor: event.changeId,
          syncCutoverAt: expect.any(Date),
        });
        expect(await database.auditLog.count({ where: { action: 'sync.protocol_cutover' } })).toBe(1);
      } catch (cause) {
        throw new Error(`同步自动升级${scenario}保护验收失败`, { cause });
      } finally {
        await otherConnection.$disconnect();
        if (previousSetup) await removeOwnedFixture(dirname(dirname(previousSetup)));
      }
    });
  },
  180_000,
);

it('来源索引和永久请求占用升级回填历史数据，保留实体与账号身份', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let previousSetup: string | undefined;
    try {
      previousSetup = await createUpgradeProject({}, FITNESS_REFERENCE_PREVIOUS_MIGRATION);
      await initialize(url, database, previousSetup);
      const user = await database.user.create({
        data: { phoneE164: '+8613900000008', sesameNumber: '100000008', passwordHash: 'reference-upgrade-test' },
      });
      const space = await database.fitnessSpace.create({
        data: {
          id: randomUUID(),
          ownerId: user.id,
          name: '来源索引升级空间',
          createdAt: new Date(fitnessTime),
          updatedAt: new Date(fitnessTime),
        },
      });
      const targetId = randomUUID();
      const sourceId = randomUUID();
      const before = await database.fitnessEntity.create({
        data: {
          id: sourceId,
          fitnessSpaceId: space.id,
          entityType: 'fitness_workout',
          status: 'scheduled',
          payload: { ...fitnessWorkout(), source_kind: 'template', source_template_id: targetId },
          createdAt: new Date(fitnessTime),
          updatedAt: new Date(fitnessTime),
        },
      });
      const reservations = await prepareMutationReservationUpgrade(database, user.id);
      const history = await database.$queryRaw`
        SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name
      `;
      await initialize(url, database);
      expect(await database.fitnessEntity.findUniqueOrThrow({ where: { id: sourceId } })).toEqual(before);
      expect(
        await database.$queryRaw`SELECT entity_id, target_id FROM fitness_entity_references WHERE entity_id = ${sourceId}::uuid`,
      ).toEqual([{ entity_id: sourceId, target_id: targetId }]);
      await database.fitnessEntity.create({
        data: {
          id: targetId,
          fitnessSpaceId: space.id,
          entityType: 'fitness_template',
          payload: fitnessTemplate(),
          createdAt: new Date(fitnessTime),
          updatedAt: new Date(fitnessTime),
        },
      });
      expect(
        await database.$queryRaw`
          SELECT migration_name, checksum, finished_at FROM _prisma_migrations
          WHERE migration_name <= ${FITNESS_REFERENCE_PREVIOUS_MIGRATION} ORDER BY migration_name
        `,
      ).toEqual(history);
      await expectFitnessReferenceIndex(database);
      await expectCurrentDefinitions(database);
      await expectMutationReservationUpgrade(database, reservations);
    } catch (cause) {
      throw new Error('健身来源关系增量迁移验收失败', { cause });
    } finally {
      if (previousSetup) await removeOwnedFixture(dirname(dirname(previousSetup)));
    }
  });
}, 180_000);

it.each(['额外分段', '大小写折叠指纹冲突'] as const)(
  '永久来源迁移拒绝%s并保留原回执',
  async (scenario) => {
    await withIsolatedDatabase(async (url, database) => {
      let previousSetup: string | undefined;
      try {
        previousSetup = await createUpgradeProject({}, '20261013001000_fitness_reference_index');
        await initialize(url, database, previousSetup);
        const user = await createHistoricalUser(database, '+8613900000007', '100000007');
        const device = 'aaaaaaaa-1111-4111-8111-111111111111';
        const mutation = 'bbbbbbbb-2222-4222-8222-222222222222';
        const entries =
          scenario === '额外分段'
            ? [{ key: `category-source:${device}:${mutation}:extra`, requestHash: 'a'.repeat(64) }]
            : [
                { key: `category-source:${device}:${mutation}`, requestHash: 'a'.repeat(64) },
                {
                  key: `category-source:${device.toUpperCase()}:${mutation.toUpperCase()}`,
                  requestHash: 'b'.repeat(64),
                },
              ];
        for (const entry of entries)
          await database.idempotencyKey.create({
            data: {
              ...entry,
              userId: user.id,
              response: { accepted: true },
              expiresAt: new Date('9999-01-01T00:00:00.000Z'),
            },
          });
        const before = await database.idempotencyKey.findMany({ orderBy: { id: 'asc' } });
        await expect(initialize(url, database)).rejects.toThrow();
        expect(await database.idempotencyKey.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
        expect(await database.$queryRaw`SELECT to_regclass('public.mutation_reservations')::text AS name`).toEqual([
          { name: null },
        ]);
        expect(
          await database.$queryRaw`
        SELECT finished_at IS NULL AS rejected FROM _prisma_migrations
        WHERE migration_name = '20261013002000_mutation_reservations'
      `,
        ).toEqual([{ rejected: true }]);
      } catch (cause) {
        throw new Error('非法永久来源升级拒绝验收失败', { cause });
      } finally {
        if (previousSetup) await removeOwnedFixture(dirname(dirname(previousSetup)));
      }
    });
  },
  180_000,
);

it('已有健身偏好的上一版本升级后保留数据，并允许保存默认热身休息时间', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let previousSetup: string | undefined;
    try {
      previousSetup = await createUpgradeProject({}, CATEGORY_IDENTITY_INDEX_MIGRATION);
      await initialize(url, database, previousSetup);
      const user = await createHistoricalUser(database, '+8613900000001', '100000001');
      const space = await database.fitnessSpace.create({
        data: {
          id: randomUUID(),
          ownerId: user.id,
          name: '升级健身空间',
          createdAt: new Date(fitnessTime),
          updatedAt: new Date(fitnessTime),
        },
      });
      const payload = fitnessPreferences();
      const before = await database.fitnessEntity.create({
        data: {
          id: space.id,
          fitnessSpaceId: space.id,
          entityType: 'fitness_preferences',
          payload,
          createdAt: new Date(fitnessTime),
          updatedAt: new Date(fitnessTime),
        },
      });
      const withWarmup = { ...payload, default_warmup_rest_seconds: 30 };
      expect(
        await database.$queryRaw`SELECT fitness_payload_valid('fitness_preferences', ${JSON.stringify(withWarmup)}::jsonb) AS valid`,
      ).toEqual([{ valid: false }]);
      const existingHistory = await database.$queryRaw`
        SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name
      `;

      await initialize(url, database);

      expect(await database.fitnessEntity.findUniqueOrThrow({ where: { id: space.id } })).toEqual(before);
      expect(
        await database.$queryRaw`
          SELECT migration_name, checksum, finished_at FROM _prisma_migrations
          WHERE migration_name <= ${CATEGORY_IDENTITY_INDEX_MIGRATION} ORDER BY migration_name
        `,
      ).toEqual(existingHistory);
      await expectCurrentDefinitions(database);
      await expectFitnessWarmupRestSeconds(database);
      const updated = await database.fitnessEntity.update({
        where: { id: space.id },
        data: { payload: withWarmup, updatedAt: new Date(fitnessTime), revision: { increment: 1 } },
      });
      expect(updated.payload).toEqual(withWarmup);
      expect(updated.createdAt).toEqual(before.createdAt);
      expect(updated.revision).toBe(before.revision + 1);
    } catch (cause) {
      throw new Error('健身默认热身休息增量升级验收失败', { cause });
    } finally {
      if (previousSetup) await removeOwnedFixture(dirname(dirname(previousSetup)));
    }
  });
}, 180_000);

it('旧 TEXT 标题升级为 JSON 字符串时逐字保留标题、正文、版本和时间', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let previousSetup: string | undefined;
    try {
      previousSetup = await createUpgradeProject({}, FITNESS_WARMUP_REST_SECONDS_MIGRATION);
      await initialize(url, database, previousSetup);
      const user = await createHistoricalUser(database, '+8613900000002', '100000001');
      const createdAt = '2020-01-02T03:04:05.006Z';
      const updatedAt = '2021-02-03T04:05:06.789Z';
      const titles = ['', '  引号"与字面\\u0000、\\n é😀  ', '\t多行\n标题\r'];
      const entryIds: string[] = [];
      for (const type of ['normal', 'credentials']) {
        const book = await database.memoBook.create({
          data: {
            id: randomUUID(),
            ownerId: user.id,
            name: '旧标题升级',
            type,
            createdAt: new Date(createdAt),
            updatedAt: new Date(updatedAt),
          },
        });
        for (const [index, title] of titles.entries()) {
          const id = randomUUID();
          const body =
            type === 'normal'
              ? { ops: [{ insert: '原始正文\u0000与字面\\u0000\n' }] }
              : { fields: [{ label: '密码', value: '原始\u0000与字面\\u0000' }] };
          // 旧列是 TEXT，直接绑定原始标题，避免新 Prisma JSON 类型预先给标题加引号。
          await database.$executeRaw`
            INSERT INTO memo_entries
              (id, memo_book_id, book_type, title, body_format, body, order_key, revision, created_at, updated_at)
            VALUES (${id}::uuid, ${book.id}::uuid, ${type}, ${title}, ${type === 'normal' ? 'delta_v1' : 'fields_v1'},
              ${JSON.stringify(body)}::json, ${type === 'normal' ? null : BigInt(index)}::bigint,
              7, ${createdAt}::timestamptz, ${updatedAt}::timestamptz)
          `;
          entryIds.push(id);
        }
      }
      const before = await database.$queryRaw`
        SELECT id, memo_book_id, book_type, title, body_format, body, order_key, revision, created_at, updated_at, deleted_at
        FROM memo_entries ORDER BY id
      `;
      const history = await database.$queryRaw`
        SELECT migration_name, checksum, finished_at FROM _prisma_migrations ORDER BY migration_name
      `;

      await initialize(url, database);

      expect(
        await database.$queryRaw`
          SELECT id, memo_book_id, book_type, title, body_format, body, order_key, revision, created_at, updated_at, deleted_at
          FROM memo_entries ORDER BY id
        `,
      ).toEqual(before);
      expect(
        await database.$queryRaw`
          SELECT migration_name, checksum, finished_at FROM _prisma_migrations
          WHERE migration_name <= ${FITNESS_WARMUP_REST_SECONDS_MIGRATION} ORDER BY migration_name
        `,
      ).toEqual(history);
      await expectCurrentDefinitions(database);
      for (const invalid of [null, true, 30, [], {}]) {
        await expect(database.$executeRaw`
          UPDATE memo_entries SET title = ${JSON.stringify(invalid)}::json WHERE id = ${entryIds[0]}::uuid
        `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
      }
      expect(
        await database.$queryRaw`
          SELECT id, memo_book_id, book_type, title, body_format, body, order_key, revision, created_at, updated_at, deleted_at
          FROM memo_entries ORDER BY id
        `,
      ).toEqual(before);
    } catch (cause) {
      throw new Error('备忘录标题无损迁移验收失败', { cause });
    } finally {
      if (previousSetup) await removeOwnedFixture(dirname(dirname(previousSetup)));
    }
  });
}, 180_000);

it('已有数据的库增量升级保留数据，失败迁移不丢数据且不记为已应用', async () => {
  await withIsolatedDatabase(async (url, database) => {
    let project: string | undefined;
    let previousSetup: string | undefined;
    try {
      previousSetup = await createUpgradeProject({}, '20261029002000_banner_analytics');
      await initialize(url, database, previousSetup);
      const imageId = 'a'.repeat(64);
      const oldTime = new Date('2026-10-29T01:00:00Z');
      await database.$executeRaw`
        INSERT INTO app_banner_media (id,file_name,byte_size,width,height)
        VALUES (${imageId},'previous-banner.webp',100,600,200)
      `;
      await database.$executeRaw`
        INSERT INTO app_banners (slot,image_id,target,is_enabled,version,updated_at)
        VALUES ('fitness-plan-library',${imageId},'fitness-plan-library',true,7,${oldTime}),
          ('fitness-template-library',NULL,'fitness-template-library',false,3,${oldTime})
      `;
      const previousEventId = randomUUID();
      await database.$executeRaw`
        INSERT INTO product_analytics_events
          (actor_key,event_id,kind,occurred_at,platform,page_id,event_name,banner_slot,banner_source,banner_version)
        VALUES (${'b'.repeat(64)},${previousEventId}::uuid,'action',${oldTime},'app','fitness.plans',
          'banner_impression','fitness-plan-library','remote',7)
      `;
      await initialize(url, database);
      const migrated = await database.appBanner.findMany({ orderBy: { slot: 'asc' } });
      expect(migrated).toHaveLength(2);
      expect(migrated[0]).toMatchObject({
        slot: 'fitness-plan-library',
        imageId,
        target: 'fitness-plan-library',
        targetId: null,
        version: 7,
        sortOrder: 0,
        isEnabled: true,
        deletedAt: null,
        updatedAt: oldTime,
      });
      expect(migrated[0]!.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(migrated[1]).toMatchObject({ version: 3, isEnabled: false, deletedAt: oldTime });
      expect(
        (await database.productAnalyticsEvent.findFirstOrThrow({ where: { eventId: previousEventId } })).bannerId,
      ).toBeNull();
      await initialize(url, database);
      expect(await database.appBanner.findMany({ orderBy: { slot: 'asc' } })).toEqual(migrated);
      await database.$executeRawUnsafe(
        `INSERT INTO users (id, phone_e164, sesame_number, password_hash, created_at)
         VALUES (gen_random_uuid(), '+8613900000000', '100000001', 'probe-hash', now())`,
      );
      project = await createUpgradeProject({
        [PROBE_MIGRATION]: 'ALTER TABLE "users" ADD COLUMN "upgrade_probe" TEXT;\n',
        [BROKEN_MIGRATION]: 'ALTER TABLE "users" DROP COLUMN "phone_e164";\nSELECT 1 / 0;\n',
      });
      // 探针迁移通过后失败迁移中断部署：命令必须以失败结束。
      await expect(initialize(url, database, project)).rejects.toThrow();
      expect(await database.$queryRawUnsafe('SELECT phone_e164, upgrade_probe FROM users')).toEqual([
        { phone_e164: '+8613900000000', upgrade_probe: null },
      ]);
      expect(
        await database.$queryRawUnsafe(
          'SELECT migration_name, finished_at IS NOT NULL AS applied FROM _prisma_migrations ORDER BY migration_name',
        ),
      ).toEqual([
        ...expectedAppliedMigrations(),
        { migration_name: PROBE_MIGRATION, applied: true },
        { migration_name: BROKEN_MIGRATION, applied: false },
      ]);
    } catch (cause) {
      throw new Error('增量迁移验收失败，请查看原始错误', { cause });
    } finally {
      if (project) await removeOwnedFixture(dirname(dirname(project)));
      if (previousSetup) await removeOwnedFixture(dirname(dirname(previousSetup)));
    }
  });
}, 180_000);
