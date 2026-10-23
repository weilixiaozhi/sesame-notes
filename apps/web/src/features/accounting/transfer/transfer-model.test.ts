import { describe, it, expect, beforeEach, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { buildImportPlan, detectTransferMapping, accountingCsv, type Ledger, type Snapshot } from './transfer-model';
import { importTimestamp } from '../../../lib/transfer/timestamp';
import { convertAmount } from '../currency-math';
import { parseDelimited } from '../../../lib/delimited-text';
import { parseJsonTables, readTransferFile, selectTable } from '../../../lib/transfer/table';

const stamp = '2026-01-01T00:00:00.000Z';
const ledger: Ledger = {
  id: 'd4d1c885-9a7a-4c87-968e-70b7dbe565f5',
  sync_id: '49712a79-35bd-4462-9e48-ead467c32b2a',
  name: '假账本',
  currency: 'CNY',
  month_start_day: 1,
  aa_enabled: false,
  archived_at: null,
  archive_updated_at: null,
  archive_device_id: null,
  role: 'owner',
  member_count: 1,
  updated_at: stamp,
};
const snapshot: Snapshot = {
  ledger,
  members: [],
  transactions: [],
  categories: [],
  category_tombstones: [],
  recurring_transactions: [],
  exchange_rate_overrides: [],
  server_cursor: '1',
};
const signal = () => new AbortController().signal;
beforeEach(() => vi.stubGlobal('crypto', webcrypto));

describe('记账文件解析与精确转换', () => {
  it('CSV/TSV保留引号换行，无表头提供虚拟列，拒绝损坏输入', () => {
    expect(parseDelimited('a,b\r\n"中,文","第\n二行"', ',')).toEqual([
      ['a', 'b'],
      ['中,文', '第\n二行'],
    ]);
    expect(selectTable({ name: 'txt', records: parseDelimited('1\t2\n3\t4', '\t') }, false)).toEqual({
      headers: ['第 1 列', '第 2 列'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
    });
    expect(() => parseDelimited('"a,b', ',')).toThrow('未闭合');
    expect(() => selectTable({ name: 'bad', records: [['a', 'b'], ['one']] }, true)).toThrow('列数');
  });
  it('JSON可选择嵌套数组，拒绝重复键并保留超大数字原文', () => {
    const tables = parseJsonTables(
      '{"data":{"transactions":[{"amount":"1234567890123456789012345678.1234567891","note":"中文"}]}}',
    );
    expect(tables[0]?.name).toBe('$.data.transactions');
    expect(tables[0]?.records[1]?.[0]).toBe('1234567890123456789012345678.1234567891');
    expect(() => parseJsonTables('[{"amount":1,"amount":2}]')).toThrow();
    expect(parseJsonTables('[{"amount":9007199254740992.1234567891}]')[0]?.records[1]?.[0]).toBe(
      '9007199254740992.1234567891',
    );
  });
  it('严格时间与银行家舍入，不经浮点修改金额', () => {
    expect(() => importTimestamp('2026-02-30')).toThrow();
    expect(() => importTimestamp('2026-02-30T12:00:00Z')).toThrow();
    expect(importTimestamp('2026-09-30T12:00:00+08:00')).toBe('2026-09-30T04:00:00.000Z');
    expect(convertAmount('9999999999999999.1234567891', '1', 10)).toBe('9999999999999999.1234567891');
    expect(convertAmount('0.0000000001', '1.5', 10)).toBe('0.0000000002');
    expect(convertAmount('0.0000000001', '2.5', 10)).toBe('0.0000000002');
  });
  it('实际读取XLSX中文、多工作表与文字金额，并拒绝公式', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('中文明细');
    sheet.addRow(['时间', '金额']);
    sheet.addRow(['2026-09-30', '123456789012345678.1234567891']);
    workbook.addWorksheet('其他').addRow(['x']);
    let bytes = await workbook.xlsx.writeBuffer();
    const file = { name: 'fake.xlsx', size: bytes.byteLength, arrayBuffer: async () => bytes } as File;
    const tables = await readTransferFile(file);
    expect(tables.map((table) => table.name)).toEqual(['中文明细', '其他']);
    expect(tables[0]?.records[1]?.[1]).toBe('123456789012345678.1234567891');
    sheet.getCell('B2').value = { formula: '1+1', result: 2 };
    bytes = await workbook.xlsx.writeBuffer();
    await expect(readTransferFile(file)).rejects.toThrow('公式');
  }, 20_000);
});

describe('记账导入计划与完整导出', () => {
  it('未映射的附加列不影响支出导入', async () => {
    const table = {
      headers: ['时间', '金额', '附加说明'],
      rows: [
        ['2026-09-30', '12.30', 'true'],
        ['2026-09-30', '20', '不适用'],
      ],
    };
    const mapping = detectTransferMapping(table.headers);
    const plan = await buildImportPlan(table, mapping, ledger, snapshot, signal());
    expect(plan.errors).toEqual([]);
    expect(plan.count).toBe(2);
    expect(plan.batches.flatMap((batch) => batch.body.transactions ?? [])).toEqual([
      expect.objectContaining({ amount: '12.3' }),
      expect.objectContaining({ amount: '20' }),
    ]);
  });

  it('映射汇率按十位精确折算，金额输入越界和无效汇率保留行级错误', async () => {
    const table = {
      headers: ['时间', '金额', '币种', '汇率'],
      rows: [
        ['2026-09-30', '0.0000000001', 'USD', '1.5'],
        ['2026-09-30', '0.0000000001', 'USD', '2.5'],
        ['2026-09-30', '9999999999999999999999999999', 'USD', '2'],
        ['2026-09-30', '10000000000000000000000000000', 'USD', '0.1'],
        ['2026-09-30', '1.12345678901', 'USD', '1'],
        ['2026-09-30', '1', 'USD', '0'],
      ],
    };
    const plan = await buildImportPlan(table, detectTransferMapping(table.headers), ledger, snapshot, signal());
    expect(plan.batches.flatMap((batch) => batch.body.transactions ?? []).map((item) => item.native_amount)).toEqual([
      '0.0000000002',
      '0.0000000002',
    ]);
    expect(plan.errors.map((error) => error.row)).toEqual([4, 5, 6, 7]);
  });

  it('金额、外币快照、分类顺序稳定，重复文件通过记录身份跳过', async () => {
    const table = {
      headers: ['时间', '金额', '币种', '分类', '二级分类', 'native_amount'],
      rows: [['2026-09-30', '999999999999.1234567891', 'USD', '餐饮', '咖啡', '7000000000000.1234567891']],
    };
    const mapping = detectTransferMapping(table.headers);
    const first = await buildImportPlan(table, mapping, ledger, snapshot, signal());
    expect(first.errors).toEqual([]);
    expect(first.batches).toHaveLength(1);
    const body = first.batches[0]!.body;
    expect(body.categories?.[1]?.parent_id).toBe(body.categories?.[0]?.id);
    expect(body.transactions?.[0]?.native_amount).toBe('7000000000000.1234567891');
    const duplicate = await buildImportPlan(
      table,
      mapping,
      ledger,
      { ...snapshot, transactions: [{ id: body.transactions![0]!.id! }] as Snapshot['transactions'] },
      signal(),
    );
    expect(duplicate.skipped).toBe(1);
    expect(duplicate.count).toBe(0);
    expect(duplicate.batches).toEqual([]);
    const repeat = await buildImportPlan(table, mapping, ledger, snapshot, signal());
    expect(repeat.batches).toEqual(first.batches);
  });
  it('外币缺折算、收入、不存在日期、未知编辑者分类全部逐行报告', async () => {
    const table = {
      headers: ['时间', '金额', '币种', '类型', '分类'],
      rows: [
        ['2026-09-30', '1', 'USD', 'expense', ''],
        ['2026-09-30', '1', 'CNY', 'income', ''],
        ['2026-02-30', '1', 'CNY', 'expense', ''],
        ['2026-09-30', '1', 'CNY', 'expense', '不存在'],
      ],
    };
    const plan = await buildImportPlan(
      table,
      detectTransferMapping(table.headers),
      { ...ledger, role: 'editor' },
      snapshot,
      signal(),
    );
    expect(plan.errors.map((error) => error.row)).toEqual([2, 3, 4, 5]);
    expect(plan.count).toBe(0);
  });
  it('超过500条分批仍固定身份；取消不产生计划', async () => {
    const table = { headers: ['时间', '金额'], rows: Array.from({ length: 501 }, () => ['2026-09-30', '1']) };
    const plan = await buildImportPlan(table, detectTransferMapping(table.headers), ledger, snapshot, signal());
    expect(plan.batches.map((batch) => batch.body.transactions?.length)).toEqual([500, 1]);
    const ids = plan.batches.flatMap((batch) => batch.body.transactions!.map((tx) => tx.id));
    expect(new Set(ids).size).toBe(501);
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildImportPlan(table, detectTransferMapping(table.headers), ledger, snapshot, controller.signal),
    ).rejects.toThrow();
  });
  it('导出取完整快照按本地自然日闭区间筛选，并保留十位小数与带逗号备注', () => {
    const records = [
      {
        id: 'a',
        category_id: null,
        category_name: null,
        amount: '123456789012345678.1234567891',
        currency_code: 'CNY',
        note: '含,逗号\n换行',
        happened_at: new Date(2026, 8, 30, 23, 59, 59).toISOString(),
        native_amount: '123456789012345678.1234567891',
      },
      { id: 'b', amount: '2', happened_at: new Date(2026, 9, 1, 0, 0, 0).toISOString() },
    ] as Snapshot['transactions'];
    const output = accountingCsv({ ...snapshot, transactions: records }, '2026-09-30', '2026-09-30');
    expect(output.count).toBe(1);
    expect(output.text).toContain('123456789012345678.1234567891');
    expect(output.text).toContain('"含,逗号\n换行"');
    expect(output.text).toContain('native_amount');
    const rows = parseDelimited(output.text.replace(/^\uFEFF/, ''), ',');
    expect(rows[0]).toEqual(['类型', '分类', '二级分类', '金额', '币种', '备注', '时间', 'native_amount']);
    expect(rows[1]).toHaveLength(8);
  });
});
