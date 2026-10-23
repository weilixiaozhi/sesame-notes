import { CategoryVersionTokenSchema } from '../../shared/contracts/category-conflicts.js';
import {
  NameSchema,
  AnyUuidSchema,
  CurrencySchema,
  CursorSchema,
  PositiveAmountSchema,
  TimestampSchema,
  UuidSchema,
  UuidV5Schema,
} from '../../shared/contracts/scalars.js';
import {
  TransactionTypeSchema,
  AaModeSchema,
  ExchangeRateOverrideSchema,
  RecurringTransactionSchema,
} from '../../shared/contracts/accounting.js';

import type { SyncMutationEnvelope } from '../../shared/sync-mutation.js';
import { SYNC_ENTITY_TYPES } from '../../shared/contracts/sync.js';
import { Type, type TSchema } from '@sinclair/typebox';
import { DayBookPayloadSchema, DayDeletePayloadSchema, DayEventPayloadSchema } from '../days/index.js';
import { MemoBookPayloadSchema, MemoEntryPayloadSchema } from '../memos/index.js';
import { FitnessSpacePayloadSchema, fitnessPayloadSchemas } from '../fitness/index.js';

const EntityTypeSchema = Type.Union(SYNC_ENTITY_TYPES.map((type) => Type.Literal(type)));

const LedgerSyncPayloadSchema = Type.Object({
  name: NameSchema,
  currency: CurrencySchema,
  month_start_day: Type.Integer({ minimum: 1, maximum: 31 }),
  aa_enabled: Type.Boolean(),
});
export const TransactionSyncPayloadSchema = Type.Object({
  tx_type: TransactionTypeSchema,
  amount: PositiveAmountSchema,
  happened_at: TimestampSchema,
  note: Type.Union([Type.String(), Type.Null()]),
  // 分类引用兼容确定性 UUIDv5（seed 默认分类派生 id），与 member 引用同口径
  category_id: Type.Union([AnyUuidSchema, Type.Null()]),
  currency_code: CurrencySchema,
  native_amount: PositiveAmountSchema,
  recurring_id: Type.Union([AnyUuidSchema, Type.Null()]),
  occurrence_date: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
  // payer 成员引用（UUIDv5 派生 REGISTERED 或 PLACEHOLDER，须用 AnyUuidSchema）
  payer_member_id: Type.Optional(Type.Union([AnyUuidSchema, Type.Null()])),
  aa_mode: AaModeSchema,
  splits: Type.Union([
    Type.Array(
      Type.Object({
        member_id: AnyUuidSchema,
        amount: PositiveAmountSchema,
      }),
    ),
    Type.Null(),
  ]),
  last_edited_at: Type.Union([TimestampSchema, Type.Null()]),
});
const CategorySyncPayloadSchema = Type.Object({
  base_token: Type.Optional(CategoryVersionTokenSchema),
  name: NameSchema,
  kind: TransactionTypeSchema,
  level: Type.Union([Type.Literal(1), Type.Literal(2)]),
  sort_order: Type.Integer(),
  icon: Type.Union([Type.String(), Type.Null()]),
  parent_id: Type.Union([AnyUuidSchema, Type.Null()]),
});
const RecurringSyncPayloadSchema = Type.Object({
  ...Type.Omit(RecurringTransactionSchema, ['id', 'ledger_id', 'updated_at', 'last_generated_date']).properties,
  initial_state: Type.Optional(
    Type.Object({
      last_generated_date: Type.Union([TimestampSchema, Type.Null()]),
      deleted_at: Type.Union([TimestampSchema, Type.Null()]),
      occurrences: Type.Array(
        Type.Object({
          id: AnyUuidSchema,
          deleted_at: Type.Union([TimestampSchema, Type.Null()]),
          payload: TransactionSyncPayloadSchema,
        }),
        { maxItems: 10000 },
      ),
    }),
  ),
});
const RateSyncPayloadSchema = Type.Omit(ExchangeRateOverrideSchema, ['id', 'updated_at']);
// 占位成员资料（PLACEHOLDER）：display_name 由客户端同步，成员类型由成员生命周期决定
const MemberSyncPayloadSchema = Type.Object({
  display_name: NameSchema,
  initial_status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('LEFT'), Type.Literal('REMOVED')])),
});
const TransactionHistorySyncPayloadSchema = Type.Object({
  ...TransactionSyncPayloadSchema.properties,
  initial_history: Type.Optional(Type.Literal(true)),
});

