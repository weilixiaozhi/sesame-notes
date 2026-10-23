import type { Prisma } from '@prisma/client';
import { Type, type Static } from '@sinclair/typebox';
import { AnyUuidSchema, CurrencySchema, TimestampSchema, isStrictTimestamp } from '../../shared/contracts/scalars.js';
import { ApiError } from '../../shared/errors.js';

export const TransactionQuerySchema = Type.Object({
  start_at: Type.Optional(TimestampSchema),
  end_at: Type.Optional(TimestampSchema),
  payer_member_id: Type.Optional(AnyUuidSchema),
  aa_mode: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
  currency_code: Type.Optional(CurrencySchema),
  category_id: Type.Optional(Type.Union([AnyUuidSchema, Type.Literal('uncategorized')])),
  time_zone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});
export type TransactionQuery = Static<typeof TransactionQuerySchema>;

/** 明细和统计共享筛选条件；时间采用左闭右开 UTC 区间，金额保留数据库精度。 */
export function transactionQueryWhere(query: TransactionQuery): Prisma.TransactionWhereInput {
  try {
    if ((query.start_at && !isStrictTimestamp(query.start_at)) || (query.end_at && !isStrictTimestamp(query.end_at))) {
      throw new ApiError(400, 'INVALID_TRANSACTION_RANGE', '日期必须是有效的 UTC 时间');
    }
    const start = query.start_at ? new Date(query.start_at) : undefined;
    const end = query.end_at ? new Date(query.end_at) : undefined;
    if (start && end && start >= end) throw new ApiError(400, 'INVALID_TRANSACTION_RANGE', '结束时间必须晚于开始时间');
    return {
      ...(query.payer_member_id ? { payerMemberId: query.payer_member_id } : {}),
      ...(query.aa_mode === 0
        ? { AND: [{ OR: [{ aaMode: 0 }, { aaMode: null }] }] }
        : query.aa_mode !== undefined
          ? { aaMode: query.aa_mode }
          : {}),
      ...(start || end ? { happenedAt: { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } } : {}),
      ...(query.currency_code ? { currencyCode: query.currency_code } : {}),
      ...(query.category_id ? { categoryId: query.category_id === 'uncategorized' ? null : query.category_id } : {}),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('解析交易筛选条件失败', { cause: error });
  }
}
