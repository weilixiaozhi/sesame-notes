import { Type } from '@sinclair/typebox';
import { MAX_NAME_LENGTH } from '../text-validation.js';
import { ApiError } from '../errors.js';

export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const UUID_V5_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const AMOUNT_PATTERN = '^(?:0|[1-9][0-9]{0,27})(?:\\.[0-9]{0,9}[1-9])?$';
export const POSITIVE_AMOUNT_PATTERN = '^(?:0\\.(?:[0-9]{0,9}[1-9])|[1-9][0-9]{0,27}(?:\\.[0-9]{0,9}[1-9])?)$';
export const RATE_PATTERN = '^(?:0\\.(?:[0-9]{0,17}[1-9])|[1-9][0-9]{0,19}(?:\\.[0-9]{0,17}[1-9])?)$';

/**
 * ID 契约规则（所有 schema 一律遵循，不要按字段各写一套）：
 *
 * 优先级：**真实不变量 > 提供方**。先看数据库/派生算法是否强制了形态，再看 id 由谁生成。
 *
 * 1. **客户端提供、且没有不变量约束的标识只校验 UUID 形状 → {@link AnyUuidSchema}**
 *    实体 id、父本引用、路径参数、幂等 nonce 都属此类。原因是系统有两类合法的 id 生成策略：
 *    - 随机 v4：离线新建、没有业务键的实体；
 *    - 确定性 v5：必须能被独立复算的标识（REGISTERED 成员由 ledger+账号派生、seed 默认分类、
 *      汇率覆盖由账号+币种对派生、CSV 导入与账本副本的幂等 id）。
 *    版本是生产方的内部实现，边界不该限制它；数据库只要求合法 UUID。
 * 2. **服务端生成、客户端从不提供的权威标识保持 v4 → {@link UuidSchema}**
 *    如 user_id、device_id、ledger.sync_id、审计与代际 id。
 * 3. **不变量强制了形态的按不变量校验（即使 id 由客户端生成）→ {@link VersionedUuidSchema} / {@link UuidV5Schema} 等**
 *    汇率覆盖 id 必须等于共享算法派生值（entity-id.ts 校验），REGISTERED 成员 id 必须等于
 *    uuid_generate_v5(ledger_id, 'user:'||account_id)（数据库 CHECK），catalog_origin.item_id 必须是
 *    带变体位的 v4/v5。接口提前拒绝，避免约束冲突以 500 暴露给客户端。
 */
export const UuidSchema = Type.String({ pattern: UUID_PATTERN, examples: ['018f7f95-4b8a-4f5e-8d0c-2ebf4682c761'] });
// 任意版本 UUID（v4/v5 通用）：实体 id、父本引用与客户端幂等 nonce 均使用
export const ANY_UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const AnyUuidSchema = Type.String({
  pattern: ANY_UUID_PATTERN,
  examples: ['056cf10d-2d59-599c-9d97-6749e866aa52'],
});
// v4/v5 且带 RFC 4122 变体位：数据库不变量按同一规则校验 catalog_origin.item_id，
// 接口必须提前拒绝，否则约束冲突会以 500 暴露给客户端。
const VERSIONED_UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const VersionedUuidSchema = Type.String({
  pattern: VERSIONED_UUID_PATTERN,
  examples: ['11111111-1111-4111-8111-000000000001'],
});
/** 必须由共享算法派生的实体 id（汇率覆盖）：多设备/重装都要收敛到同一实体。 */
export const UuidV5Schema = Type.String({
  pattern: UUID_V5_PATTERN,
  examples: ['1527ffc3-6087-5b6b-99c6-c6837a5db1b6'],
});
export const AmountSchema = Type.String({ pattern: AMOUNT_PATTERN, maxLength: 39 });
export const PositiveAmountSchema = Type.String({ pattern: POSITIVE_AMOUNT_PATTERN, maxLength: 39 });
export const TimestampSchema = Type.String({
  format: 'date-time',
  pattern: TIMESTAMP_PATTERN,
  examples: ['2026-08-20T09:00:00.000Z'],
});
export const CursorSchema = Type.String({ pattern: '^(?:0|[1-9][0-9]*)$' });
// 空白与可见性由 normalizeName 统一处理，保留各入口既有错误映射。
export const NameSchema = Type.String({ maxLength: MAX_NAME_LENGTH });
const CURRENCY_PATTERN = '^[A-Z]{3}$';
export const CurrencySchema = Type.String({ pattern: CURRENCY_PATTERN });

/** 解析数据库序号游标，限制为 PostgreSQL bigint 可表示的规范非负整数。 */
export function parseDatabaseCursor(value: string): bigint {
  try {
    if (!/^(?:0|[1-9]\d{0,18})$/.test(value)) {
      throw new ApiError(400, 'INVALID_CURSOR', '游标无效或超出范围');
    }
    const cursor = BigInt(value);
    if (cursor > 9_223_372_036_854_775_807n) {
      throw new ApiError(400, 'INVALID_CURSOR', '游标无效或超出范围');
    }
    return cursor;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw new Error('数据库游标解析失败', { cause });
  }
}

/**
 * 严格时间戳判定：只接受与 TIMESTAMP_PATTERN 完全一致、且能被 Date 原样回读的 UTC 毫秒文本。
 * 排除 '2026-01-01'、带时区偏移和 0000 年，避免宽松解析改写客户端事实。
 */
export function isStrictTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !new RegExp(TIMESTAMP_PATTERN).test(value) || value.startsWith('0000')) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

/** 所有业务共用的严格时间戳解析；错误码与提示语由调用入口决定。 */
export function parseStrictTimestamp(value: unknown, code: string, message: string): Date {
  if (!isStrictTimestamp(value)) throw new ApiError(400, code, message);
  return new Date(value as string);
}
