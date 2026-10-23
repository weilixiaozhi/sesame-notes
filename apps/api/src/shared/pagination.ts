import { ANY_UUID_PATTERN, isStrictTimestamp } from './contracts/scalars.js';

export type TransactionCursor = { happenedAt: Date; id: string };

/** 把交易的两个排序键编码为版本化不透明游标，避免客户端依赖数据库主键分页细节。 */
export function encodeTransactionCursor(value: TransactionCursor): string {
  try {
    const timestamp = value.happenedAt.toISOString();
    if (!isStrictTimestamp(timestamp) || !new RegExp(ANY_UUID_PATTERN).test(value.id)) {
      throw new Error('INVALID_CURSOR');
    }
    return Buffer.from(JSON.stringify({ v: 1, t: timestamp, i: value.id }), 'utf8').toString('base64url');
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_CURSOR') throw error;
    throw new Error('INVALID_CURSOR', { cause: error });
  }
}

/** 解码并完整校验交易游标；任何未知版本或宽松日期写法都明确失败，防止分页静默跳项。 */
export function decodeTransactionCursor(cursor: string): TransactionCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isCursorPayload(parsed)) throw new Error('INVALID_CURSOR');
    return { happenedAt: new Date(parsed.t), id: parsed.i };
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_CURSOR') throw error;
    throw new Error('INVALID_CURSOR', { cause: error });
  }
}

/** 用显式字段白名单验证游标载荷，拒绝类型欺骗和未来版本被旧服务误读。 */
function isCursorPayload(value: unknown): value is { v: 1; t: string; i: string } {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  return (
    payload.v === 1 &&
    typeof payload.t === 'string' &&
    isStrictTimestamp(payload.t) &&
    typeof payload.i === 'string' &&
    new RegExp(ANY_UUID_PATTERN).test(payload.i)
  );
}