export const SyncPushChangeSchema = Type.Union([
  createDaySyncEntitySchema('day_book', DayBookPayloadSchema),
  createDaySyncEntitySchema('day_event', DayEventPayloadSchema),
  createSyncEntitySchema('ledger', AnyUuidSchema, LedgerSyncPayloadSchema),
  Type.Object({
    mutation_id: AnyUuidSchema,
    entity_type: Type.Literal('ledger_archive'),
    entity_id: AnyUuidSchema,
    ledger_id: AnyUuidSchema,
    sync_id: UuidSchema,
    action: Type.Literal('upsert'),
    updated_at: TimestampSchema,
    payload: Type.Object({ archived: Type.Boolean() }),
  }),
  createSyncEntitySchema('transaction', AnyUuidSchema, TransactionHistorySyncPayloadSchema),
  // 分类实体 id 兼容确定性 UUIDv5（seed 默认分类派生 id）
  createSyncEntitySchema('category', Type.Null(), CategorySyncPayloadSchema, AnyUuidSchema),
  createSyncEntitySchema('recurring_transaction', AnyUuidSchema, RecurringSyncPayloadSchema),
  // 汇率覆盖是唯一要求确定性派生 id 的实体：版本必须锁 v5，派生值由处理器校验
  createSyncEntitySchema('exchange_rate_override', Type.Null(), RateSyncPayloadSchema, UuidV5Schema),
  createSyncEntitySchema('member', AnyUuidSchema, MemberSyncPayloadSchema),
  createMemoSyncEntitySchema('memo_book', MemoBookPayloadSchema),
  createMemoSyncEntitySchema('memo_entry', MemoEntryPayloadSchema),
  ...Object.entries(fitnessPayloadSchemas).map(([type, payload]) => createFitnessSyncEntitySchema(type, payload)),
  createFitnessSyncEntitySchema('fitness_space', FitnessSpacePayloadSchema),
]);

// 分摊成员在单条事务内校验；其余载荷和外壳仍严格校验，保持整批请求的错误边界。
const TransactionPushEnvelopePayload = Type.Object({
  ...TransactionHistorySyncPayloadSchema.properties,
  splits: Type.Union([
    Type.Array(Type.Object({ member_id: Type.Optional(Type.Unknown()), amount: PositiveAmountSchema })),
    Type.Null(),
  ]),
});
export const SyncPushEnvelopeSchema = Type.Object({
  device_id: UuidSchema,
  changes: Type.Array(
    Type.Union([
      ...SyncPushChangeSchema.anyOf,
      createSyncEntitySchema('transaction', AnyUuidSchema, TransactionPushEnvelopePayload),
    ]),
    { minItems: 1, maxItems: 500 },
  ),
});

function createFitnessSyncEntitySchema(entityType: string, payload: TSchema) {
  const fields = {
    mutation_id: AnyUuidSchema,
    entity_type: Type.Literal(entityType),
    entity_id: AnyUuidSchema,
    ledger_id: Type.Null(),
    day_book_id: Type.Null(),
    memo_book_id: Type.Null(),
    fitness_space_id: AnyUuidSchema,
    sync_id: Type.Optional(UuidSchema),
    base_revision: Type.Optional(Type.Integer({ minimum: 0 })),
    updated_at: TimestampSchema,
  };
  return Type.Union([
    Type.Object(
      { ...fields, action: Type.Literal('upsert'), payload, deleted_at: Type.Optional(TimestampSchema) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...fields,
        action: Type.Literal('delete'),
        payload:
          entityType === 'fitness_space'
            ? Type.Object({ expected_full_cursor: CursorSchema })
            : Type.Object({}, { additionalProperties: false }),
      },
      { additionalProperties: false },
    ),
  ]);
}

export const SyncChangeEnvelopeSchema = Type.Object({
  change_id: CursorSchema,
  ledger_id: Type.Union([AnyUuidSchema, Type.Null()]),
  day_book_id: Type.Union([AnyUuidSchema, Type.Null()]),
  memo_book_id: Type.Union([AnyUuidSchema, Type.Null()]),
  fitness_space_id: Type.Union([AnyUuidSchema, Type.Null()]),
  entity_type: EntityTypeSchema,
  // 分类等 user 级实体可为确定性 v5 id
  entity_id: AnyUuidSchema,
  action: Type.Union([Type.Literal('upsert'), Type.Literal('delete')]),
  mutation_id: AnyUuidSchema,
  payload: Type.Record(Type.String(), Type.Unknown()),
  updated_at: TimestampSchema,
  device_id: UuidSchema,
});

