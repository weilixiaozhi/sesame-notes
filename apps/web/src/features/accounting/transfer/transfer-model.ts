import { importTimestamp } from '../../../lib/transfer/timestamp';
import type { components, operations } from '@sesame-notes/api-client';
import { canonicalAmount, localDateTime } from '../money';
import { convertAmount } from '../currency-math';
import { createImportId } from '../../../lib/transfer/import-identity';
import type { SelectedTable } from '../../../lib/transfer/table';

export type Ledger = components['schemas']['Ledger'];
export type Snapshot = operations['getSyncFull']['responses'][200]['content']['application/json'];
type ImportBody = operations['postLedgersByLedgerIdImports']['requestBody']['content']['application/json'];
type CategoryInput = NonNullable<ImportBody['categories']>[number];
type TransactionInput = NonNullable<ImportBody['transactions']>[number];
export const transferFields = [
  ['date', '日期 / 时间', ['日期', '时间', '交易时间', 'happened_at', 'date']],
  ['amount', '金额', ['金额', 'amount']],
  ['type', '类型', ['类型', 'type', 'tx_type']],
  ['currency', '币种', ['币种', 'currency', 'currency_code']],
  ['category', '分类', ['分类', 'category', 'category_name']],
  ['sub_category', '二级分类', ['二级分类', 'sub_category']],
  ['category_icon', '分类图标', ['分类图标', 'category_icon']],
  ['sub_category_icon', '二级分类图标', ['二级分类图标', 'sub_category_icon']],
  ['note', '备注', ['备注', 'note', 'remark']],
  ['native_amount', '折算金额', ['折算金额', 'native_amount']],
  ['rate', '原币对本位币汇率', ['汇率', 'rate']],
] as const;
type TransferKey = (typeof transferFields)[number][0];
export type TransferMapping = Record<TransferKey, string>;
export type ImportPlan = {
  query: NonNullable<operations['postLedgersByLedgerIdImports']['parameters']['query']>;
  batches: Array<{ body: ImportBody; key: string; done: boolean }>;
  count: number;
  skipped: number;
  categories: number;
  errors: Array<{ row: number; message: string }>;
  preview: Array<{ row: number; date: string; amount: string; currency: string; category: string }>;
};

/** 标准字段与移动端中文 CSV 表头可自动匹配，最终映射仍由用户预览确认。 */
export function detectTransferMapping(headers: string[]): TransferMapping {
  return Object.fromEntries(
    transferFields.map(([key, , aliases]) => [
      key,
      headers.find((header) => aliases.some((alias) => alias.toLowerCase() === header.trim().toLowerCase())) ?? '',
    ]),
  ) as TransferMapping;
}

