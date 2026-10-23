import { snapshotRows, type SnapshotWriter } from '../../shared/snapshot-stream.js';

import type { Ledger, Prisma, PrismaClient } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { TimestampSchema } from '../../shared/contracts/scalars.js';
import type { ApiConfig } from '../../shared/api-config.js';
import { ApiError } from '../../shared/errors.js';
import { committedSyncCursor, requireSyncCutover } from '../../shared/sync-cutover.js';
import { executor } from '../../shared/execute.js';
import {
  CategorySchema,
  ExchangeRateOverrideSchema,
  LedgerSchema,
  MemberSchema,
  RecurringTransactionSchema,
  TransactionSchema,
} from '../../shared/contracts/accounting.js';
import { visibleSyncChangeWhere } from './sync-version.js';
import { ledgerArchiveFields, mapTransaction } from '../accounting/index.js';
import { categorySnapshot, ledgerSnapshot, memberSnapshot, rateSnapshot, recurringSnapshot } from './sync-snapshots.js';

/** 同步路由共用的 500 失败码，捕获与日志由公共执行器负责。 */
export const executeSync = executor('SYNC_FAILED');

// 完整周期状态包含墓碑，重装或首次绑定时可以恢复生成游标并避免复活已删除的账单。
const recurringStateRuleSchema = Type.Object({
  ...RecurringTransactionSchema.properties,
  deleted_at: Type.Union([TimestampSchema, Type.Null()]),
});
const recurringStateOccurrenceSchema = Type.Object({
  ...TransactionSchema.properties,
  deleted_at: Type.Union([TimestampSchema, Type.Null()]),
});

/** 单账本与账号完整快照共用账本字段，保证两种下载入口使用一致的实体协议。 */
export const ledgerSnapshotFields = {
  ledger: Type.Omit(LedgerSchema, ['role', 'member_count']),
  members: Type.Array(Type.Ref(MemberSchema)),
  transactions: Type.Array(Type.Ref(TransactionSchema)),
  categories: Type.Array(Type.Ref(CategorySchema)),
  category_tombstones: Type.Array(Type.Ref(CategorySchema)),
  recurring_transactions: Type.Array(Type.Ref(RecurringTransactionSchema)),
  exchange_rate_overrides: Type.Array(Type.Ref(ExchangeRateOverrideSchema)),
  recurring_state: Type.Optional(
    Type.Object({
      rules: Type.Array(recurringStateRuleSchema),
      occurrences: Type.Array(recurringStateOccurrenceSchema),
    }),
  ),
};

