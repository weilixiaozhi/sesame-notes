import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { buildImportPlan, detectTransferMapping, accountingCsv, type Ledger, type Snapshot } from './transfer-model';
import { importTimestamp } from '../../../lib/transfer/timestamp';
import { parseDelimited } from '../../../lib/delimited-text';
import { parseJsonTables, readTransferFile, selectTable } from '../../../lib/transfer/table';
import { categoryImportSources, type CategoryImportChoices } from './category-transfer';
import { createImportId } from '../../../lib/transfer/import-identity';

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
  owner_id: '57827401-482a-4a82-9b92-f1cfb24bf5ee',
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

/** 模拟用户对每个来源明确选择新建，测试不能依赖名称自动认领。 */
async function chooseNew(table: Parameters<typeof categoryImportSources>[0]): Promise<CategoryImportChoices> {
  try {
    const sources = await categoryImportSources(table, detectTransferMapping(table.headers));
    return Object.fromEntries([...sources.sources.keys()].map((key) => [key, { kind: 'new' }]));
  } catch (cause) {
    throw new Error('导入分类选择测试初始化失败', { cause });
  }
}

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
  it('拒绝非法日期，带时区的导入时间保持同一时刻', () => {
    expect(() => importTimestamp('2026-02-30')).toThrow();
    expect(() => importTimestamp('2026-02-30T12:00:00Z')).toThrow();
    expect(importTimestamp('2026-09-30T12:00:00+08:00')).toBe('2026-09-30T04:00:00.000Z');
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
  it.each([false, true])('旧文件及空机器列文件重导保持已发布交易ID，含机器表头=%s', async (withEmptyHeaders) => {
    try {
      const table = {
        headers: ['时间', '金额', ...(withEmptyHeaders ? ['category_scope', 'category_id', 'parent_category_id'] : [])],
        rows: [['2026-09-30', '1', ...(withEmptyHeaders ? ['', '', ''] : [])]],
      };
      const oldMapping = {
        date: '时间',
        amount: '金额',
        type: '',
        currency: '',
        category: '',
        sub_category: '',
        category_icon: '',
        sub_category_icon: '',
        note: '',
        native_amount: '',
        rate: '',
      };
      const oldFingerprint = createHash('sha256')
        .update(JSON.stringify({ table, mapping: oldMapping, ledger: ledger.id }))
        .digest('hex');
      const oldId = await createImportId(ledger.id, oldFingerprint, '0');
      const plan = await buildImportPlan(table, detectTransferMapping(table.headers), ledger, snapshot, signal());
      expect(plan.batches[0]!.body.transactions![0]!.id).toBe(oldId);
      const repeated = await buildImportPlan(
        table,
        detectTransferMapping(table.headers),
        ledger,
        { ...snapshot, transactions: [{ id: oldId }] as Snapshot['transactions'] },
        signal(),
      );
      expect(repeated.skipped).toBe(1);
      expect(repeated.batches).toEqual([]);
    } catch (cause) {
      throw new Error('历史交易导入身份兼容验证失败', { cause });
    }
  });
  it('无ID的同名来源逐行确认，明确选择不同目标ID不会按名称合并', async () => {
    try {
      const table = {
        headers: ['时间', '金额', '分类'],
        rows: [
          ['2026-09-30', '1', '旅行'],
          ['2026-09-30', '2', '旅行'],
        ],
      };
      const mapping = detectTransferMapping(table.headers);
      const categories = ['c63266e7-7640-464c-ad22-bd9b5e1a4d1e', '8260fcb3-c519-49bc-909c-f44fb90d0850'].map(
        (id, index) => ({
          id,
          name: '旅行',
          level: 1,
          parent_id: null,
          icon: index ? 'car' : 'plane',
          owner_id: ledger.owner_id,
        }),
      ) as Snapshot['categories'];
      const state = { ...snapshot, categories };
      const unresolved = await buildImportPlan(table, mapping, ledger, state, signal());
      expect(unresolved.categoryRequests).toHaveLength(2);
      expect(unresolved.batches).toEqual([]);
      const choices: CategoryImportChoices = Object.fromEntries(
        unresolved.categoryRequests.map((source, index) => [
          source.key,
          { kind: 'existing', id: categories[index]!.id },
        ]),
      );
      const resolved = await buildImportPlan(table, mapping, ledger, state, signal(), choices);
      expect(resolved.categoryRequests).toEqual([]);
      expect(resolved.categories).toBe(0);
      expect(
        resolved.batches.flatMap((batch) => batch.body.transactions ?? []).map((item) => item.category_id),
      ).toEqual(categories.map((item) => item.id));
    } catch (cause) {
      throw new Error('同名来源人工映射验证失败', { cause });
    }
  });

  it('机器字段按owner与ID对应同名分类，名称和图标修改不影响身份', async () => {
    try {
      const ids = ['c63266e7-7640-464c-ad22-bd9b5e1a4d1e', '8260fcb3-c519-49bc-909c-f44fb90d0850'];
      const table = {
        headers: ['时间', '金额', '分类', 'category_scope', 'category_id'],
        rows: ids.map((id, index) => ['2026-09-30', '1', index ? '' : '旅行', `account:${ledger.owner_id}`, id]),
      };
      const categories = ids.map((id) => ({
        id,
        name: '用户已改名',
        level: 1,
        parent_id: null,
        icon: 'car',
        owner_id: ledger.owner_id,
      })) as Snapshot['categories'];
      const plan = await buildImportPlan(
        table,
        detectTransferMapping(table.headers),
        ledger,
        { ...snapshot, categories },
        signal(),
      );
      expect(plan.categoryRequests).toEqual([]);
      expect(plan.categories).toBe(0);
      expect(plan.batches.flatMap((batch) => batch.body.transactions ?? []).map((item) => item.category_id)).toEqual(
        ids,
      );
    } catch (cause) {
      throw new Error('分类机器身份映射验证失败', { cause });
    }
  });

  it('跨owner相同裸ID不能自动认领，明确新建父子映射可重试且不复制其他分类', async () => {
    try {
      const sourceId = 'c63266e7-7640-464c-ad22-bd9b5e1a4d1e';
      const parentId = '8260fcb3-c519-49bc-909c-f44fb90d0850';
      const table = {
        headers: ['时间', '金额', '分类', '二级分类', 'category_scope', 'category_id', 'parent_category_id'],
        rows: [['2026-09-30', '1', '餐饮', '午餐', 'account:other-owner', sourceId, parentId]],
      };
      const mapping = detectTransferMapping(table.headers);
      const privateCategory = {
        id: sourceId,
        name: '本人分类',
        level: 1,
        parent_id: null,
        icon: 'car',
        owner_id: ledger.owner_id,
      } as Snapshot['categories'][number];
      const state = { ...snapshot, categories: [privateCategory] };
      const unresolved = await buildImportPlan(table, mapping, ledger, state, signal());
      expect(unresolved.categoryRequests).toHaveLength(2);
      const choices = await chooseNew(table);
      const first = await buildImportPlan(table, mapping, ledger, state, signal(), choices);
      expect(first.errors).toEqual([]);
      const created = first.batches[0]!.body.categories!;
      expect(created).toHaveLength(2);
      expect(created[0]!.id).not.toBe(parentId);
      expect(created[1]!.id).not.toBe(sourceId);
      expect(created[1]!.parent_id).toBe(created[0]!.id);
      expect((await buildImportPlan(table, mapping, ledger, state, signal(), choices)).batches).toEqual(first.batches);
      // 分类批次已提交、交易批次尚未提交时，重试复用来源确定的目标ID。
      const partial = {
        ...state,
        categories: [
          ...state.categories,
          ...created.map((row) => ({ ...row, owner_id: ledger.owner_id })),
        ] as Snapshot['categories'],
      };
      const retry = await buildImportPlan(table, mapping, ledger, partial, signal(), choices);
      expect(retry.categories).toBe(0);
      expect(retry.batches[0]!.body.transactions![0]!.category_id).toBe(created[1]!.id);
      expect(state.categories).toEqual([privateCategory]);
    } catch (cause) {
      throw new Error('跨所有者来源与重试身份验证失败', { cause });
    }
  });

  it('共享账本成员只能映射已有owner分类，不能顺手创建个人分类', async () => {
    try {
      const table = { headers: ['时间', '金额', '分类'], rows: [['2026-09-30', '1', '旅行']] };
      const editor = { ...ledger, role: 'editor' as const };
      const plan = await buildImportPlan(
        table,
        detectTransferMapping(table.headers),
        editor,
        snapshot,
        signal(),
        await chooseNew(table),
      );
      expect(plan.errors[0]?.message).toContain('只有账本所有者');
      expect(plan.categories).toBe(0);
      expect(plan.count).toBe(0);
    } catch (cause) {
      throw new Error('共享成员分类导入权限验证失败', { cause });
    }
  });

  it('导出再导入保留同名分类ID、图标与owner，来源相同不会重建分类', async () => {
    try {
      const ids = ['c63266e7-7640-464c-ad22-bd9b5e1a4d1e', '8260fcb3-c519-49bc-909c-f44fb90d0850'];
      const categories = ids.map((id, index) => ({
        id,
        name: '旅行',
        level: 1,
        parent_id: null,
        icon: index ? 'car' : 'plane',
        owner_id: ledger.owner_id,
      })) as Snapshot['categories'];
      const transactions = ids.map((category_id, index) => ({
        id: `transaction-${index}`,
        category_id,
        amount: '1',
        native_amount: '1',
        currency_code: 'CNY',
        happened_at: stamp,
        note: null,
      })) as Snapshot['transactions'];
      const output = accountingCsv({ ...snapshot, categories, transactions }, '', '');
      const parsed = parseDelimited(output.text.replace(/^\uFEFF/, ''), ',');
      const table = { headers: parsed[0]!, rows: parsed.slice(1) };
      expect(table.rows.map((row) => row[table.headers.indexOf('category_id')])).toEqual(ids);
      expect(table.rows.map((row) => row[table.headers.indexOf('category_scope')])).toEqual(
        ids.map(() => `account:${ledger.owner_id}`),
      );
      const plan = await buildImportPlan(
        table,
        detectTransferMapping(table.headers),
        ledger,
        { ...snapshot, categories },
        signal(),
      );
      expect(plan.categoryRequests).toEqual([]);
      expect(plan.categories).toBe(0);
      expect(plan.batches.flatMap((batch) => batch.body.transactions ?? []).map((row) => row.category_id)).toEqual(ids);
    } catch (cause) {
      throw new Error('同名分类导出往返身份验证失败', { cause });
    }
  });

  it('所选目标失效时重新显示映射入口，不凭名称改挂到另一分类', async () => {
    try {
      const table = { headers: ['时间', '金额', '分类'], rows: [['2026-09-30', '1', '旅行']] };
      const mapping = detectTransferMapping(table.headers);
      const { sources } = await categoryImportSources(table, mapping);
      const source = [...sources.values()][0]!;
      const choices: CategoryImportChoices = { [source.key]: { kind: 'existing', id: 'deleted-target' } };
      const plan = await buildImportPlan(table, mapping, ledger, snapshot, signal(), choices);
      expect(plan.categoryRequests.map((item) => item.key)).toEqual([source.key]);
      expect(plan.errors[0]?.message).toContain('已不可用');
      expect(plan.count).toBe(0);
      expect(plan.categories).toBe(0);
    } catch (cause) {
      throw new Error('导入目标失效保护验证失败', { cause });
    }
  });
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
    const choices = await chooseNew(table);
    const first = await buildImportPlan(table, mapping, ledger, snapshot, signal(), choices);
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
    const repeat = await buildImportPlan(table, mapping, ledger, snapshot, signal(), choices);
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
    expect(plan.errors.map((error) => error.row)).toEqual([2, 3, 4]);
    expect(plan.categoryRequests.map((source) => source.rows)).toEqual([[5]]);
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
    expect(rows[0]).toEqual([
      '类型',
      '分类',
      '子分类',
      '金额',
      '币种',
      '备注',
      '时间',
      'native_amount',
      'category_icon',
      'sub_category_icon',
      'category_scope',
      'category_id',
      'parent_category_id',
    ]);
    expect(rows[1]).toHaveLength(13);
  });
});