/** 备忘录本及内容共用父本边界，删除本必须携带完整快照前置条件。 */
function createMemoSyncEntitySchema(entityType: 'memo_book' | 'memo_entry', payloadSchema: TSchema) {
  const envelope = {
    mutation_id: AnyUuidSchema,
    entity_type: Type.Literal(entityType),
    entity_id: AnyUuidSchema,
    ledger_id: Type.Null(),
    day_book_id: Type.Null(),
    memo_book_id: AnyUuidSchema,
    sync_id: Type.Optional(UuidSchema),
    base_revision: Type.Optional(Type.Integer({ minimum: 0 })),
    updated_at: TimestampSchema,
  };
  return Type.Union([
    Type.Object({ ...envelope, action: Type.Literal('upsert'), payload: payloadSchema }),
    Type.Object({
      ...envelope,
      action: Type.Literal('delete'),
      payload: entityType === 'memo_book' ? Type.Object({ expected_full_cursor: CursorSchema }) : Type.Object({}),
    }),
  ]);
}

/** 日子本及记录共用父本边界，删除本可携带完整快照前置条件。 */
function createDaySyncEntitySchema(entityType: 'day_book' | 'day_event', payloadSchema: TSchema) {
  const envelope = {
    mutation_id: AnyUuidSchema,
    entity_type: Type.Literal(entityType),
    entity_id: AnyUuidSchema,
    ledger_id: Type.Null(),
    day_book_id: AnyUuidSchema,
    sync_id: Type.Optional(UuidSchema),
    base_revision: Type.Optional(Type.Integer({ minimum: 0 })),
    updated_at: TimestampSchema,
  };
  return Type.Union([
    Type.Object({ ...envelope, action: Type.Literal('upsert'), payload: payloadSchema }),
    Type.Object({
      ...envelope,
      action: Type.Literal('delete'),
      payload: entityType === 'day_book' ? DayDeletePayloadSchema : Type.Object({}),
    }),
  ]);
}

/**
 * 为每种同步实体建立 upsert/delete 判别联合，生成客户端可直接使用的强类型载荷。
 *
 * 实体 id 由客户端生成：离线新建为 v4，CSV 导入、账本副本、派生成员等确定性 id 为 v5，
 * 数据库只要求合法 UUID，因此契约不限制版本，与拉取侧 SyncChangeEnvelopeSchema 一致。
 */
function createSyncEntitySchema(
  entityType: string,
  ledgerIdSchema: TSchema,
  payloadSchema: TSchema,
  entityIdSchema: TSchema = AnyUuidSchema,
) {
  return Type.Union([
    Type.Object({
      mutation_id: AnyUuidSchema,
      entity_type: Type.Literal(entityType),
      entity_id: entityIdSchema,
      ledger_id: ledgerIdSchema,
      // 云同步时间线身份：账本级变更必须携带（首次上云创建账本时可缺省），
      // 服务端校验与 Ledger.syncId 一致，不一致返回 412 SYNC_ID_MISMATCH
      sync_id: Type.Optional(UuidSchema),
      // 乐观并发基线版本：缺省=期望实体不存在（CREATE）；DELETE 同样参与 revision 状态机
      base_revision: Type.Optional(Type.Integer({ minimum: 0 })),
      action: Type.Literal('upsert'),
      updated_at: TimestampSchema,
      payload: payloadSchema,
    }),
    Type.Object({
      mutation_id: AnyUuidSchema,
      entity_type: Type.Literal(entityType),
      entity_id: entityIdSchema,
      ledger_id: ledgerIdSchema,
      sync_id: Type.Optional(UuidSchema),
      base_revision: Type.Optional(Type.Integer({ minimum: 0 })),
      action: Type.Literal('delete'),
      updated_at: TimestampSchema,
      payload:
        entityType === 'ledger'
          ? Type.Object({ expected_full_cursor: Type.Optional(CursorSchema) })
          : entityType === 'category'
            ? Type.Object({ base_token: Type.Optional(CategoryVersionTokenSchema) })
            : Type.Object({}),
    }),
  ]);
}

export type PushChange = SyncMutationEnvelope & {
  entity_type: (typeof SYNC_ENTITY_TYPES)[number];
};

/**
 * 单条 mutation 的执行结果（per-mutation 语义：一个 conflict/invalid 不阻塞同批其他实体）。
 * - accepted：已应用（携带服务端 revision）；
 * - ignored：幂等重放或语义 no-op（如删除不存在实体）；
 * - conflict：base_revision 与当前不匹配（携带 current_revision/current_deleted/current_entity 供 UI）；
 * - invalid：载荷校验类错误（per-mutation 捕获，不整批回滚）。
 */
export type { PushOutcome } from '../../shared/sync-mutation.js';
