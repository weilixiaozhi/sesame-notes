import type { Prisma } from '@prisma/client';
import { ApiError } from '../../shared/errors.js';
import { ANY_UUID_PATTERN, POSITIVE_AMOUNT_PATTERN, parseStrictTimestamp } from '../../shared/contracts/scalars.js';
import { compareSyncVersion } from '../../shared/sync-timestamps.js';
import type { PushChange } from './sync-schemas.js';

/** 单实体投影结果：applied 后由调用方创建事件；conflict 由调用方转为 per-mutation 结果。 */
export type ApplyOutcome = {
  status: 'applied' | 'ignored' | 'conflict';
  noChange?: boolean;
  category_state?: unknown;
  category_conflict?: unknown;
  category_resolution?: unknown;
  revision?: number;
  current_revision?: number;
  current_deleted?: boolean;
  current_entity?: unknown;
  changeId?: bigint;
  updatedAt?: Date;
  /** 已保存实体的权威快照，供同步事件与完整快照使用相同字段。 */
  payload?: Prisma.InputJsonValue;
};

/** 判断客户端版本是否严格更新；完全相同的版本视为幂等回放。 */
export function isNewer(
  incomingAt: Date,
  incomingDevice: string | null,
  currentAt: Date,
  currentDevice: string | null,
): boolean {
  return (
    compareSyncVersion(
      { updatedAt: incomingAt, deviceId: incomingDevice },
      { updatedAt: currentAt, deviceId: currentDevice ?? '' },
    ) > 0
  );
}

/** 读取账本当前的云同步身份；账本不存在时返回 undefined。 */
export async function currentLedgerSyncId(tx: Prisma.TransactionClient, ledgerId: string): Promise<string | undefined> {
  return (
    await tx.ledger.findUnique({
      where: { id: ledgerId },
      select: { syncId: true },
    })
  )?.syncId;
}

/** 识别 Prisma 唯一约束冲突（P2002），用于并发创建撞主键时的冲突归因。 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002'
  );
}

export function requireLedgerId(change: PushChange): string {
  if (!change.ledger_id) throw new ApiError(400, 'LEDGER_ID_REQUIRED', `${change.entity_type} 必须提供 ledger_id`);
  return change.ledger_id;
}

function requiredString(payload: Record<string, unknown>, key: string, maxLength: number): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength)
    throw new ApiError(400, 'INVALID_SYNC_PAYLOAD', `${key} 字段无效`);
  return value.trim();
}

export function optionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_SYNC_PAYLOAD', `${key} 字段无效`);
  return value;
}

export function requiredCurrency(payload: Record<string, unknown>, key: string): string {
  const value = requiredString(payload, key, 3);
  if (!/^[A-Z]{3}$/.test(value)) throw new ApiError(400, 'INVALID_CURRENCY', `${key} 必须是三位大写币种代码`);
  return value;
}

/** 按已有金额或汇率契约读取规范 Decimal 字符串，禁止数字 JSON、指数与非十进制形式。 */
export function requiredDecimal(
  payload: Record<string, unknown>,
  key: string,
  pattern = POSITIVE_AMOUNT_PATTERN,
): string {
  const value = payload[key];
  if (typeof value !== 'string' || !new RegExp(pattern).test(value))
    throw new ApiError(400, 'INVALID_DECIMAL', `${key} 必须是规范正 Decimal 字符串`);
  return value;
}

export function requiredInteger(
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = payload[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new ApiError(400, 'INVALID_SYNC_PAYLOAD', `${key} 字段无效`);
  return value as number;
}

/** 可空整数字段复用明确的业务范围校验，缺省和 null 保持为空。 */
export function optionalInteger(
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  return requiredInteger(payload, key, minimum, maximum);
}

export function requiredBoolean(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (typeof value !== 'boolean') throw new ApiError(400, 'INVALID_SYNC_PAYLOAD', `${key} 字段无效`);
  return value;
}

export function requiredEnum(payload: Record<string, unknown>, key: string, values: string[]): string {
  const value = payload[key];
  if (typeof value !== 'string' || !values.includes(value))
    throw new ApiError(400, 'INVALID_SYNC_PAYLOAD', `${key} 字段无效`);
  return value;
}

/** 读取可空实体引用 UUID；分类、成员与周期模板均兼容客户端派生的 UUIDv5。 */
export function optionalAnyUuid(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !new RegExp(ANY_UUID_PATTERN).test(value)) {
    throw new ApiError(400, 'INVALID_UUID', `${key} 字段不是规范 UUID`);
  }
  return value;
}

/** 读取必填 UTC 时间。 */
export function requiredDate(payload: Record<string, unknown>, key: string): Date {
  return parseStrictTimestamp(payload[key], 'INVALID_TIMESTAMP', `${key} 字段无效`);
}

/** 读取可空 UTC 时间。 */
export function optionalDate(payload: Record<string, unknown>, key: string): Date | null {
  if (payload[key] === undefined || payload[key] === null) return null;
  return requiredDate(payload, key);
}
