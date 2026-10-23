import type { paths } from '@sesame-notes/api-client';
import { billingRange, customDateRange } from './accounting-periods';
import { displayAmount } from './money';
export type AccountingStats =
  paths['/api/v1/ledgers/{ledger_id}/transaction-stats']['get']['responses'][200]['content']['application/json'];
const scale = 10_000_000_000n;

/** 金额扩大十位小数后用整数进行比例计算，不将账务值转换为浮点数。 */
export function amountUnits(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * scale + BigInt(fraction.padEnd(10, '0'));
}

/** 图表仅将有界百分比转成浮点坐标，原始金额始终保持十进制字符串。 */
export function amountPercent(value: string, total: string): number {
  const denominator = amountUnits(total);
  return denominator === 0n ? 0 : Number((amountUnits(value) * 10_000n) / denominator) / 100;
}

/** 日均作为概览指标按分四舍五入，计算使用整数以保留大额账本的准确性。 */
export function dailyAverage(total: string, days: number): string {
  try {
    if (!Number.isInteger(days) || days <= 0) return '—';
    const divisor = BigInt(days) * (scale / 100n);
    const cents = (amountUnits(total) + divisor / 2n) / divisor;
    return displayAmount(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
  } catch (error) {
    console.error('计算概览日均支出失败', { total, days, error });
    return '暂时无法计算';
  }
}

/** 环比为有符号百分比；零基数单独表达，避免无穷大与误导性的零增长。 */
export function periodChange(current: string, previous: string): string {
  const before = amountUnits(previous);
  const after = amountUnits(current);
  if (before === 0n) return after === 0n ? '与上期持平' : '上期无支出';
  const difference = after - before;
  const sign = difference < 0n ? '−' : '+';
  const magnitude = difference < 0n ? -difference : difference;
  const percent = (magnitude * 10_000n + before / 2n) / before;
  if (percent === 0n) return '与上期持平';
  return `${sign}${percent / 100n}.${String(percent % 100n).padStart(2, '0')}%`;
}

/** 以本地自然日计数，跨夏令时仍是一日，不用毫秒数直接除以一天。 */
export function rangeDays(start: string | undefined, end: string | undefined): number | null {
  if (!start || !end) return null;
  const first = new Date(start);
  const last = new Date(end);
  return Math.round(
    (Date.UTC(last.getFullYear(), last.getMonth(), last.getDate()) -
      Date.UTC(first.getFullYear(), first.getMonth(), first.getDate())) /
      86_400_000,
  );
}

/** 指定日期所在周始于周一，终点为下周一本地午夜。 */
export function weekRange(date: string) {
  const selected = new Date(customDateRange(date, date).start_at);
  selected.setDate(selected.getDate() - ((selected.getDay() + 6) % 7));
  const end = new Date(selected);
  end.setDate(end.getDate() + 7);
  return { start_at: selected.toISOString(), end_at: end.toISOString() };
}

/** 本地日期文本用于日期选择器，避免 UTC 日期在夜间偏移一天。 */
export function localDate(value = new Date()): string {
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/** 环比沿用同账期起始日，周对上一周、月对上一账期、年对上一年度账期。 */
export function previousRange(scope: string, period: string, week: string, startDay: number) {
  if (scope === 'week') {
    const range = weekRange(week);
    const start = new Date(range.start_at);
    start.setDate(start.getDate() - 7);
    return { start_at: start.toISOString(), end_at: range.start_at };
  }
  if (scope === 'month') {
    const date = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 2, 1);
    return billingRange(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`, startDay);
  }
  if (scope === 'year') {
    const year = Number(period.slice(0, 4)) - 1;
    return {
      start_at: billingRange(`${year}-01`, startDay).start_at,
      end_at: billingRange(`${year}-12`, startDay).end_at,
    };
  }
  return null;
}
