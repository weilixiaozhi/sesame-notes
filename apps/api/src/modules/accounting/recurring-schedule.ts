import { createHash } from 'node:crypto';
import { ApiError } from '../../shared/errors.js';

export type RecurringSchedule = {
  frequency: string;
  interval: number;
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  monthOfYear: number | null;
  startDate: Date;
  endDate: Date | null;
  lastGeneratedDate: Date | null;
  enabled: boolean;
  deletedAt: Date | null;
};
const dayMs = 86_400_000;

/** 日历日使用 UTC 零点承载，避免设备或宿主机时区改变排期。 */
export function recurringDate(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** 校验显式日历日期，拒绝日期自动溢出或协议范围之外的年份。 */
export function parseOccurrenceDate(value: unknown): Date {
  try {
    if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) throw new Error('date');
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('date');
    return parsed;
  } catch {
    throw new ApiError(400, 'INVALID_OCCURRENCE_DATE', '周期发生日期无效');
  }
}

/** 固定 SHA-256 种子与 UUID 位，确保双端、重试与并发生成只有一个发生身份。 */
export function recurringOccurrenceId(ledgerId: string, ruleId: string, date: string): string {
  const bytes = createHash('sha256')
    .update(`sesame-notes:recurring:v1:${ledgerId.toLowerCase()}:${ruleId.toLowerCase()}:${date}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 只接受可解析的 IANA 时区或 UTC；固定偏移与宿主默认时区不能成为规则身份。 */
export function validateRecurringTimeZone(value: unknown): string {
  try {
    if (typeof value !== 'string' || value.length > 100 || (value !== 'UTC' && !value.includes('/')))
      throw new Error('time_zone');
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value;
  } catch {
    throw new ApiError(400, 'INVALID_RECURRING_TIME_ZONE', '请选择有效的 IANA 时区');
  }
}

/** 按规则时区读取公历日，返回仅承载年月日的 UTC 值。 */
export function recurringToday(timeZone: string, instant: Date): Date {
  try {
    const values = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: validateRecurringTimeZone(timeZone),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(instant)
        .map((part) => [part.type, part.value]),
    );
    return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error('周期账单时区日期解析失败', { cause: error });
  }
}

/** 二分查找当地日开始；被夏令时跳过的零点或整天映射到下一个存在的瞬时。 */
export function recurringOccurrenceInstant(date: Date, timeZone: string): Date {
  let low = date.getTime() - 2 * dayMs;
  let high = date.getTime() + 2 * dayMs;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (recurringToday(timeZone, new Date(middle)) < date) low = middle + 1;
    else high = middle;
  }
  return new Date(low);
}

/** 月末向实际最后一天收敛，下一期仍使用原始锚点，不能因二月永久漂移。 */
function monthDate(year: number, month: number, day: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last)));
}

/** 从连续游标后的首个日期计算下一期；开始日补齐、结束日含当天，每月和每年按原锚点计算。 */
export function nextRecurringDate(rule: RecurringSchedule, today: Date): Date | null {
  try {
    if (!rule.enabled || rule.deletedAt !== null) return null;
    const start = recurringDate(rule.startDate);
    parseOccurrenceDate(start.toISOString().slice(0, 10));
    if (rule.endDate) parseOccurrenceDate(recurringDate(rule.endDate).toISOString().slice(0, 10));
    if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 10000)
      throw new ApiError(400, 'INVALID_RECURRING_INTERVAL', '周期间隔须为 1 到 10000');
    const previous = rule.lastGeneratedDate && recurringDate(rule.lastGeneratedDate);
    const lower = previous && previous >= start ? new Date(previous.getTime() + dayMs) : start;
    const targetDay = rule.dayOfMonth ?? start.getUTCDate();
    let candidate: Date;
    if (rule.frequency === 'daily') {
      candidate = new Date(
        start.getTime() +
          Math.ceil((lower.getTime() - start.getTime()) / dayMs / rule.interval) * rule.interval * dayMs,
      );
    } else if (rule.frequency === 'weekly') {
      const weekday = rule.dayOfWeek ?? ((start.getUTCDay() + 6) % 7) + 1;
      const first = new Date(start.getTime() + ((weekday - (((start.getUTCDay() + 6) % 7) + 1) + 7) % 7) * dayMs);
      candidate = new Date(
        first.getTime() +
          Math.max(0, Math.ceil((lower.getTime() - first.getTime()) / dayMs / (7 * rule.interval))) *
            7 *
            rule.interval *
            dayMs,
      );
    } else if (rule.frequency === 'monthly') {
      const delta = (lower.getUTCFullYear() - start.getUTCFullYear()) * 12 + lower.getUTCMonth() - start.getUTCMonth();
      let periods = Math.floor(delta / rule.interval);
      candidate = monthDate(start.getUTCFullYear(), start.getUTCMonth() + periods * rule.interval, targetDay);
      if (candidate < lower)
        candidate = monthDate(start.getUTCFullYear(), start.getUTCMonth() + ++periods * rule.interval, targetDay);
    } else if (rule.frequency === 'yearly') {
      const month = (rule.monthOfYear ?? start.getUTCMonth() + 1) - 1;
      let periods = Math.floor((lower.getUTCFullYear() - start.getUTCFullYear()) / rule.interval);
      candidate = monthDate(start.getUTCFullYear() + periods * rule.interval, month, targetDay);
      if (candidate < lower)
        candidate = monthDate(start.getUTCFullYear() + ++periods * rule.interval, month, targetDay);
    } else throw new ApiError(400, 'INVALID_RECURRING_FREQUENCY', '周期频率无效');
    if (
      candidate.getUTCFullYear() > 9999 ||
      candidate > recurringDate(today) ||
      (rule.endDate && candidate > recurringDate(rule.endDate))
    )
      return null;
    return candidate;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'INVALID_RECURRING_SCHEDULE', '周期账单日期或排期无效');
  }
}
