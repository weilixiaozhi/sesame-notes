import { Type } from '@sinclair/typebox';
import {
  AnyUuidSchema,
  PositiveAmountSchema,
  TimestampSchema,
  CurrencySchema,
  NameSchema,
  UuidSchema,
  UuidV5Schema,
  RATE_PATTERN,
} from './scalars.js';

export const TransactionTypeSchema = Type.Literal('expense');

/**
 * AA 分摊模式 wire 枚举：Dart 生成客户端只认字符串 wire 名（数值枚举会整包反序列化失败），
 * 契约恒以字符串 "0"/"1"/"2" 承载；数据库列保持整数存储，由 parseAaMode/formatAaMode 在边界转换。
 */
export const AaModeSchema = Type.Union([Type.Literal('0'), Type.Literal('1'), Type.Literal('2'), Type.Null()]);

type AaModeDb = 0 | 1 | 2 | null;

/** 把 wire 字符串 AA 模式转成数据库整数；null/undefined 表示未指定。 */
export function parseAaMode(value: unknown): AaModeDb {
  if (value === null || value === undefined) return null;
  if (value === '0') return 0;
  if (value === '1') return 1;
  if (value === '2') return 2;
  throw new Error('INVALID_AA_MODE');
}

export function formatAaMode(value: number | null | undefined): '0' | '1' | '2' | null {
  if (value === null || value === undefined) return null;
  return String(value) as '0' | '1' | '2';
}

export const TransactionSplitSchema = Type.Object(
  {
    // 分摊必须保留成员引用；成员退出或移除后仍由同一 ID 承载历史身份。
    member_id: AnyUuidSchema,
    amount: PositiveAmountSchema,
  },
  { $id: 'TransactionSplit' },
);

export const TransactionSchema = Type.Object(
  {
    id: AnyUuidSchema,
    ledger_id: AnyUuidSchema,
    tx_type: TransactionTypeSchema,
    amount: PositiveAmountSchema,
    happened_at: TimestampSchema,
    note: Type.Union([Type.String(), Type.Null()]),
    // 分类引用兼容确定性 UUIDv5（seed 默认分类派生 id），与 member 引用同口径
    category_id: Type.Union([AnyUuidSchema, Type.Null()]),
    category_name: Type.Union([Type.String(), Type.Null()]),
    category_kind: Type.Union([TransactionTypeSchema, Type.Null()]),
    currency_code: CurrencySchema,
    native_amount: PositiveAmountSchema,
    recurring_id: Type.Union([AnyUuidSchema, Type.Null()]),
    occurrence_date: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    // 账本级成员引用（UUID v4/v5 均兼容）
    created_by_member_id: Type.Union([AnyUuidSchema, Type.Null()]),
    last_edited_by_member_id: Type.Union([AnyUuidSchema, Type.Null()]),
    payer_member_id: Type.Union([AnyUuidSchema, Type.Null()]),
    aa_mode: AaModeSchema,
    splits: Type.Array(Type.Ref(TransactionSplitSchema)),
    revision: Type.Integer({ minimum: 1 }),
    last_edited_at: Type.Union([TimestampSchema, Type.Null()]),
    updated_at: TimestampSchema,
    created_at: TimestampSchema,
  },
  { $id: 'Transaction' },
);

export const CategorySchema = Type.Object(
  {
    // 分类 id 兼容固定 namespace 与 cat:expense:level:key 派生的默认分类 UUIDv5
    id: AnyUuidSchema,
    owner_id: Type.Optional(AnyUuidSchema),
    name: NameSchema,
    kind: TransactionTypeSchema,
    level: Type.Union([Type.Literal(1), Type.Literal(2)]),
    sort_order: Type.Integer(),
    icon: Type.Union([Type.String(), Type.Null()]),
    parent_id: Type.Union([AnyUuidSchema, Type.Null()]),
    updated_at: TimestampSchema,
    deleted_at: Type.Union([TimestampSchema, Type.Null()]),
    version_token: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  },
  { $id: 'Category' },
);

export const RecurringTransactionSchema = Type.Object(
  {
    id: AnyUuidSchema,
    ledger_id: AnyUuidSchema,
    tx_type: TransactionTypeSchema,
    amount: PositiveAmountSchema,
    currency_code: CurrencySchema,
    category_id: Type.Union([AnyUuidSchema, Type.Null()]),
    note: Type.Union([Type.String(), Type.Null()]),
    frequency: Type.Union([
      Type.Literal('daily'),
      Type.Literal('weekly'),
      Type.Literal('monthly'),
      Type.Literal('yearly'),
    ]),
    interval: Type.Integer({ minimum: 1 }),
    day_of_month: Type.Union([Type.Integer({ minimum: 1, maximum: 31 }), Type.Null()]),
    day_of_week: Type.Union([Type.Integer({ minimum: 1, maximum: 7 }), Type.Null()]),
    month_of_year: Type.Union([Type.Integer({ minimum: 1, maximum: 12 }), Type.Null()]),
    start_date: TimestampSchema,
    end_date: Type.Union([TimestampSchema, Type.Null()]),
    last_generated_date: Type.Union([TimestampSchema, Type.Null()]),
    protocol_version: Type.Literal(1),
    time_zone: Type.String({ minLength: 1, maxLength: 100 }),
    enabled: Type.Boolean(),
    updated_at: TimestampSchema,
  },
  { $id: 'RecurringTransaction' },
);

export const MemberSchema = Type.Object(
  {
    id: AnyUuidSchema,
    ledger_id: AnyUuidSchema,
    display_name: NameSchema,
    member_type: Type.Union([Type.Literal('REGISTERED'), Type.Literal('PLACEHOLDER')]),
    status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('LEFT'), Type.Literal('REMOVED')]),
    updated_at: TimestampSchema,
  },
  { $id: 'Member' },
);

export const ExchangeRateOverrideSchema = Type.Object(
  {
    id: UuidV5Schema,
    base_currency: CurrencySchema,
    quote_currency: CurrencySchema,
    rate: Type.String({ pattern: RATE_PATTERN, maxLength: 39 }),
    updated_at: TimestampSchema,
  },
  { $id: 'ExchangeRateOverride' },
);

export const LedgerSchema = Type.Object(
  {
    id: AnyUuidSchema,
    owner_id: Type.Optional(AnyUuidSchema),
    sync_id: UuidSchema,
    name: NameSchema,
    currency: CurrencySchema,
    month_start_day: Type.Integer({ minimum: 1, maximum: 31 }),
    aa_enabled: Type.Boolean(),
    archived_at: Type.Union([TimestampSchema, Type.Null()]),
    archive_updated_at: Type.Union([TimestampSchema, Type.Null()]),
    archive_device_id: Type.Union([UuidSchema, Type.Null()]),
    role: Type.Union([Type.Literal('owner'), Type.Literal('editor')]),
    member_count: Type.Integer({ minimum: 1 }),
    updated_at: TimestampSchema,
  },
  { $id: 'Ledger' },
);
