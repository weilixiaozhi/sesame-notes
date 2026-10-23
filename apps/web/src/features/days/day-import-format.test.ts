import { describe, expect, it } from 'vitest';
import { detectDayMapping, mapDayRows } from './day-import-format';
import { parseCsvTable } from '../../lib/delimited-text';

const now = '2026-01-01T00:00:00.000Z';

describe('CSV映射与日期导入', () => {
  it('正确解析BOM、引号、逗号、换行和双引号', () => {
    const result = parseCsvTable('\uFEFFname,category,date\r\n"带逗号,和""引号""\n第二行",anniversary,2026-01-01');
    expect(result.rows[0]?.[0]).toBe('带逗号,和"引号"\n第二行');
  });
  it('拒绝未闭合引号、重复表头或列数不一致', () => {
    for (const text of ['name,name\na,b', 'name,date\na', 'name,date\n"a,b'])
      expect(() => parseCsvTable(text)).toThrow();
  });
  it('映射中文表头并保留真实农历投影', () => {
    const table = parseCsvTable('名称,类型,日期,历法,统计方式\n新春,纪念日,2026-01-01,农历,天');
    const rows = mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now);
    expect(rows[0]?.payload.event).toMatchObject({
      calendar_type: 'lunar',
      original_month: 1,
      original_day: 1,
      solar_date: '2026-02-17',
    });
  });
  it('缺少可选列时只使用用户明确选择的默认类型和单位', () => {
    const table = parseCsvTable('name,date\n目标,2026-09-01');
    expect(mapDayRows(table, detectDayMapping(table.headers), 'countdown', 'year', now)[0]?.payload).toMatchObject({
      category: 'countdown',
      statistic_type: 'year',
      countdown_mode: 'fixed_date',
    });
  });
  it('错误定位到行，不静默丢弃多余日期或非法重复规则', () => {
    const invalid = [
      'name,category,date,start_date\na,anniversary,2026-01-01,2025-01-01',
      'name,category,date,repeat_type\na,birthday,2020-01-01,none',
      'name,category,start_date,end_date\na,stage,2026-02-01,2026-01-01',
    ];
    for (const text of invalid) {
      const table = parseCsvTable(text);
      expect(() => mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now)).toThrow('第 2 行');
    }
  });
  it.each(['constructor', '__proto__'])('拒绝原型同名的未知日子类型 %s', (category) => {
    const table = parseCsvTable(`name,category,date\n测试,${category},2026-01-01`);
    expect(() => mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now)).toThrow(
      '类型应为生日、纪念日、倒数日或阶段',
    );
  });
});
