/** 日期以日历数字构造，避免 UTC 字符串被浏览器转换到前一天。 */
export function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/** 只接受支持区间内真实存在的日期，不让地址栏溢出日期自动滚入下月。 */
export function validCalendarDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1901-01-01' || value > '2100-12-31') return false;
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isFinite(parsed.getTime()) && localDateKey(parsed) === value;
}

/** 周一开始的六行网格用 UTC 运算，跨夏令时仍保持一天一个格子。 */
export function calendarDates(month: string): string[] {
  if (!validCalendarDate(`${month}-01`)) throw new Error('月份超出支持范围');
  const first = new Date(`${month}-01T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) =>
    new Date(first.getTime() + (index - offset) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** API 边界采用当地零点，夏令时日可以是 23 或 25 小时。 */
export function calendarRange(first: string, last: string) {
  const start = new Date(`${first}T00:00:00`);
  const end = new Date(`${last}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return { start_at: start.toISOString(), end_at: end.toISOString() };
}

/** 翻月只改变年月，不受当前日期为 29、30、31 日影响。 */
export function shiftCalendarMonth(month: string, offset: number): string | null {
  const [year = 0, number = 0] = month.split('-').map(Number);
  const result = new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
  return result >= '1901-01' && result <= '2100-12' ? result : null;
}
