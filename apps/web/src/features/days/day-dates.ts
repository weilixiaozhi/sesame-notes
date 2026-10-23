import type { components } from '@sesame-notes/api-client';
import { LunarDay, LunarMonth, LunarYear, SolarDay } from 'tyme4ts';

export type DayEvent = components['schemas']['DayEvent'];
export type DayBook = components['schemas']['DayBook'];
export type DayDate = NonNullable<DayEvent['event']>;
export type DayDefinition = Pick<
  DayEvent,
  | 'name'
  | 'category'
  | 'countdown_mode'
  | 'interval_days'
  | 'repeat_type'
  | 'statistic_type'
  | 'event'
  | 'start'
  | 'end'
  | 'created_at'
>;
export const dayLabels: Record<DayEvent['category'], string> = {
  birthday: '生日',
  anniversary: '纪念日',
  countdown: '倒数日',
  stage: '阶段',
};
const dayMilliseconds = 86_400_000;

/** 用本地年月日取得今天，避免时区偏移改变自然日。 */
export function todayDate(now = new Date()): string {
  return formatDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** 纯日期固定序列化，不经过本地时区转换。 */
function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 校验真实公历日期和应用支持区间。 */
export function validateSolar(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value < '1901-01-01' ||
    value > '2100-12-31'
  )
    throw new Error('请选择 1901 至 2100 年内的有效日期');
  return value;
}

/** 构造公历原始日期，保证投影和原始年月日一致。 */
export function solarDate(value: string): DayDate {
  validateSolar(value);
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return {
    calendar_type: 'solar',
    original_year: year,
    original_month: month,
    original_day: day,
    is_leap_month: false,
    solar_date: value,
  };
}

/** 农历转换先验证闰月和月长，绝不自动回落用户输入的非法日期。 */
export function projectDate(value: DayDate): DayDate {
  if (value.calendar_type === 'solar') return solarDate(value.solar_date);
  const { original_year: year, original_month: month, original_day: day, is_leap_month: leap } = value;
  try {
    if (
      ![year, month, day].every(Number.isInteger) ||
      year < 1900 ||
      year > 2100 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 30
    )
      throw new Error('日期超出范围');
    if (leap && LunarYear.fromYear(year).getLeapMonth() !== month) throw new Error('此年没有所选闰月');
    const lunarMonth = LunarMonth.fromYm(year, leap ? -month : month);
    if (day > lunarMonth.getDayCount()) throw new Error('所选农历月份没有这一天');
    const solar = LunarDay.fromYmd(year, leap ? -month : month, day).getSolarDay();
    return { ...value, solar_date: validateSolar(formatDate(solar.getYear(), solar.getMonth(), solar.getDay())) };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : '农历日期无效');
  }
}

/** 切换历法保留同一个实际日期，只改变原始表达。 */
export function convertCalendar(value: DayDate, calendar: DayDate['calendar_type']): DayDate {
  const projected = projectDate(value);
  if (calendar === 'solar') return solarDate(projected.solar_date);
  const solar = solarDate(projected.solar_date);
  const lunar = SolarDay.fromYmd(solar.original_year, solar.original_month, solar.original_day).getLunarDay();
  return {
    calendar_type: 'lunar',
    original_year: lunar.getYear(),
    original_month: lunar.getLunarMonth().getMonth(),
    original_day: lunar.getDay(),
    is_leap_month: lunar.getLunarMonth().isLeap(),
    solar_date: projected.solar_date,
  };
}

/** 自然日之间的差值使用 UTC 作为数值载体，避开夏令时。 */
export function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMilliseconds;
}

/** 含起日的倒数目标只产生一个日期。 */
export function intervalTarget(start: string, interval: number): string {
  if (!Number.isInteger(interval) || interval < 1 || interval > 36500) throw new Error('间隔需为 1 至 36500 天');
  validateSolar(start);
  return validateSolar(
    new Date(Date.parse(`${start}T00:00:00Z`) + (interval - 1) * dayMilliseconds).toISOString().slice(0, 10),
  );
}

/** 规范化类别组合并重新计算投影，保留创建时间与用户指定统计方式。 */
export function buildDefinition(value: DayDefinition): DayDefinition {
  const common = { ...value, name: value.name.trim() };
  if (value.category === 'birthday' || value.category === 'anniversary') {
    if (!value.event) throw new Error('请选择日期');
    return {
      ...common,
      repeat_type: 'yearly',
      countdown_mode: null,
      interval_days: null,
      event: projectDate(value.event),
      start: null,
      end: null,
    };
  }
  if (value.category === 'stage') {
    if (!value.start) throw new Error('请选择开始日期');
    const start = projectDate(value.start);
    const end = value.end ? projectDate(value.end) : null;
    if (end && end.solar_date < start.solar_date) throw new Error('结束日期不能早于开始日期');
    return { ...common, repeat_type: 'none', countdown_mode: null, interval_days: null, event: null, start, end };
  }
  if (value.countdown_mode === 'interval_days') {
    if (!value.start || !value.interval_days) throw new Error('请填写开始日期和间隔天数');
    const start = projectDate(value.start);
    intervalTarget(start.solar_date, value.interval_days);
    return { ...common, repeat_type: 'none', event: null, start, end: null };
  }
  if (!value.event) throw new Error('请选择目标日期');
  return {
    ...common,
    repeat_type: 'none',
    countdown_mode: 'fixed_date',
    interval_days: null,
    event: projectDate(value.event),
    start: null,
    end: null,
  };
}

