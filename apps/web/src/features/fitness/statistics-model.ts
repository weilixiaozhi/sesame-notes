import { localToday } from './fitness-model';

export type Period = 'week' | 'month' | 'year';
/** 纯日期使用 UTC 算术，避免浏览器时区与夏令时造成跨日偏移。 */
export function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
/** 周从周一开始；月、年使用自然边界，与手机统计一致。 */
export function periodRange(period: Period, anchor = localToday()) {
  const point = new Date(`${anchor}T12:00:00Z`);
  const start = new Date(point);
  const end = new Date(point);
  if (period === 'week') {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    end.setTime(start.getTime());
    end.setUTCDate(end.getUTCDate() + 6);
  } else if (period === 'month') {
    start.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
  } else {
    start.setUTCMonth(0, 1);
    end.setUTCMonth(11, 31);
  }
  start.setTime(Math.max(start.getTime(), new Date('0001-01-01T12:00:00Z').getTime()));
  end.setTime(Math.min(end.getTime(), new Date('9999-12-31T12:00:00Z').getTime()));
  return { start: dateKey(start), end: dateKey(end) };
}
/** 导航先取周期边界，因此月末前后切换不会跳过二月。 */
export function shiftPeriod(period: Period, anchor: string, amount: number): string {
  const point = new Date(`${periodRange(period, anchor).start}T12:00:00Z`);
  if (period === 'week') point.setUTCDate(point.getUTCDate() + amount * 7);
  else if (period === 'month') point.setUTCMonth(point.getUTCMonth() + amount);
  else point.setUTCFullYear(point.getUTCFullYear() + amount);
  return dateKey(point);
}
/** 日历补齐周一至周日的六周以内范围，兼顾跨月训练安排。 */
export function calendarRange(anchor: string) {
  const month = periodRange('month', anchor);
  const start = month.start === '0001-01-01' ? month.start : periodRange('week', month.start).start;
  const end = month.end === '9999-12-31' ? month.end : periodRange('week', month.end).end;
  const dates: string[] = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const lastInstant = new Date(`${end}T12:00:00Z`).getTime();
  while (cursor.getTime() <= lastInstant) {
    dates.push(dateKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { start, end, dates, monthStart: month.start, monthEnd: month.end };
}
/** 十位小数整数相加，展示负重总量不会因浮点而丢失精度。 */
export function sumVolume(values: readonly string[]): string {
  const precision = 10_000_000_000n;
  const sum = values.reduce((total, value) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return total + BigInt(whole) * precision + BigInt(fraction.padEnd(10, '0'));
  }, 0n);
  const fraction = (sum % precision).toString().padStart(10, '0').replace(/0+$/, '');
  return `${sum / precision}${fraction ? `.${fraction}` : ''}`;
}
/** 训练时长保留到分钟，不把尚在执行的训练混入已完成汇总。 */
export function durationLabel(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
export const musclePart: Record<string, string> = {
  pectorals: 'chest',
  'serratus anterior': 'chest',
  'levator scapulae': 'neck',
  neck: 'neck',
  delts: 'shoulders',
  biceps: 'upper arms',
  triceps: 'upper arms',
  forearms: 'lower arms',
  abs: 'waist',
  glutes: 'upper legs',
  adductors: 'upper legs',
  abductors: 'upper legs',
  hamstrings: 'upper legs',
  quads: 'upper legs',
  calves: 'lower legs',
  traps: 'back',
  'upper back': 'back',
  lats: 'back',
  spine: 'back',
};
