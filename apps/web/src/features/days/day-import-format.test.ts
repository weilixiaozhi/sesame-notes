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

  it.each([
    { field: 'created_at', value: '2026-02-30' },
    { field: 'created_at', value: '2026-02-30T12:00:00.000Z' },
    { field: 'updated_at', value: '2026-02-30' },
    { field: 'updated_at', value: '2026-02-30T12:00:00+08:00' },
  ])('拒绝 $field 中不存在的日期 $value，不生成被改写的导入记录', ({ field, value }) => {
    try {
      const table = parseCsvTable(`name,date,${field}\n日子,2026-01-01,${value}`);
      expect(() => mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now)).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining('第 2 行'),
          cause: expect.objectContaining({ message: expect.stringContaining('日期不存在') }),
        }),
      );
    } catch (cause) {
      throw new Error('日子导入把非法来源时间改写成了可保存日期', { cause });
    }
  });

  it('保留纯日期UTC午夜、本地墙钟时间和显式时区的既有时间含义', () => {
    try {
      const table = parseCsvTable(
        'name,date,created_at,updated_at\n' +
          '纯日期,2026-01-01,2024-02-29,2026-02-28\n' +
          '本地时间,2026-01-01,2026-02-28 09:30:00,2026-02-28 10:30:00\n' +
          '指定时区,2026-01-01,2026-02-28T09:30:00+08:00,2026-02-28T10:30:00+08:00',
      );
      const rows = mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now);
      expect(rows.map((row) => [row.payload.created_at, row.updatedAt])).toEqual([
        ['2024-02-29T00:00:00.000Z', '2026-02-28T00:00:00.000Z'],
        [new Date(2026, 1, 28, 9, 30).toISOString(), new Date(2026, 1, 28, 10, 30).toISOString()],
        ['2026-02-28T01:30:00.000Z', '2026-02-28T02:30:00.000Z'],
      ]);
    } catch (cause) {
      throw new Error('日子导入改变了合法时间的业务含义', { cause });
    }
  });

  it('仅缺失时间列与空单元格使用当前时间或创建时间', () => {
    try {
      for (const text of ['name,date\n日子,2026-01-01', 'name,date,created_at,updated_at\n日子,2026-01-01,,']) {
        const table = parseCsvTable(text);
        const rows = mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now);
        expect(rows[0]).toMatchObject({ payload: { created_at: now }, updatedAt: now });
      }
      const table = parseCsvTable('name,date,created_at,updated_at\n日子,2026-01-01,2026-02-28,');
      expect(mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now)[0]).toMatchObject({
        payload: { created_at: '2026-02-28T00:00:00.000Z' },
        updatedAt: '2026-02-28T00:00:00.000Z',
      });
    } catch (cause) {
      throw new Error('日子导入的合法缺省时间不符合约定', { cause });
    }
  });

  it.each(['0000-01-01', '0000-01-01T12:00:00.000Z', '0001-01-01T00:00:00+08:00', '9999-12-31T23:59:59-01:00'])(
    '年份越界的创建时间 %s 不能形成导入预览',
    (value) => {
      try {
        const table = parseCsvTable(`name,date,created_at\n合法记录,2026-01-01,${now}\n非法记录,2026-01-01,${value}`);
        expect(() => mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now)).toThrowError(
          expect.objectContaining({
            message: expect.stringContaining('第 3 行'),
            cause: expect.objectContaining({ message: '日期无效' }),
          }),
        );
      } catch (cause) {
        throw new Error('年份越界的日子记录未在完整预览前被拒绝', { cause });
      }
    },
  );
});