/** 查找不早于今天与原始起点的下一次，农历闰月只在真实闰月年出现。 */
export function nextOccurrence(value: DayDefinition, today: string): string | null {
  const definition = buildDefinition(value);
  if (definition.category === 'stage') return null;
  const original = definition.event ?? definition.start;
  if (!original) return null;
  if (definition.countdown_mode === 'interval_days') {
    const target = intervalTarget(original.solar_date, definition.interval_days!);
    return target >= today ? target : null;
  }
  if (definition.repeat_type === 'none') return original.solar_date >= today ? original.solar_date : null;
  const lower = today > original.solar_date ? today : original.solar_date;
  const lowerDate = solarDate(lower);
  const firstYear =
    original.calendar_type === 'solar'
      ? lowerDate.original_year
      : SolarDay.fromYmd(lowerDate.original_year, lowerDate.original_month, lowerDate.original_day)
          .getLunarDay()
          .getYear();
  for (let year = firstYear; year <= 2100; year++) {
    let candidate: string;
    if (original.calendar_type === 'solar') {
      const lastDay = new Date(Date.UTC(year, original.original_month, 0)).getUTCDate();
      candidate = formatDate(year, original.original_month, Math.min(original.original_day, lastDay));
    } else {
      if (original.is_leap_month && LunarYear.fromYear(year).getLeapMonth() !== original.original_month) continue;
      const month = original.is_leap_month ? -original.original_month : original.original_month;
      const lunarMonth = LunarMonth.fromYm(year, month);
      const solar = LunarDay.fromYmd(
        year,
        month,
        Math.min(original.original_day, lunarMonth.getDayCount()),
      ).getSolarDay();
      candidate = formatDate(solar.getYear(), solar.getMonth(), solar.getDay());
    }
    if (candidate >= lower && candidate <= '2100-12-31') return candidate;
  }
  return null;
}

/** 同时保留农历原始年月日和公历投影，方便跨端核对。 */
export function dateLabel(value: DayDate | null): string {
  if (!value) return '未设置';
  return value.calendar_type === 'solar'
    ? value.solar_date
    : `农历 ${value.original_year} 年${value.is_leap_month ? '闰' : ''}${value.original_month} 月 ${value.original_day} 日（公历 ${value.solar_date}）`;
}

/** 用原始起点作年月锚点，月末不会在连续相加中漂移。 */
export function dateSpan(from: string, to: string): string {
  const earlier = solarDate(from <= to ? from : to);
  const later = solarDate(from <= to ? to : from);
  const anchor = (year: number, month: number) =>
    formatDate(year, month, Math.min(earlier.original_day, new Date(Date.UTC(year, month, 0)).getUTCDate()));
  let years = later.original_year - earlier.original_year;
  if (anchor(earlier.original_year + years, earlier.original_month) > later.solar_date) years--;
  let months = 0;
  let anchored = anchor(earlier.original_year + years, earlier.original_month);
  for (let candidate = 1; candidate <= 11; candidate++) {
    const monthIndex = (earlier.original_year + years) * 12 + earlier.original_month - 1 + candidate;
    const next = anchor(Math.floor(monthIndex / 12), (monthIndex % 12) + 1);
    if (next > later.solar_date) break;
    months = candidate;
    anchored = next;
  }
  const days = daysBetween(anchored, later.solar_date);
  return `${years ? `${years}年` : ''}${months ? `${months}个月` : ''}${days || (!years && !months) ? `${days}天` : ''}`;
}

/** 卡片数值只派生显示，阶段总长不加入起日，和客户端统计口径一致。 */
export function daySummary(event: DayEvent, today: string): { value: string; label: string; detail: string } {
  try {
    const definition = buildDefinition(event);
    const byYear = definition.statistic_type === 'year';
    const duration = (from: string, to: string) =>
      byYear ? dateSpan(from, to) : String(Math.abs(daysBetween(from, to)));
    const next = nextOccurrence(definition, today);
    if (next) {
      const count = daysBetween(today, next);
      return {
        value: count === 0 ? '今天' : duration(today, next),
        label: count === 0 ? '就是今天' : byYear ? '后到来' : '天后到来',
        detail: `下一次：${next}`,
      };
    }
    if (definition.category === 'stage' && definition.start) {
      const start = definition.start.solar_date;
      const end = definition.end?.solar_date;
      if (start > today)
        return {
          value: duration(today, start),
          label: byYear ? '后开始' : '天后开始',
          detail: dateLabel(definition.start),
        };
      return {
        value: duration(start, end ?? today),
        label: `${byYear ? '' : '天 · '}${end ? '阶段总长' : '已持续'}`,
        detail: end ? `${end < today ? '已结束' : '进行中'} · 结束：${end}` : '持续记录中',
      };
    }
    const original = definition.event ?? definition.start;
    const target =
      definition.countdown_mode === 'interval_days' && original
        ? intervalTarget(original.solar_date, definition.interval_days!)
        : original?.solar_date;
    if (definition.repeat_type === 'yearly')
      return { value: '—', label: '暂无下一次', detail: '支持范围内没有下一次日期' };
    return {
      value: target ? duration(target, today) : '—',
      label: byYear ? '已过去' : '天 · 已过去',
      detail: target ?? '未设置日期',
    };
  } catch {
    return { value: '—', label: '日期需要确认', detail: '请打开检查原始日期' };
  }
}
