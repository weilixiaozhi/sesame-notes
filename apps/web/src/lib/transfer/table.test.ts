import { describe, expect, it } from 'vitest';
import { parseJsonTables } from './table';

describe('JSON 表格字段归属', () => {
  it('原型同名列保留显式值，缺失单元格使用空值', () => {
    const tables = parseJsonTables(
      '[{"name":"首行","__proto__":"字段值","constructor":"构造字段","toString":"文本字段"},{"name":"次行"}]',
    );
    expect(tables[0]?.records).toEqual([
      ['name', '__proto__', 'constructor', 'toString'],
      ['首行', '字段值', '构造字段', '文本字段'],
      ['次行', '', '', ''],
    ]);
  });

  it('同一路径下的多个嵌套数组按文件顺序收集，每条记录只追加一次', () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({ records: [{ name: `记录 ${index}`, amount: index }] }));
    const tables = parseJsonTables(JSON.stringify(rows));
    const nested = tables.find((table) => table.name === '$[].records');
    expect(nested?.records).toEqual([
      ['name', 'amount'],
      ...rows.map((row) => [row.records[0]!.name, String(row.records[0]!.amount)]),
    ]);
  });

  it('含路径标点的字段与真正嵌套数组保持为独立数据表', () => {
    try {
      const tables = parseJsonTables(
        JSON.stringify({
          'a.b': [{ amount: '1' }],
          a: { b: [{ amount: '2' }] },
          'items[]': [{ amount: '3' }],
          items: [[{ amount: '4' }]],
        }),
      );
      expect(tables).toEqual([
        { name: '$["a.b"]', records: [['amount'], ['1']] },
        { name: '$.a.b', records: [['amount'], ['2']] },
        { name: '$["items[]"]', records: [['amount'], ['3']] },
        { name: '$.items[]', records: [['amount'], ['4']] },
      ]);
    } catch (cause) {
      throw new Error('JSON 独立数据表路径归属验证失败', { cause });
    }
  });

  it('稀疏字段并集与记录数量使用工作表容量边界，展开前拒绝超限文件', () => {
    try {
      const rows = Array.from({ length: 201 }, (_, index) => ({ [`column_${index}`]: '数据' }));
      expect(() => parseJsonTables(JSON.stringify(rows))).toThrow('JSON 数据表超过 200 列或 100000 行');
      const allowed = parseJsonTables(JSON.stringify(rows.slice(0, 200)));
      expect(allowed[0]?.records).toHaveLength(201);
      expect(allowed[0]?.records.every((row) => row.length === 200)).toBe(true);
      const tooManyRows = Array.from({ length: 100001 }).fill('{"name":"记录"}');
      expect(() => parseJsonTables(`[${tooManyRows.join(',')}]`)).toThrow('JSON 数据表超过 200 列或 100000 行');
    } catch (cause) {
      throw new Error('JSON 表格容量保护验证失败', { cause });
    }
  });
});
