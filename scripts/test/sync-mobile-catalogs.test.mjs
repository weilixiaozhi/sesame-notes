import assert from 'node:assert/strict';
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
test('币种源数据解析保留全部ISO身份', () => {
  const catalog = buildCurrencyCatalog(definitions, mappings, arb);
  assert.deepEqual(catalog.currencies.map((entry) => entry.code).sort(), ['CNY', 'JPY', 'TOP', 'USD']);
});

test('缺失必要翻译或不完整条目时拒绝目录', () => {
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

test('分类生成保留已发布的官方身份与二级父关系', () => {
  const catalog = buildCategoryCatalogs(categoryKeys, categorySeed, combinedArb, categoryIdentity);
  const dining = catalog.defaults.items.find((entry) => entry.key === 'dining');
  const breakfast = catalog.defaults.items.find((entry) => entry.key === 'dining_breakfast');
  assert.equal(dining.id, 'ffec6471-df8b-5bb3-8a05-93ef863ca958');
  assert.equal(breakfast.id, '02d2cbc5-0298-5dea-ae85-f4616e0eafc2');
  assert.equal(breakfast.parent_id, dining.id);
  assert.equal(catalog.identities.items.length, 3);
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
