import { describe, expect, it } from 'vitest';
import { detectDayMapping, mapDayRows } from './day-import-format';
import { parseCsvTable } from '../../lib/delimited-text';

const now = '2026-01-01T00:00:00.000Z';

describe('CSV映射与日期导入', () => {
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
});
