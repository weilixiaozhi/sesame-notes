import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCategoryCatalogs, buildCurrencyCatalog } from '../maintenance/mobile-catalog-parser.mjs';
import { buildCategoryAssets, validateCatalogInput, validateCategoryContent } from '../lib/catalog-data.mjs';

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
const Map<String, List<String>> kExpenseCategoryTemplates = {'dining': ['dining_breakfast'], 'transport': []};`;
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
  categoryNameDining: '餐饮',
  categoryNameDiningBreakfast: '早餐',
  categoryNameTransport: '交通',
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

test('分类身份算法或独立翻译不兼容时拒绝生成资产', () => {
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
    () =>
      buildCategoryCatalogs(
        categoryKeys,
        categorySeed,
        combinedArb.replace('categoryNameDiningBreakfast', 'missingKey'),
        categoryIdentity,
      ),
    {
      cause: new Error('分类缺少独立翻译：dining_breakfast'),
    },
  );
});

test('统一模板只有内容树，独立父项和带连字符的名称均完整保留', () => {
  const catalog = buildCategoryCatalogs(
    categoryKeys,
    categorySeed,
    combinedArb.replace('早餐', '早-餐'),
    categoryIdentity,
  );
  assert.deepEqual(catalog.templates.groups, [
    {
      key: 'dining',
      name: '餐饮',
      icon: 'utensils',
      children: [{ key: 'dining_breakfast', name: '早-餐', icon: 'coffee' }],
    },
    { key: 'transport', name: '交通', icon: 'bus', children: [] },
  ]);
  assert.deepEqual(Object.keys(catalog.templates), ['sources', 'groups']);
  assert.deepEqual(catalog.input.initialSelection, [
    { key: 'transport', children: [] },
    { key: 'dining', children: ['dining_breakfast'] },
  ]);
  assert.ok(!JSON.stringify(catalog.templates).includes('seed_id'));
  assert.ok(!JSON.stringify(catalog.templates).includes('level'));
});

test('统一资源允许重名，但拒绝重复资源键、额外层级及错误默认选择', () => {
  const input = buildCategoryCatalogs(categoryKeys, categorySeed, combinedArb, categoryIdentity).input;
  const named = structuredClone(input);
  named.groups[1].name = named.groups[0].name;
  assert.doesNotThrow(() => validateCategoryContent(named));
  for (const mutate of [
    (value) => {
      value.groups[1].key = value.groups[0].key;
    },
    (value) => {
      value.groups[0].children[0].children = [];
    },
    (value) => {
      value.groups[0].seed_id = 'fixed-user-id';
    },
    (value) => {
      value.initialSelection[0].children = ['dining_breakfast'];
    },
    (value) => {
      value.initialSelection.push(value.initialSelection[0]);
    },
  ]) {
    const invalid = structuredClone(input);
    mutate(invalid);
    assert.throws(() => buildCategoryAssets(invalid));
  }
});

test('共同输入只接受v2内容树，来源摘要、币种和健身版本保持独立校验', () => {
  const categories = buildCategoryCatalogs(categoryKeys, categorySeed, combinedArb, categoryIdentity).input;
  const currencies = buildCurrencyCatalog(definitions, mappings, combinedArb);
  const files = [
    ...new Map([...categories.sources, ...currencies.sources].map((source) => [source.file, source])).values(),
    { file: 'assets/fitness/exercises.json', sha256: 'c'.repeat(64) },
  ];
  const input = {
    format: 'sesame-notes.shared-catalogs',
    version: 2,
    source: { repository: 'sesame-notes-mobile', revision: 'a'.repeat(40), files: files.map((file) => ({ ...file })) },
    categories,
    currencies,
    fitness: {
      source: 'https://example.test/fitness',
      source_commit: 'b'.repeat(40),
      exercises: [{ id: 'exercise', body_part: 'chest' }],
    },
  };
  assert.equal(validateCatalogInput(input), input);
  assert.throws(() => validateCatalogInput({ ...input, version: 1 }));
  const changed = structuredClone(input);
  changed.categories.sources[0].sha256 = 'd'.repeat(64);
  assert.throws(() => validateCatalogInput(changed));
});