/** 快照事务内按所有者复用分类和汇率，不为每本重复读取和转换相同目录。 */
export function snapshotCatalogs(tx: Prisma.TransactionClient, userId: string) {
  const categories = new Map<string, Promise<ReturnType<typeof categorySnapshot>[]>>();
  const categoryTombstones = new Map<string, Promise<ReturnType<typeof categorySnapshot>[]>>();
  let rates: Promise<ReturnType<typeof rateSnapshot>[]> | undefined;

  /** 同一快照内按所有者和删除状态缓存查询，所有账本与账号目录共用首次读取结果。 */
  async function categoryCatalog(ownerId: string, deleted: boolean) {
    try {
      const cache = deleted ? categoryTombstones : categories;
      let result = cache.get(ownerId);
      if (!result) {
        result = tx.category
          .findMany({
            where: { ownerId, deletedAt: deleted ? { not: null } : null },
            orderBy: deleted
              ? [{ level: 'asc' }, { id: 'asc' }]
              : [{ level: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
          })
          .then((rows) => rows.map(categorySnapshot));
        // 缓存进行中的查询，后续读取也复用同一个 Promise，不会同时发起重复查询。
        cache.set(ownerId, result);
      }
      return await result;
    } catch (error) {
      throw new Error(`分类${deleted ? '墓碑' : '目录'}读取失败（所有者：${ownerId}）`, { cause: error });
    }
  }

  return {
    /** 读取当前所有者的活跃分类，供各账本及本人账号目录使用。 */
    categories(ownerId: string) {
      return categoryCatalog(ownerId, false);
    },
    /** 读取当前所有者的分类墓碑，保留真实所有者和删除时间。 */
    categoryTombstones(ownerId: string) {
      return categoryCatalog(ownerId, true);
    },
    /** 调用方准备消费结果时才读取汇率，避免前面的快照步骤尚未完成就产生无人接管的拒绝。 */
    async rates() {
      try {
        rates ??= tx.exchangeRateOverride
          .findMany({ where: { ownerId: userId, deletedAt: null } })
          .then((rows) => rows.map(rateSnapshot));
        return await rates;
      } catch (cause) {
        throw new Error('个人汇率目录读取失败', { cause });
      }
    },
  };
}

/** 按共同快照协议编译实体序列化器，确保响应声明与实际输出使用相同账本字段。 */
export function ledgerSerializers(reply: FastifyReply) {
  return {
    ledger: reply.compileSerializationSchema(ledgerSnapshotFields.ledger),
    member: reply.compileSerializationSchema(MemberSchema),
    transaction: reply.compileSerializationSchema(TransactionSchema),
    category: reply.compileSerializationSchema(CategorySchema),
    recurring: reply.compileSerializationSchema(RecurringTransactionSchema),
    recurringStateRule: reply.compileSerializationSchema(recurringStateRuleSchema),
    recurringStateOccurrence: reply.compileSerializationSchema(recurringStateOccurrenceSchema),
    rate: reply.compileSerializationSchema(ExchangeRateOverrideSchema),
  };
}

/** 单本与账号快照复用逐段写入，交易分批读取，不保留整份对象树。 */
export async function writeLedgerSnapshot(
  writer: SnapshotWriter,
  tx: Prisma.TransactionClient,
  ledger: Ledger,
  userId: string,
  codecs: ReturnType<typeof ledgerSerializers>,
  catalogs: ReturnType<typeof snapshotCatalogs>,
  closeObject = true,
  includeRecurringState = false,
): Promise<void> {
  const members = await tx.ledgerMember.findMany({ where: { ledgerId: ledger.id } });
  await writer.text('{"ledger":');
  await writer.value(
    { ...ledgerSnapshot(ledger), ...ledgerArchiveFields(members.find((row) => row.linkedAccountId === userId)) },
    codecs.ledger,
  );
  await writer.text(',"members":');
  await writer.array(members.map(memberSnapshot), codecs.member);
  await writer.text(',"transactions":');
  await writer.array(
    snapshotRows((cursor, take) =>
      tx.transaction.findMany({
        where: { ledgerId: ledger.id, deletedAt: null },
        include: { splits: true },
        orderBy: [{ happenedAt: 'asc' }, { id: 'asc' }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    ),
    (row) => codecs.transaction(mapTransaction(row)),
  );
  await writer.text(',"categories":');
  await writer.array(await catalogs.categories(ledger.ownerId), codecs.category);
  await writer.text(',"category_tombstones":');
  await writer.array(await catalogs.categoryTombstones(ledger.ownerId), codecs.category);
  await writer.text(',"recurring_transactions":');
  await writer.array(
    snapshotRows((cursor, take) =>
      tx.recurringTransaction.findMany({
        where: { ledgerId: ledger.id, deletedAt: null },
        orderBy: { id: 'asc' },
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    ),
    (row) => codecs.recurring(recurringSnapshot(row)),
  );
  await writer.text(',"exchange_rate_overrides":');
  await writer.array(await catalogs.rates(), codecs.rate);
  if (includeRecurringState) await writeRecurringState(writer, tx, ledger.id, codecs);
  if (closeObject) await writer.text('}');
}

/** 在同一重复读事务中分批输出周期规则和已生成记录，包含软删除状态。 */
async function writeRecurringState(
  writer: SnapshotWriter,
  tx: Prisma.TransactionClient,
  ledgerId: string,
  codecs: ReturnType<typeof ledgerSerializers>,
): Promise<void> {
  try {
    await writer.text(',"recurring_state":{"rules":');
    await writer.array(
      snapshotRows((cursor, take) =>
        tx.recurringTransaction.findMany({
          where: { ledgerId },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      ),
      (row) =>
        codecs.recurringStateRule({ ...recurringSnapshot(row), deleted_at: row.deletedAt?.toISOString() ?? null }),
    );
    await writer.text(',"occurrences":');
    await writer.array(
      snapshotRows((cursor, take) =>
        tx.transaction.findMany({
          where: { ledgerId, recurringId: { not: null } },
          include: { splits: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      ),
      (row) =>
        codecs.recurringStateOccurrence({ ...mapTransaction(row), deleted_at: row.deletedAt?.toISOString() ?? null }),
    );
    await writer.text('}');
  } catch (cause) {
    throw new Error('周期记账完整状态读取失败', { cause });
  }
}

/** 在当前快照内读取全局已提交水位，空账号也不能返回可见事件的局部水位。 */
export async function fullSnapshotCursor(tx: Prisma.TransactionClient, config: ApiConfig): Promise<bigint> {
  try {
    const cursor = await committedSyncCursor(tx);
    if (BigInt(config.syncRetentionMinCursor) > cursor)
      throw new ApiError(500, 'SYNC_RETENTION_INVALID', '同步历史水位配置异常，请稍后重试');
    return cursor;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('完整快照水位读取失败', { cause: error });
  }
}

/** 获取用户当前可见事件的最大游标，没有可见事件时返回持久协议切点。 */
export async function latestVisibleCursor(
  prisma: Pick<PrismaClient, 'syncChange' | '$queryRaw'>,
  userId: string,
): Promise<bigint> {
  try {
    const row = await prisma.syncChange.findFirst({
      where: visibleSyncChangeWhere(userId),
      orderBy: { changeId: 'desc' },
      select: { changeId: true },
    });
    const cutoverCursor = await requireSyncCutover(prisma);
    return row && row.changeId > cutoverCursor ? row.changeId : cutoverCursor;
  } catch (error) {
    throw new Error('同步游标读取失败', { cause: error });
  }
}
