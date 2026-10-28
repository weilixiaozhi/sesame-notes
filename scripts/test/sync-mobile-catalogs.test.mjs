import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildCategoryCatalogs, buildCurrencyCatalog } from '../maintenance/mobile-catalog-parser.mjs';

const definitions = String.raw`
const List<_Cur> _kCurrencyDefs = [
  _Cur('USD', '\$', 'US Dollar'),
  _Cur('CNY', '¥', 'Chinese Yuan'),
  _Cur('JPY', 'JP¥', 'Japanese Yen'),
  _Cur('TOP', 'TOP', 'Tongan Pa\'anga'),
];
const List<String> kCommonCurrencyCodes = ['USD', 'CNY', 'JPY'];
const Map<String, List<String>> _kCommonCurrencyPriority = {
  'zh': ['CNY', 'JPY'],
  'en': ['USD'],
};`;
const mappings = "'USD': l10n.currencyUSD, 'CNY': l10n.currencyCNY, 'JPY': l10n.currencyJPY";
const arb = JSON.stringify({ currencyUSD: '美元', currencyCNY: '人民币 (CNY)', currencyJPY: '日元' });
const categoryKeys = `
const List<String> kFlatExpenseCategoryKeys = ['dining', 'transport'];
const Map<String, List<String>> kHierarchicalExpenseCategories = {'dining': ['dining_breakfast']};`;
const categorySeed = `
const expenseIcons = {'dining': 'utensils', 'dining_breakfast': 'coffee', 'transport': 'bus'};
hybridCategoryTemplate = [
  (key: 'transport', children: null),
  (key: 'dining', children: ['dining_breakfast']),
];`;
const categoryIdentity = String.raw`const _namespace = 'b3e7c0de-0000-4000-8000-beec00000001';
String defaultCategoryId({required int level, required String key}) => 'cat:expense:$level:$key';`;
const combinedArb = JSON.stringify({
  ...JSON.parse(arb),
  categoryExpenseList: '餐饮-交通',
  categoryExpenseDining: '餐饮-早餐',
});
test('手机币种转义、名称和中文优先级可准确生成，未翻译币种回退英文名', () => {
  const catalog = buildCurrencyCatalog(definitions, mappings, arb);
  assert.deepEqual(catalog.commonCodes, ['CNY', 'JPY', 'USD']);
  assert.deepEqual(catalog.currencies[0], { code: 'USD', name: '美元', symbol: '$', englishName: 'US Dollar' });
  assert.equal(catalog.currencies[1].name, '人民币');
  assert.equal(catalog.currencies[2].symbol, 'JP¥');
  assert.equal(catalog.currencies[3].englishName, "Tongan Pa'anga");
  assert.equal(catalog.currencies[3].name, "Tongan Pa'anga");
  assert.deepEqual(buildCurrencyCatalog(definitions, mappings, arb), catalog);
});

test('常用币种顺序只使用当前地区优先级，其余常用币种保留定义顺序', () => {
  // 其他流程的独立排序不能覆盖常用币种管理与选择器共享的地区优先级。
  const source = `${definitions}\nconst Map<String, List<String>> kInitialCurrencyPriority = {'zh': ['USD']};`;
  const catalog = buildCurrencyCatalog(source, mappings, arb);
  assert.deepEqual(catalog.commonCodes, ['CNY', 'JPY', 'USD']);
  assert.equal(new Set(catalog.commonCodes).size, 3);
  assert.throws(
    () =>
      buildCurrencyCatalog(definitions.replace('_kCommonCurrencyPriority', 'kInitialCurrencyPriority'), mappings, arb),
    {
      cause: new Error('手机币种目录或中文排序结构发生变化，请检查生成器。'),
    },
  );
});

test('缺失翻译或不完整目录必须失败，防止把残缺资产用于选择器', () => {
  assert.throws(() => buildCurrencyCatalog(definitions, mappings, '{}'), {
    cause: new Error('手机币种缺少中文翻译：USD / currencyUSD'),
  });
  assert.throws(
    () =>
      buildCurrencyCatalog(definitions.replace("_Cur('TOP', 'TOP', 'Tongan Pa\\'anga')", "_Cur('TOP')"), mappings, arb),
    {
      cause: new Error('手机币种定义包含无法解析的条目，请检查生成器。'),
    },
  );
});

test('已生成资产完整且保留人民币与日元符号消歧，不依赖手机仓库', async () => {
  const catalog = JSON.parse(
    await readFile(new URL('../../apps/web/src/features/accounting/currency-catalog.json', import.meta.url), 'utf8'),
  );
  assert.equal(new Set(catalog.currencies.map((item) => item.code)).size, catalog.currencies.length);
  assert.deepEqual(catalog.commonCodes.slice(0, 6), ['CNY', 'HKD', 'MOP', 'TWD', 'USD', 'EUR']);
  assert.equal(catalog.currencies.find((item) => item.code === 'CNY').symbol, '¥');
  assert.equal(catalog.currencies.find((item) => item.code === 'JPY').symbol, 'JP¥');
  for (const item of catalog.currencies) {
    assert.deepEqual(Object.keys(item), ['code', 'name', 'symbol', 'englishName']);
    assert.match(item.code, /^[A-Z]{3}$/);
    assert.ok(item.name && item.symbol && item.englishName);
    assert.ok(!item.name.includes(`(${item.code})`));
  }
});

test('分类生成保留已发布的官方身份、默认混合顺序与二级父关系', () => {
  const catalog = buildCategoryCatalogs(categoryKeys, categorySeed, combinedArb, categoryIdentity);
  assert.deepEqual(
    catalog.templates.flat.map((entry) => entry.name),
    ['餐饮', '交通'],
  );
  assert.deepEqual(
    catalog.defaults.items.map((entry) => [entry.key, entry.sort_order]),
    [
      ['transport', 0],
      ['dining', 1],
      ['dining_breakfast', 0],
    ],
  );
  const dining = catalog.defaults.items.find((entry) => entry.key === 'dining');
  const breakfast = catalog.defaults.items.find((entry) => entry.key === 'dining_breakfast');
  assert.equal(dining.id, 'ffec6471-df8b-5bb3-8a05-93ef863ca958');
  assert.equal(breakfast.id, '02d2cbc5-0298-5dea-ae85-f4616e0eafc2');
  assert.equal(breakfast.parent_id, dining.id);
  assert.equal(catalog.identities.items.length, 3);
  assert.equal(catalog.templates.sources.length, 4);
});

test('分类身份算法或翻译数量不兼容时拒绝生成资产', () => {
  assert.throws(
    () =>
      buildCategoryCatalogs(
        categoryKeys,
        categorySeed,
        combinedArb,
        categoryIdentity.replace('cat:expense', 'cat:other'),
      ),
    {
      cause: new Error('手机官方分类身份算法发生变化，请检查生成器'),
    },
  );
  assert.throws(
    () => buildCategoryCatalogs(categoryKeys, categorySeed, combinedArb.replace('餐饮-早餐', '餐饮'), categoryIdentity),
    {
      cause: new Error('分类翻译数量不匹配：dining'),
    },
  );
});
