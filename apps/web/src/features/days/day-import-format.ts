import { buildDefinition, projectDate, solarDate, type DayDate, type DayDefinition } from './day-dates';
import { hasVisibleText } from '../memos/memo-content';

export const dayImportFields = [
  ['name', '名称'],
  ['category', '类型'],
  ['date', '日期'],
  ['calendar', '历法'],
  ['is_leap_month', '闰月'],
  ['repeat_type', '重复规则'],
  ['statistic_type', '统计方式'],
  ['start_date', '开始日期'],
  ['start_calendar', '开始历法'],
  ['start_is_leap_month', '开始闰月'],
  ['end_date', '结束日期'],
  ['end_calendar', '结束历法'],
  ['end_is_leap_month', '结束闰月'],
  ['countdown_mode', '倒数方式'],
  ['interval_days', '间隔天数'],
  ['created_at', '创建时间'],
  ['updated_at', '修改时间'],
] as const;
type DayFieldKey = (typeof dayImportFields)[number][0];
export type DayFieldMapping = Record<DayFieldKey, string>;
export type ImportedDay = { payload: DayDefinition; updatedAt: string };

/** 自动识别标准字段名和中文列名，用户可以在预览前明确调整映射。 */
export function detectDayMapping(headers: string[]): DayFieldMapping {
  return Object.fromEntries(
    dayImportFields.map(([key, label]) => [
      key,
      headers.find((header) => header.toLowerCase() === key || header === label) ?? '',
    ]),
  ) as DayFieldMapping;
}

/** 严格验证映射后的每行，返回值的 HTTP 内容类型仍从生成契约派生。 */
export function mapDayRows(
  table: { headers: string[]; rows: string[][] },
  mapping: DayFieldMapping,
  defaultCategory: DayDefinition['category'],
  defaultStatistic: DayDefinition['statistic_type'],
  now: string,
): ImportedDay[] {
  if (!mapping.name) throw new Error('请先映射名称列');
  return table.rows.map((record, index) => {
    try {
      const get = (key: DayFieldKey) => {
        const column = table.headers.indexOf(mapping[key]);
        return column < 0 ? '' : record[column]!.trim();
      };
      const name = get('name');
      if (!hasVisibleText(name) || Array.from(name).length > 100) throw new Error('名称需为 1 至 100 个可见字符');
      const categories: Record<string, DayDefinition['category']> = {
        birthday: 'birthday',
        生日: 'birthday',
        anniversary: 'anniversary',
        纪念日: 'anniversary',
        countdown: 'countdown',
        倒数日: 'countdown',
        stage: 'stage',
        阶段: 'stage',
      };
      const categoryName = get('category').toLowerCase();
      // 仅接受显式列出的类型别名，原型属性不是合法的日子类型。
      const category = categoryName
        ? Object.hasOwn(categories, categoryName)
          ? categories[categoryName]
          : undefined
        : defaultCategory;
      if (!category) throw new Error('类型应为生日、纪念日、倒数日或阶段');
      const date = (field: DayFieldKey, calendarField: DayFieldKey, leapField: DayFieldKey): DayDate | null => {
        const raw = get(field);
        if (!raw) return null;
        const match = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/.exec(raw.replace(/T00:00:00(?:\.000)?Z$/, ''));
        if (!match) throw new Error('日期需为 YYYY-MM-DD');
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const calendar = get(calendarField).toLowerCase();
        const lunar = ['lunar', '农历', '阴历'].includes(calendar);
        if (!lunar && !['', 'solar', '公历', '阳历'].includes(calendar)) throw new Error('历法需为公历或农历');
        const leap = get(leapField).toLowerCase();
        if (!['', 'true', 'false', '1', '0', '是', '否'].includes(leap))
          throw new Error('闰月需为 true/false 或 是/否');
        const isLeap = ['true', '1', '是'].includes(leap);
        const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (!lunar) {
          if (isLeap) throw new Error('公历不能设置闰月');
          return solarDate(iso);
        }
        return projectDate({
          calendar_type: 'lunar',
          original_year: year,
          original_month: month,
          original_day: day,
          is_leap_month: isLeap,
          solar_date: '',
        });
      };
      const event = date('date', 'calendar', 'is_leap_month');
      const start = date('start_date', 'start_calendar', 'start_is_leap_month');
      const end = date('end_date', 'end_calendar', 'end_is_leap_month');
      const repeated = category === 'birthday' || category === 'anniversary';
      const repeat = get('repeat_type').toLowerCase();
      if (repeat && !(repeated ? ['yearly', '每年'] : ['none', '不重复']).includes(repeat))
        throw new Error('重复规则与日子类型不一致');
      const statistic = get('statistic_type').toLowerCase();
      if (statistic && !['year', 'day', '年', '天'].includes(statistic))
        throw new Error('统计方式需为 year/day 或 年/天');
      const statisticType = statistic ? (['year', '年'].includes(statistic) ? 'year' : 'day') : defaultStatistic;
      const intervalRaw = get('interval_days');
      const interval = intervalRaw ? Number(intervalRaw) : null;
      const modeRaw = get('countdown_mode').toLowerCase();
      const mode =
        category !== 'countdown'
          ? null
          : ['', 'fixed_date', '固定日期'].includes(modeRaw) && !intervalRaw
            ? 'fixed_date'
            : ['', 'interval_days', '间隔天数'].includes(modeRaw)
              ? 'interval_days'
              : undefined;
      if (mode === undefined || (category !== 'countdown' && (modeRaw || intervalRaw)))
        throw new Error('倒数方式与日子类型不一致');
      if ((repeated || mode === 'fixed_date') && (!event || start || end || interval !== null))
        throw new Error('此类型需要单个日期，不能混用起止日期');
      if ((category === 'stage' || mode === 'interval_days') && (!start || event || (mode === 'interval_days' && end)))
        throw new Error('此类型需开始日期，请检查事件或结束日期是否多余');
      const timestamp = (value: string, fallback: string) => {
        if (!value) return fallback;
        const parsed = new Date(value);
        if (!Number.isFinite(parsed.getTime())) throw new Error('时间格式无效');
        return parsed.toISOString();
      };
      const created = timestamp(get('created_at'), now);
      const updated = timestamp(get('updated_at'), created);
      if (updated < created) throw new Error('修改时间不能早于创建时间');
      return {
        payload: buildDefinition({
          name,
          category,
          event,
          start,
          end,
          countdown_mode: mode,
          interval_days: interval,
          repeat_type: repeated ? 'yearly' : 'none',
          statistic_type: statisticType,
          created_at: created,
        }),
        updatedAt: updated,
      };
    } catch (error) {
      throw new Error(`第 ${index + 2} 行：${error instanceof Error ? error.message : '数据格式无效'}`);
    }
  });
}
