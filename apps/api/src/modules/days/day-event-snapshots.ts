import type { DayEvent } from '@prisma/client';

import type { DayDate } from './day-event-schemas.js';

/** 只用 UTC 年月日序列化数据库 DATE，不经过运行主机时区。 */
function dateSnapshot(row: DayEvent, prefix: 'event' | 'start' | 'end'): DayDate | null {
  const solar = row[`${prefix}SolarDate`];
  if (!solar) return null;
  return {
    calendar_type: row[`${prefix}CalendarType`] as DayDate['calendar_type'],
    original_year: row[`${prefix}OriginalYear`]!,
    original_month: row[`${prefix}OriginalMonth`]!,
    original_day: row[`${prefix}OriginalDay`]!,
    is_leap_month: row[`${prefix}IsLeapMonth`]!,
    solar_date: solar.toISOString().slice(0, 10),
  };
}

/** 日子增量、冲突和 full 共用完整权威定义，包含墓碑当前版本。 */
export function dayEventSnapshot(row: DayEvent, syncId: string) {
  return {
    id: row.id,
    day_book_id: row.dayBookId,
    sync_id: syncId,
    name: row.name,
    category: row.category,
    countdown_mode: row.countdownMode,
    interval_days: row.intervalDays,
    repeat_type: row.repeatType,
    statistic_type: row.statisticType,
    event: dateSnapshot(row, 'event'),
    start: dateSnapshot(row, 'start'),
    end: dateSnapshot(row, 'end'),
    revision: row.revision,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    deleted_at: row.deletedAt?.toISOString() ?? null,
  };
}
