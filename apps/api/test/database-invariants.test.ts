import { testFixtureDatabaseUrl } from './existing-test-database.js';
import { randomInt, randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = testFixtureDatabaseUrl();

class RollbackProbe extends Error {}

let prisma: PrismaClient;

type DatabaseDiagnostic = {
  sqlState: string;
  message: string;
  constraint: string;
  table: string;
  column: string;
};

/** 在失败语句的保存点回滚后读取 PostgreSQL 原始诊断，不依赖驱动对 DETAIL 的包装方式。 */
async function diagnoseStatement(tx: Prisma.TransactionClient, args: unknown[]): Promise<DatabaseDiagnostic> {
  const first = args[0];
  const statement =
    typeof first === 'string'
      ? { text: first, values: args.slice(1) }
      : Array.isArray(first)
        ? Prisma.sql(first as unknown as TemplateStringsArray, ...args.slice(1))
        : (first as Prisma.Sql);
  // 由 PostgreSQL 自己引用每个绑定值，UUID、空值、数字与带引号文本均保留真实 SQL 语义。
  const format = statement.text.replaceAll('%', '%%').replace(/\$(\d+)/g, '%$1$L');
  const rows = await tx.$queryRaw<Array<{ literal: string }>>(
    Prisma.sql`SELECT quote_literal(format(${format}${
      statement.values.length
        ? Prisma.sql`, ${Prisma.join(statement.values.map((value) => Prisma.sql`${value}::text`))}`
        : Prisma.empty
    })) AS literal`,
  );
  const delimiter = `$diagnostic_${randomUUID().replaceAll('-', '')}$`;
  try {
    // 匿名块只重放这一条失败语句；其异常子事务及外层探针最终都会回滚，不创建数据库对象。
    await tx.$executeRawUnsafe(`DO ${delimiter}
      DECLARE state text; primary_message text; constraint_name text; table_name text; column_name text;
      BEGIN
        EXECUTE ${rows[0]!.literal};
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE, primary_message = MESSAGE_TEXT,
          constraint_name = CONSTRAINT_NAME, table_name = TABLE_NAME, column_name = COLUMN_NAME;
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invariant diagnostics',
          DETAIL = json_build_object('sqlState', state, 'message', primary_message,
            'constraint', constraint_name, 'table', table_name, 'column', column_name)::text;
      END ${delimiter}`);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && typeof error.meta?.message === 'string') {
      try {
        const detailMarker = '\nDETAIL: ';
        const detailAt = error.meta.message.lastIndexOf(detailMarker);
        const serialized = detailAt < 0 ? error.meta.message : error.meta.message.slice(detailAt + detailMarker.length);
        return JSON.parse(serialized) as DatabaseDiagnostic;
      } catch (parseError) {
        throw new Error(`PostgreSQL 约束诊断不是完整 JSON：${error.meta.message}`, { cause: parseError });
      }
    }
    throw new Error('读取 PostgreSQL 约束诊断失败。', { cause: error });
  }
  throw new Error('失败语句重放时意外成功，不能确认目标数据库约束。');
}

/** 保留成功原始查询，仅为失败的原始 SQL 补充结构化约束身份。 */
function diagnosticTransaction(tx: Prisma.TransactionClient): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (!['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe'].includes(String(property)))
        return value;
      return async (...args: unknown[]) => {
        await tx.$executeRawUnsafe('SAVEPOINT invariant_statement');
        try {
          const result = await Reflect.apply(value as (...args: unknown[]) => Promise<unknown>, target, args);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT invariant_statement');
          return result;
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') throw error;
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT invariant_statement');
          const diagnostic = await diagnoseStatement(tx, args);
          expect(diagnostic.sqlState, '重放必须命中同一 PostgreSQL SQLSTATE').toBe(error.meta?.code);
          error.meta = {
            ...error.meta,
            message: diagnostic.message,
            constraint: diagnostic.constraint,
            table: diagnostic.table,
            column: diagnostic.column,
          };
          throw error;
        }
      };
    },
  });
}

beforeAll(() => {
  prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** 在事务中执行探针并强制回滚，避免数据库不变量测试污染共享测试库。 */
async function probe<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      result = await operation(diagnosticTransaction(tx));
      throw new RollbackProbe();
    });
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error;
  }
  return result as T;
}

