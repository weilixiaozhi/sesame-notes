import { importTimestamp } from '../../../lib/transfer/timestamp';
import type { operations } from '@sesame-notes/api-client';
import { canonicalAmount, localDateTime } from '../money';
import { convertAmount } from '../currency-math';
import { createImportId } from '../../../lib/transfer/import-identity';
import type { SelectedTable } from '../../../lib/transfer/table';
import { transferFields, type Ledger, type Snapshot, type TransferKey, type TransferMapping } from './transfer-schema';
import {
  categoryImportSources,
  categoryImportId,
  categoryTargetScope,
  type CategoryImportChoices,
  type CategoryImportSource,
} from './category-transfer';

type ImportBody = operations['postLedgersByLedgerIdImports']['requestBody']['content']['application/json'];
type CategoryInput = NonNullable<ImportBody['categories']>[number];
type TransactionInput = NonNullable<ImportBody['transactions']>[number];
export type ImportPlan = {
  query: NonNullable<operations['postLedgersByLedgerIdImports']['parameters']['query']>;
  batches: Array<{ body: ImportBody; key: string; done: boolean }>;
  count: number;
  skipped: number;
  categories: number;
  categoryRequests: CategoryImportSource[];
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
  categoryChoices: CategoryImportChoices = {},
): Promise<ImportPlan> {
  if (!mapping.date || !mapping.amount) throw new Error('请先映射日期和金额列');
  if (snapshot.ledger.id !== ledger.id || snapshot.ledger.sync_id !== ledger.sync_id)
    throw new Error('账本同步身份已经变化，请重新打开');
  // 没有分类身份内容的文件使用普通字段指纹，空机器列不改变交易重导身份。
  const identityFields = ['category_scope', 'category_id', 'parent_category_id'] as const;
  const identityFieldSet = new Set<string>(identityFields);
  const hasIdentityData = identityFields.some(
    (key) => mapping[key] && table.rows.some((row) => (row[table.headers.indexOf(mapping[key])] ?? '').trim()),
  );
  const identityMapping = Object.fromEntries(
    Object.entries(mapping).filter(([key, value]) => !identityFieldSet.has(key) || (hasIdentityData && value)),
  );
  const fingerprint = await transferDigest(JSON.stringify({ table, mapping: identityMapping, ledger: ledger.id }));
  const transactions: TransactionInput[] = [];
  const categories: CategoryInput[] = [];
  const errors: ImportPlan['errors'] = [];
  const preview: ImportPlan['preview'] = [];
  const existing = new Set(snapshot.transactions.map((item) => item.id));
  const sourceCatalog = await categoryImportSources(table, mapping);
  const targetScope = categoryTargetScope(snapshot);
  // 完整快照必须属于账本 owner；相同裸 ID 不能把另一账号的分类带入当前目录。
  const pool = new Map(
    snapshot.categories
      .filter((item) => !item.owner_id || `account:${item.owner_id}` === targetScope)
      .map((item) => [item.id, item]),
  );
  const deletedIds = new Set(
    snapshot.category_tombstones
      .filter((item) => !item.owner_id || `account:${item.owner_id}` === targetScope)
      .map((item) => item.id),
  );
  const resolved = new Map<string, string>();
  const requests = new Map<string, CategoryImportSource>();
  let skipped = 0;
  const cell = (row: string[], key: TransferKey) =>
    mapping[key] ? (row[table.headers.indexOf(mapping[key])] ?? '') : '';
  /** 按确认的来源映射解析目标，名称和图标只用于展示，不能作为自动匹配条件。 */
  const resolveCategory = async (sourceKey: string, asParent = false): Promise<string> => {
    const source = sourceCatalog.sources.get(sourceKey);
    if (!source) throw new Error('分类来源缺失，请重新预览');
    const cached = resolved.get(sourceKey);
    if (cached) {
      const row = pool.get(cached) ?? categories.find((item) => item.id === cached);
      if (asParent && (!row || row.parent_id !== null)) {
        requests.set(sourceKey, source);
        throw new Error('请选择无所属分类的目标，最多支持一层子分类');
      }
      return cached;
    }
    const choice = categoryChoices[sourceKey];
    const sameScope = source.scope && source.scope === targetScope;
    const existingId = choice?.kind === 'existing' ? choice.id : !choice && sameScope ? source.sourceId : null;
    const existingCategory = existingId ? pool.get(existingId) : undefined;
    if (existingCategory) {
      if (asParent && existingCategory.parent_id !== null) {
        requests.set(sourceKey, source);
        throw new Error('请选择无所属分类的目标，最多支持一层子分类');
      }
      resolved.set(sourceKey, existingCategory.id);
      return existingCategory.id;
    }
    if (choice?.kind === 'existing') {
      requests.set(sourceKey, source);
      throw new Error('所选分类已不可用，请重新选择目标分类');
    }
    if (!choice) {
      requests.set(sourceKey, source);
      if (source.parentKey && !categoryChoices[source.parentKey]) {
        const parent = sourceCatalog.sources.get(source.parentKey)!;
        if (!(parent.scope === targetScope && pool.has(parent.sourceId))) requests.set(parent.key, parent);
      }
      throw new Error('CATEGORY_MAPPING_REQUIRED');
    }
    if (ledger.role !== 'owner') throw new Error('只有账本所有者可以新建分类，请选择已有分类');
    if (!source.name || Array.from(source.name).length > 100) throw new Error('分类名称需要为 1 至 100 个字');
    const parentId = source.parentKey ? await resolveCategory(source.parentKey, true) : null;
    const id = await categoryImportId(ledger.id, sourceKey);
    if (deletedIds.has(id)) {
      requests.set(sourceKey, source);
      throw new Error('此次导入的分类曾被删除，请明确选择其他目标分类');
    }
    const previous = pool.get(id);
    if (previous) {
      if (asParent && previous.parent_id !== null) {
        requests.set(sourceKey, source);
        throw new Error('此前导入的父分类已改变层级，请重新选择');
      }
      resolved.set(sourceKey, id);
      return id;
    }
    const category: CategoryInput = {
      id,
      name: source.name,
      level: parentId ? 2 : 1,
      parent_id: parentId,
      kind: 'expense',
      icon: source.icon,
    };
    categories.push(category);
    resolved.set(sourceKey, id);
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
      if (sub && !top) throw new Error('子分类需要明确的所属分类');
      const sourceKey = sourceCatalog.rowKeys[index];
      const categoryId = sourceKey ? await resolveCategory(sourceKey) : null;
      const chosen = categoryId ? (pool.get(categoryId) ?? categories.find((item) => item.id === categoryId)) : null;
      const chosenParent = chosen?.parent_id
        ? (pool.get(chosen.parent_id) ?? categories.find((item) => item.id === chosen.parent_id))
        : null;
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
          category: chosen ? [chosenParent?.name, chosen.name].filter(Boolean).join(' / ') : '未分类',
        });
    } catch (error) {
      if (error instanceof Error && error.message === 'CATEGORY_MAPPING_REQUIRED') continue;
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
  return {
    query,
    batches,
    count: transactions.length,
    skipped,
    categories: categories.length,
    categoryRequests: [...requests.values()],
    errors,
    preview,
  };
}

