import { normalizeName } from '../../shared/text-validation.js';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { LunarDay, LunarMonth, LunarYear } from 'tyme4ts';

import { ApiError } from '../../shared/errors.js';
import { isStrictTimestamp } from '../../shared/contracts/scalars.js';
import {
  DAY_DATE_PATTERN,
  DAY_MAX_DATE,
  DAY_MAX_INTERVAL,
  DAY_MIN_DATE,
  DayEventPayloadSchema,
  type DayDate,
  type DayEventDefinition,
} from './day-event-schemas.js';

const MILLISECONDS_PER_DAY = 86400000;
const StaticDayDefinitionSchema = Type.Object({
  ...DayEventPayloadSchema.properties,
  // 字符上限由 normalizeDayName 按码点检查，避免 TypeBox 按 UTF-16 误拒表情。
  name: Type.String(),
  created_at: Type.String(),
});

/** 规范化日子名称并按 Unicode 码点限制长度。 */
export function normalizeDayName(value: unknown): string {
  try {
    return normalizeName(value);
  } catch {
    throw new ApiError(400, 'INVALID_DAY_NAME', '名称格式不正确');
  }
}

/** 严格验证公历年月日及支持范围，UTC 仅作为 DATE 的数值载体。 */
function parseSolarDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !new RegExp(DAY_DATE_PATTERN).test(value) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value ||
    value < DAY_MIN_DATE ||
    value > DAY_MAX_DATE
  ) {
    throw new ApiError(400, 'INVALID_DAY_DATE', '日期无效或超出支持范围');
  }
  return date;
}

/** 从原始定义重新验证纯日期投影；日期库失败保留根因交给同步日志边界。 */
function validateDate(date: DayDate | null): void {
  if (!date) return;
  try {
    parseSolarDate(date.solar_date);
    if (date.calendar_type === 'solar') {
      const expected = `${date.original_year.toString().padStart(4, '0')}-${date.original_month.toString().padStart(2, '0')}-${date.original_day.toString().padStart(2, '0')}`;
      if (date.is_leap_month || expected !== date.solar_date)
        throw new ApiError(400, 'INVALID_DAY_DATE', '原始日期与公历投影不一致');
    } else {
      // 库的负月份仅在此转换为闰月，业务定义始终使用正数月份和独立闰标志。
      const month = date.is_leap_month ? -date.original_month : date.original_month;
      if (date.is_leap_month && LunarYear.fromYear(date.original_year).getLeapMonth() !== date.original_month)
        throw new ApiError(400, 'INVALID_DAY_DATE', '指定农历年没有该闰月');
      const lunarMonth = LunarMonth.fromYm(date.original_year, month);
      if (lunarMonth.getMonthWithLeap() !== month || date.original_day > lunarMonth.getDayCount())
        throw new ApiError(400, 'INVALID_DAY_DATE', '农历月份或日期不存在');
      const solar = LunarDay.fromYmd(date.original_year, month, date.original_day).getSolarDay();
      const projected = `${solar.getYear().toString().padStart(4, '0')}-${solar.getMonth().toString().padStart(2, '0')}-${solar.getDay().toString().padStart(2, '0')}`;
      if (projected !== date.solar_date) throw new ApiError(400, 'INVALID_DAY_DATE', '原始农历日期与公历投影不一致');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('日子历法校验失败', { cause: error });
  }
}

/** 静态校验完整日子定义，不读取设备今天，也不替换非法原始日期。 */
export function validateDayEvent(value: unknown): DayEventDefinition {
  if (!Value.Check(StaticDayDefinitionSchema, value) || !isStrictTimestamp(value.created_at))
    throw new ApiError(400, 'INVALID_DAY_DEFINITION', '日子定义不完整');
  const definition = { ...value, name: normalizeDayName(value.name) };
  const {
    category,
    countdown_mode: mode,
    interval_days: interval,
    repeat_type: repeat,
    event,
    start,
    end,
  } = definition;
  [event, start, end].forEach(validateDate);
  let valid = false;
  if (category === 'birthday' || category === 'anniversary') {
    valid =
      event !== null && start === null && end === null && mode === null && interval === null && repeat === 'yearly';
  } else if (category === 'stage') {
    valid =
      event === null &&
      start !== null &&
      mode === null &&
      interval === null &&
      repeat === 'none' &&
      (end === null || end.solar_date >= start.solar_date);
  } else if (mode === 'fixed_date') {
    valid = event !== null && start === null && end === null && interval === null && repeat === 'none';
  } else if (mode === 'interval_days') {
    valid =
      event === null &&
      start !== null &&
      end === null &&
      interval !== null &&
      interval >= 1 &&
      interval <= DAY_MAX_INTERVAL &&
      repeat === 'none';
    if (valid && start && interval !== null) {
      // 首目标包含起日，不能把越界目标钳制成支持范围最后一天。
      valid =
        parseSolarDate(start.solar_date).getTime() + (interval - 1) * MILLISECONDS_PER_DAY <=
        parseSolarDate(DAY_MAX_DATE).getTime();
    }
  }
  if (!valid) throw new ApiError(400, 'INVALID_DAY_DEFINITION', '日子类型、循环或日期组合无效');
  return definition;
}