/** 断言非法写入由 PostgreSQL 自身拒绝；若写入成功则主动回滚后令测试失败。 */
async function expectDatabaseRejects(
  sqlState: string,
  message: string | RegExp,
  operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<void> {
  const identity: Record<string, unknown> = {};
  if (typeof message === 'string' && ['23503', '23505', '23514'].includes(sqlState) && /^\w+$/.test(message)) {
    identity.constraint = message;
  }
  const requiredColumn = typeof message === 'string' ? /^column "([^"]+)" of relation "([^"]+)"$/.exec(message) : null;
  if (requiredColumn) {
    identity.column = requiredColumn[1];
    identity.table = requiredColumn[2];
  }
  // 合法写入仍由 probe 主动回滚；仅目标 SQLSTATE 和约束/触发器消息匹配时才通过。
  await expect(probe(operation)).rejects.toMatchObject({
    code: 'P2010',
    meta: {
      code: sqlState,
      message: typeof message === 'string' ? expect.stringContaining(message) : expect.stringMatching(message),
      ...identity,
    },
  });
}

/** 强制执行事务末尾才校验的延迟约束，并断言非法写入由 PostgreSQL 拒绝。 */
async function expectDeferredDatabaseRejects(
  sqlState: string,
  message: string | RegExp,
  operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<void> {
  await expectDatabaseRejects(sqlState, message, async (tx) => {
    await operation(tx);
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  });
}

/** 创建最小用户夹具，所有调用都位于最终会回滚的探针事务中。 */
async function seedUser(tx: Prisma.TransactionClient, id = randomUUID()): Promise<string> {
  let identity: string | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = String(randomInt(100_000_000, 1_000_000_000));
    if (
      !(await tx.user.findFirst({
        where: { OR: [{ sesameNumber: candidate }, { phoneE164: `+861${candidate}` }] },
        select: { id: true },
      }))
    ) {
      identity = candidate;
      break;
    }
  }
  if (!identity) throw new Error('Could not find an unused invariant-test identity.');
  await tx.$executeRaw`
    INSERT INTO "users" ("id", "phone_e164", "sesame_number", "password_hash")
    VALUES (${id}::uuid, ${`+861${identity}`}, ${identity}, 'test')
  `;
  return id;
}

/** 创建最小设备夹具，用于验证设备归属和审计外键。 */
async function seedDevice(tx: Prisma.TransactionClient, userId: string, id = randomUUID()): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO "devices" ("id", "user_id", "installation_id")
    VALUES (${id}::uuid, ${userId}::uuid, ${randomUUID()}::uuid)
  `;
  return id;
}

/** 创建不包含 Owner 成员行的最小账本夹具，并提供必填的同步身份。 */
async function seedLedger(
  tx: Prisma.TransactionClient,
  ownerId: string,
  id = randomUUID(),
  syncId = randomUUID(),
): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO "ledgers" ("id", "sync_id", "owner_id", "name", "updated_at")
    VALUES (${id}::uuid, ${syncId}::uuid, ${ownerId}::uuid, '数据库不变量测试', CURRENT_TIMESTAMP)
  `;
  return id;
}

/** 创建最小成员行夹具；REGISTERED 成员 ID 由数据库端 UUIDv5 公式派生，满足持续约束。 */
async function seedMember(
  tx: Prisma.TransactionClient,
  ledgerId: string,
  userId: string,
  role: 'owner' | 'editor' = 'editor',
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "ledger_members" ("id", "ledger_id", "display_name", "member_type", "linked_account_id", "role", "status", "updated_at")
    VALUES (
      uuid_generate_v5(${ledgerId}::uuid, 'user:' || ${userId}),
      ${ledgerId}::uuid, '测试成员', 'REGISTERED'::"LedgerMemberType", ${userId}::uuid, ${role}::"LedgerMemberRole", 'ACTIVE'::"LedgerMemberStatus", CURRENT_TIMESTAMP
    )
    RETURNING "id"::text AS "id"
  `;
  return rows[0]!.id;
}

/** 创建最小交易夹具，为分摊关系测试提供稳定父记录。 */
async function seedTransaction(
  tx: Prisma.TransactionClient,
  ledgerId: string,
  id = randomUUID(),
  memberReferences: {
    createdByMemberId?: string;
    lastEditedByMemberId?: string;
    payerMemberId?: string;
  } = {},
): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO "transactions" (
      "id", "ledger_id", "owner_id", "tx_type", "amount", "happened_at", "currency_code", "native_amount", "aa_mode",
      "created_by_member_id", "last_edited_by_member_id", "payer_member_id", "updated_at"
    ) VALUES (
      ${id}::uuid, ${ledgerId}::uuid,
      (SELECT "owner_id" FROM "ledgers" WHERE "id" = ${ledgerId}::uuid),
      'expense', 10, CURRENT_TIMESTAMP, 'CNY', 10, 2,
      ${memberReferences.createdByMemberId ?? null}::uuid,
      ${memberReferences.lastEditedByMemberId ?? null}::uuid,
      ${memberReferences.payerMemberId ?? null}::uuid,
      CURRENT_TIMESTAMP
    )
  `;
  return id;
}