/** 文件内容指纹只用来产生稳定导入身份，不保存文件或交易明细。 */
async function transferDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 逐行先校验后生成计划，任何错误均阻止整份文件开始写入。 */
export async function buildImportPlan(
  table: SelectedTable,
  mapping: TransferMapping,
  ledger: Ledger,
  snapshot: Snapshot,
  signal: AbortSignal,
): Promise<ImportPlan> {
  if (!mapping.date || !mapping.amount) throw new Error('请先映射日期和金额列');
  if (snapshot.ledger.id !== ledger.id || snapshot.ledger.sync_id !== ledger.sync_id)
    throw new Error('账本同步身份已经变化，请重新打开');
  const fingerprint = await transferDigest(JSON.stringify({ table, mapping, ledger: ledger.id }));
  const transactions: TransactionInput[] = [];
  const categories: CategoryInput[] = [];
  const errors: ImportPlan['errors'] = [];
  const preview: ImportPlan['preview'] = [];
  const existing = new Set(snapshot.transactions.map((item) => item.id));
  const pool: Array<Pick<components['schemas']['Category'], 'id' | 'name' | 'level' | 'parent_id'>> = [
    ...snapshot.categories,
  ];
  let skipped = 0;
  const cell = (row: string[], key: TransferKey) =>
    mapping[key] ? (row[table.headers.indexOf(mapping[key])] ?? '') : '';
  const resolveCategory = async (name: string, parentId: string | null, icon: string) => {
    if (!name) return null;
    if (Array.from(name).length > 100) throw new Error('分类名不能超过 100 个字');
    const matches = pool.filter((item) => item.name === name && item.parent_id === parentId);
    if (matches.length > 1) throw new Error('存在同名分类，请先在分类管理中整理');
    if (matches[0]) return matches[0].id;
    if (ledger.role !== 'owner') throw new Error('分类不存在，需要账本所有者先创建');
    const id = await createImportId(ledger.id, 'accounting-category', `${parentId ?? ''}:${name}`);
    const category: CategoryInput = {
      id,
      name,
      level: parentId ? 2 : 1,
      parent_id: parentId,
      kind: 'expense',
      icon: icon.trim() || null,
    };
    categories.push(category);
    pool.push({ ...category, id, parent_id: parentId });
    return id;
  };
  for (let index = 0; index < table.rows.length; index++) {
    signal.throwIfAborted();
    const row = table.rows[index]!;
    try {
      const id = await createImportId(ledger.id, fingerprint, String(index));
      if (existing.has(id)) {
        skipped++;
        continue;
      }
      const type = cell(row, 'type').trim().toLowerCase();
      if (type && !['expense', '支出'].includes(type))
        throw new Error('当前账本仅支持支出，不会把其他类型自动转为支出');
      const amount = canonicalAmount(cell(row, 'amount'));
      if (!amount) throw new Error('金额必须大于零，最多 28 位整数和 10 位小数');
      const currency = cell(row, 'currency').trim().toUpperCase() || ledger.currency;
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('币种需要三位代码');
      const rawNative = cell(row, 'native_amount').trim();
      const native =
        currency === ledger.currency
          ? amount
          : rawNative
            ? canonicalAmount(rawNative)
            : cell(row, 'rate').trim()
              ? convertAmount(amount, cell(row, 'rate'), 10)
              : null;
      if (!native) throw new Error('外币交易需要映射折算金额或汇率列');
      if (currency === ledger.currency && rawNative && canonicalAmount(rawNative) !== amount)
        throw new Error('相同币种的金额与折算金额不一致');
      const date = importTimestamp(cell(row, 'date'));
      const note = cell(row, 'note');
      if (Array.from(note).length > 10000) throw new Error('备注超过 10000 个字');
      const top = cell(row, 'category').trim();
      const sub = cell(row, 'sub_category').trim();
      if (sub && !top) throw new Error('二级分类需要一级分类');
      const topId = await resolveCategory(top, null, cell(row, 'category_icon'));
      const categoryId = sub ? await resolveCategory(sub, topId, cell(row, 'sub_category_icon')) : topId;
      transactions.push({
        id,
        tx_type: 'expense',
        amount,
        native_amount: native,
        currency_code: currency,
        happened_at: date,
        category_id: categoryId,
        note: note || null,
      });
      if (preview.length < 5)
        preview.push({
          row: index + 2,
          date,
          amount,
          currency,
          category: [top, sub].filter(Boolean).join(' / ') || '未分类',
        });
    } catch (error) {
      errors.push({ row: index + 2, message: error instanceof Error ? error.message : '记录无效' });
    }
  }
  const batches: ImportPlan['batches'] = [];
  // 分类先按父级顺序提交；每批仍为服务端事务，界面明确报告已完成批次。
  if (categories.length <= 100 && transactions.length <= 500) {
    if (categories.length || transactions.length)
      batches.push({ body: { categories, transactions }, key: '', done: false });
  } else {
    for (let i = 0; i < categories.length; i += 100)
      batches.push({ body: { categories: categories.slice(i, i + 100) }, key: '', done: false });
    for (let i = 0; i < transactions.length; i += 500)
      batches.push({ body: { transactions: transactions.slice(i, i + 500) }, key: '', done: false });
  }
  const query: ImportPlan['query'] = {
    expected_sync_id: ledger.sync_id,
    expected_currency: ledger.currency,
    require_unarchived: true,
  };
  for (const batch of batches) {
    signal.throwIfAborted();
    batch.key = `web-import-${await transferDigest(JSON.stringify({ ledger: ledger.id, query, body: batch.body }))}`;
  }
  return { query, batches, count: transactions.length, skipped, categories: categories.length, errors, preview };
}

/** 导出完整精度的原币和折算金额，保留分类、备注和交易时间。 */
export function accountingCsv(snapshot: Snapshot, start: string, end: string): { text: string; count: number } {
  const lower = start ? new Date(`${start}T00:00:00`) : null;
  const upper = end ? new Date(`${end}T00:00:00`) : null;
  if (upper) upper.setDate(upper.getDate() + 1);
  if (
    (lower && !Number.isFinite(lower.getTime())) ||
    (upper && !Number.isFinite(upper.getTime())) ||
    (lower && upper && lower >= upper)
  )
    throw new Error('请选择有效的起止日期');
  const categories = new Map(snapshot.categories.map((item) => [item.id, item]));
  const records = snapshot.transactions.filter((item) => {
    const time = new Date(item.happened_at);
    return (!lower || time >= lower) && (!upper || time < upper);
  });
  const rows = [
    ['类型', '分类', '二级分类', '金额', '币种', '备注', '时间', 'native_amount'],
    ...records.map((item) => {
      const category = item.category_id ? categories.get(item.category_id) : undefined;
      const parent = category?.parent_id ? categories.get(category.parent_id) : undefined;
      return [
        '支出',
        category?.level === 2 ? (parent?.name ?? '') : (category?.name ?? item.category_name ?? ''),
        category?.level === 2 ? category.name : '',
        item.amount,
        item.currency_code,
        item.note ?? '',
        item.happened_at,
        item.native_amount,
      ];
    }),
  ];
  const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const text = `\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`;
  if (new TextEncoder().encode(text).byteLength > 64 * 1024 * 1024) throw new Error('导出超过 64 MB，请缩小日期范围');
  return { text, count: records.length };
}

/** 预览只显示日期和数额，完整备注不会写入日志。 */
export function previewDate(value: string): string {
  return localDateTime(value).replace('T', ' ');
}
