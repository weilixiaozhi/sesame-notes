/** 时间严格核验日历值，带时区保留瞬间，无时区使用当前浏览器本地时间。 */
export function importTimestamp(input: string): string {
  const value = input.trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new Error('日期无效');
    const calendar = value.slice(0, 10).split('-').map(Number);
    const check = new Date(Date.UTC(calendar[0]!, calendar[1]! - 1, calendar[2]!));
    if (check.getUTCMonth() !== calendar[1]! - 1 || check.getUTCDate() !== calendar[2]) throw new Error('日期不存在');
    return parsed.toISOString();
  }
  const match =
    /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(value);
  if (!match) throw new Error('日期需为年月日，可带时分秒或 ISO 时区');
  const [year, month, day, hour, minute, second, millis] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
    Number((match[7] ?? '').padEnd(3, '0')),
  ];
  const date = new Date(year!, month! - 1, day!, hour!, minute!, second!, millis!);
  if (
    year! < 1901 ||
    year! > 2100 ||
    date.getFullYear() !== year ||
    date.getMonth() !== month! - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  )
    throw new Error('日期不存在或超出 1901–2100 年');
  return date.toISOString();
}
