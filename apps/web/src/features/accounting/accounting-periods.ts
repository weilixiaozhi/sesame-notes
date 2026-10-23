/** 账期以浏览器本地午夜为边界，不足起始日的月份使用该月最后一天。 */
export function billingRange(period: string, monthStartDay: number): { start_at: string; end_at: string } {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) throw new Error('请选择有效月份。');
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7)) - 1;
  if (year < 100 || year > 9998) throw new Error('请选择 0100 至 9998 年之间的月份。');
  const at = (offset: number) => {
    const last = new Date(year, month + offset + 1, 0).getDate();
    return new Date(year, month + offset, Math.min(monthStartDay, last)).toISOString();
  };
  return { start_at: at(0), end_at: at(1) };
}

/** 当前账期可能从上月开始，不能直接把自然月当作账期标签。 */
export function currentBillingMonth(startDay: number, now = new Date()): string {
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const month = new Date(now.getFullYear(), now.getMonth() - (now.getDate() < Math.min(startDay, last) ? 1 : 0), 1);
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
}

/** 自定义日期区间包含结束日，传给接口的结束时刻是次日本地午夜。 */
export function customDateRange(start: string, end: string): { start_at: string; end_at: string } {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择开始和结束日期。');
    const date = new Date(`${value}T00:00:00`);
    if (
      !Number.isFinite(date.getTime()) ||
      date.getFullYear() < 100 ||
      date.getFullYear() > 9998 ||
      date.getDate() !== Number(value.slice(8))
    )
      throw new Error('日期无效。');
    return date;
  };
  const from = parse(start);
  const to = parse(end);
  if (from > to) throw new Error('开始日期不能晚于结束日期。');
  to.setDate(to.getDate() + 1);
  return { start_at: from.toISOString(), end_at: to.toISOString() };
}