/** 提交前验证已确认的目标身份仍可用；不按名称寻找替代分类。 */
export function validateImportTargets(plan: ImportPlan, snapshot: Snapshot): void {
  try {
    const pending = plan.batches.filter((batch) => !batch.done);
    const created = new Set(pending.flatMap((batch) => (batch.body.categories ?? []).map((row) => row.id)));
    const scope = categoryTargetScope(snapshot);
    const current = new Map(
      snapshot.categories
        .filter((row) => !row.deleted_at && (!row.owner_id || `account:${row.owner_id}` === scope))
        .map((row) => [row.id, row]),
    );
    for (const batch of pending) {
      for (const category of batch.body.categories ?? []) {
        const parent = category.parent_id;
        if (parent && !created.has(parent)) {
          const target = current.get(parent);
          if (!target || target.parent_id !== null) throw new Error('目标父分类已改变，请重新校验并选择');
        }
      }
      for (const transaction of batch.body.transactions ?? []) {
        if (transaction.category_id && !created.has(transaction.category_id) && !current.has(transaction.category_id))
          throw new Error('目标分类已不可用，请重新校验并选择');
      }
    }
  } catch (cause) {
    throw new Error(cause instanceof Error ? cause.message : '分类状态无法确认，请重新校验', { cause });
  }
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
  const scope = categoryTargetScope(snapshot);
  const categories = new Map(
    snapshot.categories
      .filter((item) => !item.owner_id || `account:${item.owner_id}` === scope)
      .map((item) => [item.id, item]),
  );
  const records = snapshot.transactions.filter((item) => {
    const time = new Date(item.happened_at);
    return (!lower || time >= lower) && (!upper || time < upper);
  });
  const rows = [
    [
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
    ],
    ...records.map((item) => {
      const category = item.category_id ? categories.get(item.category_id) : undefined;
      const parent = category?.parent_id ? categories.get(category.parent_id) : undefined;
      return [
        '支出',
        category?.parent_id ? (parent?.name ?? '') : (category?.name ?? item.category_name ?? ''),
        category?.parent_id ? category.name : '',
        item.amount,
        item.currency_code,
        item.note ?? '',
        item.happened_at,
        item.native_amount,
        (parent ?? category)?.icon ?? '',
        category?.parent_id ? (category.icon ?? '') : '',
        item.category_id ? (scope ?? '') : '',
        item.category_id ?? '',
        category?.parent_id ?? '',
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
