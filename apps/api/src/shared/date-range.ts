import { Type, type Static } from '@sinclair/typebox';
import { TimestampSchema, isStrictTimestamp } from './contracts/scalars.js';
import { ApiError } from './errors.js';

export const DateRangeQuerySchema = Type.Object({
  start_at: Type.Optional(TimestampSchema),
  end_at: Type.Optional(TimestampSchema),
  time_zone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});
type DateRangeQuery = Static<typeof DateRangeQuerySchema>;

/** 校验 UTC 半开区间与 IANA 时区，供时间元数据聚合复用。 */
export function dateRange(query: DateRangeQuery) {
  const start = query.start_at ? new Date(query.start_at) : undefined;
  const end = query.end_at ? new Date(query.end_at) : undefined;
  if (
    (query.start_at && !isStrictTimestamp(query.start_at)) ||
    (query.end_at && !isStrictTimestamp(query.end_at)) ||
    (start && end && start >= end)
  ) {
    throw new ApiError(400, 'INVALID_DATE_RANGE', '时间范围必须是有效且递增的 UTC 时间');
  }
  const timeZone = query.time_zone ?? 'UTC';
  try {
    if (/^[+-]/.test(timeZone)) throw new Error('OFFSET_NOT_IANA');
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new ApiError(400, 'INVALID_TIME_ZONE', '请选择有效 IANA 时区');
  }
  return { start, end, timeZone };
}