/** 创建两个独立业务域及域内合法关系，供复合外键越域探针复用。 */
async function seedRelationDomains(tx: Prisma.TransactionClient): Promise<{
  childCategoryId: string;
  foreignCategoryId: string;
  recurringId: string;
  foreignRecurringId: string;
  transactionId: string;
  foreignMemberId: string;
}> {
  const ownerId = await seedUser(tx);
  const foreignOwnerId = await seedUser(tx);
  const ledgerId = await seedLedger(tx, ownerId);
  const foreignLedgerId = await seedLedger(tx, foreignOwnerId);
  const ownerMemberId = await seedMember(tx, ledgerId, ownerId, 'owner');
  const foreignMemberId = await seedMember(tx, foreignLedgerId, foreignOwnerId, 'owner');
  const categoryId = randomUUID();
  const childCategoryId = randomUUID();
  const foreignCategoryId = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "categories" ("id", "owner_id", "name", "kind", "level", "sort_order", "parent_id", "updated_at")
    VALUES
      (${categoryId}::uuid, ${ownerId}::uuid, '域内父分类', 'expense', 1, 0, NULL, CURRENT_TIMESTAMP),
      (${childCategoryId}::uuid, ${ownerId}::uuid, '域内子分类', 'expense', 2, 0, ${categoryId}::uuid, CURRENT_TIMESTAMP),
      (${foreignCategoryId}::uuid, ${foreignOwnerId}::uuid, '外域分类', 'expense', 1, 0, NULL, CURRENT_TIMESTAMP)
  `;
  const recurringId = randomUUID();
  const foreignRecurringId = randomUUID();
  await tx.$executeRaw`
    INSERT INTO "recurring_transactions" (
      "id", "ledger_id", "owner_id", "tx_type", "amount", "currency_code", "category_id",
      "frequency", "interval", "start_date", "enabled", "updated_at"
    ) VALUES
      (${recurringId}::uuid, ${ledgerId}::uuid, ${ownerId}::uuid, 'expense', 1, 'CNY', ${categoryId}::uuid,
       'monthly', 1, CURRENT_TIMESTAMP, true, CURRENT_TIMESTAMP),
      (${foreignRecurringId}::uuid, ${foreignLedgerId}::uuid, ${foreignOwnerId}::uuid, 'expense', 1, 'CNY', ${foreignCategoryId}::uuid,
       'monthly', 1, CURRENT_TIMESTAMP, true, CURRENT_TIMESTAMP)
  `;
  const transactionId = await seedTransaction(tx, ledgerId, randomUUID(), {
    createdByMemberId: ownerMemberId,
    lastEditedByMemberId: ownerMemberId,
    payerMemberId: ownerMemberId,
  });
  await tx.$executeRaw`
    UPDATE "transactions"
    SET "category_id" = ${categoryId}::uuid, "recurring_id" = ${recurringId}::uuid
    WHERE "id" = ${transactionId}::uuid
  `;
  await tx.$executeRaw`
    INSERT INTO "transaction_edit_history" (
      "id", "transaction_id", "ledger_id", "version", "operator_member_id", "changes"
    ) VALUES (${randomUUID()}::uuid, ${transactionId}::uuid, ${ledgerId}::uuid, 1, ${ownerMemberId}::uuid, '{}'::jsonb)
  `;
  return {
    childCategoryId,
    foreignCategoryId,
    recurringId,
    foreignRecurringId,
    transactionId,
    foreignMemberId,
  };
}

describe('数据库冻结不变量', () => {
  it('同步持久水位不得为负数', async () => {
    await expectDatabaseRejects('23514', 'server_epochs_sync_cursor_floor_check', async (tx) => {
      await tx.$executeRaw`UPDATE server_epochs SET sync_cursor_floor = -1 WHERE id = 0`;
    });
  });

  it('同步切点与完成时间成对存在，切点不得为负数', async () => {
    for (const [cursor, completedAt] of [
      [null, new Date()],
      [1n, null],
      [-1n, new Date()],
    ] as const) {
      await expectDatabaseRejects('23514', 'server_epochs_sync_cutover_check', async (tx) => {
        await tx.$executeRaw`UPDATE server_epochs SET sync_cutover_cursor = ${cursor}, sync_cutover_at = ${completedAt} WHERE id = 0`;
      });
    }
  });

  it.each([
    ['categories', 'kind', 'childCategoryId', 'categories_kind_check'],
    ['transactions', 'tx_type', 'transactionId', 'transactions_type_check'],
    ['transactions', 'category_kind', 'transactionId', 'transactions_category_kind_check'],
    ['recurring_transactions', 'tx_type', 'recurringId', 'recurring_transactions_type_check'],
  ] as const)('只允许支出：数据库拒绝 %s.%s 的非支出值', async (table, column, idKey, constraint) => {
    for (const invalidType of ['income', 'transfer']) {
      await expect(
        probe(async (tx) => {
          const ids = await seedRelationDomains(tx);
          await tx.$executeRawUnsafe(
            `UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2::uuid`,
            invalidType,
            ids[idKey],
          );
        }),
      ).rejects.toMatchObject({
        code: 'P2010',
        meta: { code: '23514', message: expect.stringContaining(constraint) },
      });
    }
  });

  it('用户资料数据库定义只保留支出设置', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_profiles' AND column_name = 'income_is_red'
    `;
    expect(columns).toEqual([]);
  });

  it('迁移后的表、列、约束和 append-only 触发器完整存在', async () => {
    const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT "table_name"
      FROM "information_schema"."tables"
      WHERE "table_schema" = 'public'
        AND "table_name" IN ('transaction_splits', 'audit_logs', 'personal_access_tokens')
      ORDER BY "table_name"
    `;
    expect(tables.map((row) => row.table_name)).toEqual(['audit_logs', 'transaction_splits']);

    const userIdentityColumns = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT "column_name", "is_nullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'users'
        AND "column_name" IN ('phone_e164', 'sesame_number')
      ORDER BY "column_name"
    `;
    expect(userIdentityColumns).toEqual([
      { column_name: 'phone_e164', is_nullable: 'NO' },
      { column_name: 'sesame_number', is_nullable: 'NO' },
    ]);

    const categoryColumns = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT "column_name", "is_nullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'categories'
        AND "column_name" IN ('level', 'sort_order', 'parent_name')
      ORDER BY "column_name"
    `;
    expect(categoryColumns).toEqual([
      { column_name: 'level', is_nullable: 'NO' },
      { column_name: 'sort_order', is_nullable: 'NO' },
    ]);
    const splitColumns = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT "column_name", "is_nullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'transaction_splits'
        AND "column_name" = 'ledger_id'
    `;
    expect(splitColumns).toEqual([{ column_name: 'ledger_id', is_nullable: 'NO' }]);
    const domainColumns = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; is_nullable: string }>
    >`
      SELECT "table_name", "column_name", "is_nullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND (
          ("table_name" = 'transactions' AND "column_name" = 'owner_id')
          OR ("table_name" = 'recurring_transactions' AND "column_name" = 'owner_id')
          OR ("table_name" = 'transaction_edit_history' AND "column_name" = 'ledger_id')
        )
      ORDER BY "table_name", "column_name"
    `;
    expect(domainColumns).toEqual([
      { table_name: 'recurring_transactions', column_name: 'owner_id', is_nullable: 'NO' },
      { table_name: 'transaction_edit_history', column_name: 'ledger_id', is_nullable: 'NO' },
      { table_name: 'transactions', column_name: 'owner_id', is_nullable: 'NO' },
    ]);
    // 账本成员以成员行承载身份：ledger_members 不含 user_id 列
    const memberColumns = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT "column_name", "is_nullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'ledger_members'
        AND "column_name" IN (
          'id', 'display_name', 'member_type', 'linked_account_id', 'user_id', 'status', 'updated_by_device_id'
        )
      ORDER BY "column_name"
    `;
    expect(memberColumns).toEqual([
      { column_name: 'display_name', is_nullable: 'NO' },
      { column_name: 'id', is_nullable: 'NO' },
      { column_name: 'linked_account_id', is_nullable: 'YES' },
      { column_name: 'member_type', is_nullable: 'NO' },
      { column_name: 'status', is_nullable: 'NO' },
      { column_name: 'updated_by_device_id', is_nullable: 'YES' },
    ]);
    // 邀请作废标记列：revoked_at 可空、默认无值
    const inviteColumns = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT "column_name", "is_nullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'ledger_invites'
        AND "column_name" IN ('revoked_at', 'used_at')
      ORDER BY "column_name"
    `;
    expect(inviteColumns).toEqual([
      { column_name: 'revoked_at', is_nullable: 'YES' },
      { column_name: 'used_at', is_nullable: 'YES' },
    ]);

    const expectedConstraints = [
      'categories_parent_owner_fkey',
      'categories_updated_by_device_id_fkey',
      'exchange_rate_overrides_updated_by_device_id_fkey',
      'ledger_invites_used_by_id_fkey',
      'ledger_members_linked_account_id_fkey',
      'ledger_members_type_account_check',
      'ledger_members_updated_by_device_id_fkey',
      'ledgers_updated_by_device_id_fkey',
      'recurring_transactions_category_owner_fkey',
      'recurring_transactions_ledger_owner_fkey',
      'recurring_transactions_updated_by_device_id_fkey',
      'refresh_tokens_device_id_user_id_fkey',
      'transaction_created_by_member_fkey',
      'transaction_edit_history_transaction_ledger_fkey',
      'transaction_edit_operator_member_fkey',
      'transaction_last_edited_by_member_fkey',
      'transaction_payer_member_fkey',
      'transaction_split_member_fkey',
      'transaction_splits_transaction_id_fkey',
      'transactions_category_owner_fkey',
      'transactions_ledger_owner_fkey',
      'transactions_recurring_ledger_fkey',
      'transactions_updated_by_device_id_fkey',
      'user_profiles_avatar_version_check',
    ];
    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT "conname"
      FROM "pg_constraint"
      WHERE "connamespace" = 'public'::regnamespace
        AND "conname" = ANY(${expectedConstraints}::text[])
      ORDER BY "conname"
    `;
    expect(constraints.map((row) => row.conname)).toEqual(expectedConstraints);

    const memberReferenceConstraints = await prisma.$queryRaw<Array<{ conname: string; definition: string }>>`
      SELECT "conname", pg_get_constraintdef("oid") AS "definition"
      FROM "pg_constraint"
      WHERE "conname" IN (
        'transaction_created_by_member_fkey',
        'transaction_last_edited_by_member_fkey',
        'transaction_payer_member_fkey',
        'transaction_split_member_fkey',
        'transaction_splits_transaction_id_fkey'
      )
      ORDER BY "conname"
    `;
    expect(memberReferenceConstraints).toEqual([
      {
        conname: 'transaction_created_by_member_fkey',
        definition: 'FOREIGN KEY (created_by_member_id, ledger_id) REFERENCES ledger_members(id, ledger_id)',
      },
      {
        conname: 'transaction_last_edited_by_member_fkey',
        definition: 'FOREIGN KEY (last_edited_by_member_id, ledger_id) REFERENCES ledger_members(id, ledger_id)',
      },
      {
        conname: 'transaction_payer_member_fkey',
        definition: 'FOREIGN KEY (payer_member_id, ledger_id) REFERENCES ledger_members(id, ledger_id)',
      },
      {
        conname: 'transaction_split_member_fkey',
        definition: 'FOREIGN KEY (member_id, ledger_id) REFERENCES ledger_members(id, ledger_id) ON DELETE RESTRICT',
      },
      {
        conname: 'transaction_splits_transaction_id_fkey',
        definition: 'FOREIGN KEY (transaction_id, ledger_id) REFERENCES transactions(id, ledger_id) ON DELETE CASCADE',
      },
    ]);

    const domainReferenceConstraints = await prisma.$queryRaw<Array<{ conname: string; definition: string }>>`
      SELECT "conname", pg_get_constraintdef("oid") AS "definition"
      FROM "pg_constraint"
      WHERE "conname" IN (
        'categories_parent_owner_fkey',
        'recurring_transactions_category_owner_fkey',
        'recurring_transactions_ledger_owner_fkey',
        'transaction_edit_history_transaction_ledger_fkey',
        'transaction_edit_operator_member_fkey',
        'transactions_category_owner_fkey',
        'transactions_ledger_owner_fkey',
        'transactions_recurring_ledger_fkey'
      )
      ORDER BY "conname"
    `;
    expect(domainReferenceConstraints).toEqual([
      {
        conname: 'categories_parent_owner_fkey',
        definition: 'FOREIGN KEY (parent_id, owner_id) REFERENCES categories(id, owner_id)',
      },
      {
        conname: 'recurring_transactions_category_owner_fkey',
        definition: 'FOREIGN KEY (category_id, owner_id) REFERENCES categories(id, owner_id)',
      },
      {
        conname: 'recurring_transactions_ledger_owner_fkey',
        definition: 'FOREIGN KEY (ledger_id, owner_id) REFERENCES ledgers(id, owner_id) ON DELETE CASCADE',
      },
      {
        conname: 'transaction_edit_history_transaction_ledger_fkey',
        definition: 'FOREIGN KEY (transaction_id, ledger_id) REFERENCES transactions(id, ledger_id) ON DELETE CASCADE',
      },
      {
        conname: 'transaction_edit_operator_member_fkey',
        definition: 'FOREIGN KEY (operator_member_id, ledger_id) REFERENCES ledger_members(id, ledger_id)',
      },
      {
        conname: 'transactions_category_owner_fkey',
        definition: 'FOREIGN KEY (category_id, owner_id) REFERENCES categories(id, owner_id)',
      },
      {
        conname: 'transactions_ledger_owner_fkey',
        definition: 'FOREIGN KEY (ledger_id, owner_id) REFERENCES ledgers(id, owner_id) ON DELETE CASCADE',
      },
      {
        conname: 'transactions_recurring_ledger_fkey',
        definition: 'FOREIGN KEY (recurring_id, ledger_id) REFERENCES recurring_transactions(id, ledger_id)',
      },
    ]);

    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT "tgname"
      FROM "pg_trigger"
      WHERE "tgrelid" = 'public.audit_logs'::regclass
        AND NOT "tgisinternal"
      ORDER BY "tgname"
    `;
    expect(triggers.map((row) => row.tgname)).toEqual([
      'audit_logs_reject_truncate',
      'audit_logs_reject_update_delete',
    ]);

    const ownerTriggers = await prisma.$queryRaw<
      Array<{ tgname: string; tgdeferrable: boolean; tginitdeferred: boolean }>
    >`
      SELECT "tgname", "tgdeferrable", "tginitdeferred"
      FROM "pg_trigger"
      WHERE "tgname" IN ('ledger_members_owner_member_guard', 'ledgers_owner_member_guard')
      ORDER BY "tgname"
    `;
    expect(ownerTriggers).toEqual([
      { tgname: 'ledger_members_owner_member_guard', tgdeferrable: true, tginitdeferred: true },
      { tgname: 'ledgers_owner_member_guard', tgdeferrable: true, tginitdeferred: true },
    ]);

    // LedgerMember 主键为单列 id（无复合主键）
    const memberPk = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT a.attname AS "column_name"
      FROM pg_index AS i
      JOIN pg_class AS c ON c.oid = i.indrelid
      JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE c.relname = 'ledger_members'
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)
    `;
    expect(memberPk.map((row) => row.column_name)).toEqual(['id']);
  });

  it('LedgerMember 实体化：owner 是一等成员，枚举/NOT NULL/唯一约束由数据库兜底', async () => {
    // 约束载体必须存在：成员身份、账号绑定与单 owner 都由数据库兜底
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT "indexname"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public'
        AND "tablename" = 'ledger_members'
        AND "indexname" IN (
          'ledger_members_id_ledger_id_key',
          'ledger_members_ledger_id_linked_account_id_key',
          'ledger_members_ledger_id_status_idx',
          'ledger_members_linked_account_id_idx',
          'ledger_members_one_owner_per_ledger'
        )
      ORDER BY "indexname"
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      'ledger_members_id_ledger_id_key',
      'ledger_members_ledger_id_linked_account_id_key',
      'ledger_members_ledger_id_status_idx',
      'ledger_members_linked_account_id_idx',
      'ledger_members_one_owner_per_ledger',
    ]);

    const transactionTarget = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT "indexname"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public'
        AND "tablename" = 'transactions'
        AND "indexname" = 'transactions_id_ledger_id_key'
    `;
    expect(transactionTarget).toEqual([{ indexname: 'transactions_id_ledger_id_key' }]);

    const enumTypes = await prisma.$queryRaw<Array<{ typname: string; enumlabels: string }>>`
      SELECT t."typname", string_agg(e."enumlabel", ',' ORDER BY e."enumsortorder") AS "enumlabels"
      FROM "pg_type" AS t
      JOIN "pg_enum" AS e ON e."enumtypid" = t."oid"
      WHERE t."typname" IN ('LedgerMemberType', 'LedgerMemberRole', 'LedgerMemberStatus')
      GROUP BY t."typname"
      ORDER BY t."typname"
    `;
    expect(enumTypes).toEqual([
      { typname: 'LedgerMemberRole', enumlabels: 'owner,editor' },
      { typname: 'LedgerMemberStatus', enumlabels: 'ACTIVE,LEFT,REMOVED' },
      { typname: 'LedgerMemberType', enumlabels: 'REGISTERED,PLACEHOLDER' },
    ]);

    // owner 角色可写：Owner 是一等 Member（数据层）；id 与 UUIDv5 派生公式一致
    const ownerMemberId = await probe(async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "ledger_members" ("id", "ledger_id", "display_name", "member_type", "linked_account_id", "role", "status", "updated_at")
        VALUES (
          uuid_generate_v5(${ledgerId}::uuid, 'user:' || ${ownerId}),
          ${ledgerId}::uuid, 'Owner', 'REGISTERED', ${ownerId}::uuid, 'owner', 'ACTIVE', CURRENT_TIMESTAMP
        )
        RETURNING "id"::text AS "id"
      `;
      return rows[0]!.id;
    });
    expect(ownerMemberId).toMatch(/^[0-9a-f-]{36}$/);

    // 同一账本/账号派生相同 UUID；重复写入可由三个等价唯一索引中的任意一个拒绝。
    await expectDatabaseRejects(
      '23505',
      /unique constraint "(?:ledger_members_pkey|ledger_members_ledger_id_linked_account_id_key|ledger_members_id_ledger_id_key)"/,
      async (tx) => {
        const ownerId = await seedUser(tx);
        const ledgerId = await seedLedger(tx, ownerId);
        await seedMember(tx, ledgerId, ownerId, 'owner');
        await seedMember(tx, ledgerId, ownerId, 'editor');
      },
    );

    // display_name 非空（账本级身份快照）由数据库强制
    await expectDatabaseRejects('23502', 'column "display_name" of relation "ledger_members"', async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      await tx.$executeRaw`
        INSERT INTO "ledger_members" ("id", "ledger_id", "display_name", "member_type", "linked_account_id", "role", "status", "updated_at")
        VALUES (uuid_generate_v5(${ledgerId}::uuid, 'user:' || ${ownerId}), ${ledgerId}::uuid, NULL, 'REGISTERED', ${ownerId}::uuid, 'owner', 'ACTIVE', CURRENT_TIMESTAMP)
      `;
    });

    // 非法枚举值（member_type/role/status）由数据库拒绝
    await expectDatabaseRejects('22P02', 'invalid input value for enum "LedgerMemberType": "GHOST"', async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      await tx.$executeRaw`
        INSERT INTO "ledger_members" ("id", "ledger_id", "display_name", "member_type", "linked_account_id", "role", "status", "updated_at")
        VALUES (${randomUUID()}::uuid, ${ledgerId}::uuid, '成员', 'GHOST', ${ownerId}::uuid, 'owner', 'ACTIVE', CURRENT_TIMESTAMP)
      `;
    });
  });

  it('User 的手机号与芝麻号必须同时非空', async () => {
    await expectDatabaseRejects('23502', 'column "phone_e164" of relation "users"', async (tx) => {
      const userId = await seedUser(tx);
      await tx.$executeRaw`UPDATE "users" SET "phone_e164" = NULL WHERE "id" = ${userId}::uuid`;
    });

    await expectDatabaseRejects('23502', 'column "sesame_number" of relation "users"', async (tx) => {
      const userId = await seedUser(tx);
      await tx.$executeRaw`UPDATE "users" SET "sesame_number" = NULL WHERE "id" = ${userId}::uuid`;
    });
  });

  it('LedgerMember 类型与账号引用必须配对', async () => {
    await expectDatabaseRejects('23514', 'ledger_members_type_account_check', async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      await tx.$executeRaw`
        INSERT INTO "ledger_members" ("id", "ledger_id", "display_name", "member_type", "role", "status", "updated_at")
        VALUES (${randomUUID()}::uuid, ${ledgerId}::uuid, '非法注册成员', 'REGISTERED', 'editor', 'ACTIVE', CURRENT_TIMESTAMP)
      `;
    });

    await expectDatabaseRejects('23514', 'ledger_members_type_account_check', async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      await tx.$executeRaw`
        INSERT INTO "ledger_members" (
          "id", "ledger_id", "display_name", "member_type", "linked_account_id", "role", "status", "updated_at"
        ) VALUES (
          ${randomUUID()}::uuid, ${ledgerId}::uuid, '非法占位成员', 'PLACEHOLDER', ${ownerId}::uuid, 'editor', 'ACTIVE', CURRENT_TIMESTAMP
        )
      `;
    });
  });

  it('REGISTERED 成员 id 必须持续等于 UUIDv5 派生值（数据库拒绝错误派生 ID）', async () => {
    // raw SQL 或后续代码写入随机/错误派生 ID 时由数据库 CHECK 直接拒绝
    await expectDatabaseRejects('23514', 'ledger_members_registered_id_v5_check', async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      await tx.$executeRaw`
        INSERT INTO "ledger_members" ("id", "ledger_id", "display_name", "member_type", "linked_account_id", "role", "status", "updated_at")
        VALUES (${randomUUID()}::uuid, ${ledgerId}::uuid, '错误派生', 'REGISTERED', ${ownerId}::uuid, 'editor', 'ACTIVE', CURRENT_TIMESTAMP)
      `;
    });

    // 与服务端 registeredMemberId 同一公式的正确派生 ID 可正常写入
    const memberId = await probe(async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      return seedMember(tx, ledgerId, ownerId, 'editor');
    });
    expect(memberId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('每个账本必须恰有一个与 Ledger.ownerId 一致的 owner 成员', async () => {
    await expectDatabaseRejects('23505', 'ledger_members_one_owner_per_ledger', async (tx) => {
      const ownerId = await seedUser(tx);
      const otherUserId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      await seedMember(tx, ledgerId, ownerId, 'owner');
      await seedMember(tx, ledgerId, otherUserId, 'owner');
    });

    await expectDeferredDatabaseRejects('23514', /owner_id 一致的 ACTIVE REGISTERED owner 成员/, async (tx) => {
      const ownerId = await seedUser(tx);
      await seedLedger(tx, ownerId);
    });

    await expectDeferredDatabaseRejects('23514', /owner_id 一致的 ACTIVE REGISTERED owner 成员/, async (tx) => {
      const ownerId = await seedUser(tx);
      const otherUserId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      await seedMember(tx, ledgerId, otherUserId, 'owner');
    });

    const validOwner = await probe(async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      await seedMember(tx, ledgerId, ownerId, 'owner');
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      return ownerId;
    });
    expect(validOwner).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['createdByMemberId', 'transaction_created_by_member_fkey'],
    ['lastEditedByMemberId', 'transaction_last_edited_by_member_fkey'],
    ['payerMemberId', 'transaction_payer_member_fkey'],
  ] as const)('Transaction.%s 必须引用本账本成员', async (reference, constraint) => {
    await expectDatabaseRejects('23503', constraint, async (tx) => {
      const ownerId = await seedUser(tx);
      const foreignOwnerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const foreignLedgerId = await seedLedger(tx, foreignOwnerId);
      const foreignMemberId = await seedMember(tx, foreignLedgerId, foreignOwnerId, 'owner');
      const memberReferences: Parameters<typeof seedTransaction>[3] = {};
      memberReferences[reference] = foreignMemberId;
      await seedTransaction(tx, ledgerId, randomUUID(), memberReferences);
    });
  });

  it('分类、周期账单、交易与编辑历史必须保持同一 Owner/账本', async () => {
    await expectDatabaseRejects('23503', 'transactions_category_owner_fkey', async (tx) => {
      const graph = await seedRelationDomains(tx);
      await tx.$executeRaw`UPDATE "transactions" SET "category_id" = ${graph.foreignCategoryId}::uuid WHERE "id" = ${graph.transactionId}::uuid`;
    });
    await expectDatabaseRejects('23503', 'transactions_recurring_ledger_fkey', async (tx) => {
      const graph = await seedRelationDomains(tx);
      await tx.$executeRaw`UPDATE "transactions" SET "recurring_id" = ${graph.foreignRecurringId}::uuid WHERE "id" = ${graph.transactionId}::uuid`;
    });
    await expectDatabaseRejects('23503', 'recurring_transactions_category_owner_fkey', async (tx) => {
      const graph = await seedRelationDomains(tx);
      await tx.$executeRaw`UPDATE "recurring_transactions" SET "category_id" = ${graph.foreignCategoryId}::uuid WHERE "id" = ${graph.recurringId}::uuid`;
    });
    await expectDatabaseRejects('23503', 'categories_parent_owner_fkey', async (tx) => {
      const graph = await seedRelationDomains(tx);
      await tx.$executeRaw`UPDATE "categories" SET "parent_id" = ${graph.foreignCategoryId}::uuid WHERE "id" = ${graph.childCategoryId}::uuid`;
    });
    await expectDatabaseRejects('23503', 'transaction_edit_operator_member_fkey', async (tx) => {
      const graph = await seedRelationDomains(tx);
      await tx.$executeRaw`UPDATE "transaction_edit_history" SET "operator_member_id" = ${graph.foreignMemberId}::uuid WHERE "transaction_id" = ${graph.transactionId}::uuid`;
    });
  });

  it('PostgreSQL uuid_generate_v5 与 Node/Dart golden 向量一致（三端算法对齐）', async () => {
    const rows = await prisma.$queryRaw<Array<{ derived: string }>>`
      SELECT uuid_generate_v5('11111111-1111-4111-8111-111111111111'::uuid, 'user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')::text AS "derived"
    `;
    expect(rows[0]!.derived).toBe('056cf10d-2d59-599c-9d97-6749e866aa52');
  });

  it('RefreshToken 的 device 必须属于同一 user', async () => {
    await expectDatabaseRejects('23503', 'refresh_tokens_device_id_user_id_fkey', async (tx) => {
      const deviceOwnerId = await seedUser(tx);
      const tokenOwnerId = await seedUser(tx);
      const deviceId = await seedDevice(tx, deviceOwnerId);
      await tx.$executeRaw`
        INSERT INTO "refresh_tokens" ("id", "user_id", "device_id", "token_hash", "expires_at", "auth_generation")
        VALUES (
          ${randomUUID()}::uuid,
          ${tokenOwnerId}::uuid,
          ${deviceId}::uuid,
          ${randomUUID().replaceAll('-', '').padEnd(64, '0')},
          CURRENT_TIMESTAMP + INTERVAL '1 day',
          ${randomUUID()}::uuid
        )
      `;
    });
  });

  it('头像版本和 Category 必填结构由数据库兜底', async () => {
    await expectDatabaseRejects('23514', 'user_profiles_avatar_version_check', async (tx) => {
      const userId = await seedUser(tx);
      await tx.$executeRaw`
        INSERT INTO "user_profiles" ("id", "user_id", "avatar_version", "updated_at")
        VALUES (${randomUUID()}::uuid, ${userId}::uuid, -1, CURRENT_TIMESTAMP)
      `;
    });

    await expectDatabaseRejects('23502', 'column "level" of relation "categories"', async (tx) => {
      const userId = await seedUser(tx);
      await tx.$executeRaw`
        INSERT INTO "categories" ("id", "owner_id", "name", "kind", "level", "sort_order", "updated_at")
        VALUES (${randomUUID()}::uuid, ${userId}::uuid, '非法分类', 'expense', NULL, 0, CURRENT_TIMESTAMP)
      `;
    });
  });

  it('TransactionSplit 自动生成 UUID，并拒绝非法参与人、金额和重复参与人', async () => {
    const splitId = await probe(async (tx) => {
      const ownerId = await seedUser(tx);
      const participantId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const memberId = await seedMember(tx, ledgerId, participantId, 'editor');
      const transactionId = await seedTransaction(tx, ledgerId);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "transaction_splits" ("transaction_id", "ledger_id", "member_id", "amount")
        VALUES (${transactionId}::uuid, ${ledgerId}::uuid, ${memberId}::uuid, 10)
        RETURNING "id"::text AS "id"
      `;
      return rows[0]!.id;
    });
    expect(splitId).toMatch(/^[0-9a-f-]{36}$/);

    await expectDatabaseRejects('23502', 'column "member_id" of relation "transaction_splits"', async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const transactionId = await seedTransaction(tx, ledgerId);
      await tx.$executeRaw`
        INSERT INTO "transaction_splits" ("transaction_id", "ledger_id", "amount")
        VALUES (${transactionId}::uuid, ${ledgerId}::uuid, 10)
      `;
    });

    // 参与人必须是本账本成员：不存在的 member id 由 FK 拒绝
    await expectDatabaseRejects('23503', 'transaction_split_member_fkey', async (tx) => {
      const ownerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const transactionId = await seedTransaction(tx, ledgerId);
      await tx.$executeRaw`
        INSERT INTO "transaction_splits" ("transaction_id", "ledger_id", "member_id", "amount")
        VALUES (${transactionId}::uuid, ${ledgerId}::uuid, ${randomUUID()}::uuid, 10)
      `;
    });

    // 参与人实体即使真实存在，也不能来自另一账本
    await expectDatabaseRejects('23503', 'transaction_split_member_fkey', async (tx) => {
      const ownerId = await seedUser(tx);
      const foreignOwnerId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const foreignLedgerId = await seedLedger(tx, foreignOwnerId);
      const foreignMemberId = await seedMember(tx, foreignLedgerId, foreignOwnerId, 'owner');
      const transactionId = await seedTransaction(tx, ledgerId);
      await tx.$executeRaw`
        INSERT INTO "transaction_splits" ("transaction_id", "ledger_id", "member_id", "amount")
        VALUES (${transactionId}::uuid, ${ledgerId}::uuid, ${foreignMemberId}::uuid, 10)
      `;
    });

    await expectDatabaseRejects('23514', 'transaction_splits_amount_check', async (tx) => {
      const ownerId = await seedUser(tx);
      const participantId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const memberId = await seedMember(tx, ledgerId, participantId, 'editor');
      const transactionId = await seedTransaction(tx, ledgerId);
      await tx.$executeRaw`
        INSERT INTO "transaction_splits" ("transaction_id", "ledger_id", "member_id", "amount")
        VALUES (${transactionId}::uuid, ${ledgerId}::uuid, ${memberId}::uuid, 0)
      `;
    });

    await expectDatabaseRejects('23505', 'transaction_splits_transaction_id_member_id_key', async (tx) => {
      const ownerId = await seedUser(tx);
      const participantId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const memberId = await seedMember(tx, ledgerId, participantId, 'editor');
      const transactionId = await seedTransaction(tx, ledgerId);
      await tx.$executeRaw`
        INSERT INTO "transaction_splits" ("transaction_id", "ledger_id", "member_id", "amount")
        VALUES
          (${transactionId}::uuid, ${ledgerId}::uuid, ${memberId}::uuid, 4),
          (${transactionId}::uuid, ${ledgerId}::uuid, ${memberId}::uuid, 6)
      `;
    });
  });

  it('分摊参与人 FK 使用 RESTRICT：成员物理删除被拒绝，历史分摊不丢失', async () => {
    await expectDatabaseRejects('23503', 'transaction_split_member_fkey', async (tx) => {
      const ownerId = await seedUser(tx);
      const participantId = await seedUser(tx);
      const ledgerId = await seedLedger(tx, ownerId);
      const memberId = await seedMember(tx, ledgerId, participantId, 'editor');
      const transactionId = await seedTransaction(tx, ledgerId);
      await tx.$executeRaw`
        INSERT INTO "transaction_splits" ("transaction_id", "ledger_id", "member_id", "amount")
        VALUES (${transactionId}::uuid, ${ledgerId}::uuid, ${memberId}::uuid, 10)
      `;
      await tx.$executeRaw`DELETE FROM "ledger_members" WHERE "id" = ${memberId}::uuid`;
    });
  });

  it('删除 User 或 Ledger 不会级联删除 SyncChange 历史', async () => {
    const deleteActions = await prisma.$queryRaw<Array<{ conname: string; action: string }>>`
      SELECT "conname", "confdeltype"::text AS "action"
      FROM "pg_constraint"
      WHERE "conname" IN ('sync_changes_user_id_fkey', 'sync_changes_ledger_id_fkey')
      ORDER BY "conname"
    `;
    expect(deleteActions).toEqual([
      { conname: 'sync_changes_ledger_id_fkey', action: 'n' },
      { conname: 'sync_changes_user_id_fkey', action: 'n' },
    ]);
  });

  it('LedgerMember 无消费列已删除：头像/溯源账号/成员 tombstone 不再落库', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT "column_name"
      FROM "information_schema"."columns"
      WHERE "table_name" = 'ledger_members'
        AND "column_name" IN ('origin_account_id', 'avatar_url', 'avatar_version', 'deleted_at')
    `;
    expect(columns).toEqual([]);
  });

  it('sync_changes.recipient_user_id 有 FK 且 SET NULL：孤儿接收者被数据库拒绝', async () => {
    const deleteActions = await prisma.$queryRaw<Array<{ conname: string; action: string }>>`
      SELECT "conname", "confdeltype"::text AS "action"
      FROM "pg_constraint"
      WHERE "conname" = 'sync_changes_recipient_user_id_fkey'
    `;
    expect(deleteActions).toEqual([{ conname: 'sync_changes_recipient_user_id_fkey', action: 'n' }]);
    await expectDatabaseRejects('23503', 'sync_changes_recipient_user_id_fkey', async (tx) => {
      const deviceId = await seedDevice(tx, await seedUser(tx));
      // 使用 raw SQL 保留 PostgreSQL 的 SQLSTATE 和外键名称，避免 Prisma 模型错误映射。
      await tx.$executeRaw`
        INSERT INTO "sync_changes" (
          "user_id", "ledger_id", "scope", "entity_type", "entity_id", "action", "mutation_id",
          "payload", "updated_at", "device_id", "recipient_user_id"
        ) VALUES (
          NULL, NULL, 'user', 'category', ${randomUUID()}::uuid, 'upsert', ${randomUUID()}::uuid,
          '{}'::json, CURRENT_TIMESTAMP, ${deviceId}::uuid, ${randomUUID()}::uuid
        )
      `;
    });
  });

  it('AuditLog 拒绝 UPDATE 与 DELETE', async () => {
    await expectDatabaseRejects('55000', '审计日志只允许追加', async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO "audit_logs" ("actor", "action", "target", "request_id", "ip", "metadata")
        VALUES ('test', 'test.update', '{"type":"test"}'::jsonb, ${randomUUID()}, '127.0.0.1', '{}'::jsonb)
        RETURNING "id"
      `;
      await tx.$executeRaw`UPDATE "audit_logs" SET "action" = 'changed' WHERE "id" = ${rows[0]!.id}`;
    });

    await expectDatabaseRejects('55000', '审计日志只允许追加', async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO "audit_logs" ("actor", "action", "target", "request_id", "ip", "metadata")
        VALUES ('test', 'test.delete', '{"type":"test"}'::jsonb, ${randomUUID()}, '127.0.0.1', '{}'::jsonb)
        RETURNING "id"
      `;
      await tx.$executeRaw`DELETE FROM "audit_logs" WHERE "id" = ${rows[0]!.id}`;
    });
  });
});
