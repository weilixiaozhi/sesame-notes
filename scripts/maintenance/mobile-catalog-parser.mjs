import { createHash } from 'node:crypto';
import { buildCategoryAssets } from '../lib/catalog-data.mjs';
export const sourceFiles = {
  categories: [
    'lib/utils/default_category_keys.dart',
    'lib/shared/services/seed_service.dart',
    'lib/l10n/app_zh.arb',
    'lib/utils/default_category_ids.dart',
  ],
  currencies: [
    'lib/utils/currency/currencies.dart',
    'lib/shared/presentation/currency_names.dart',
    'lib/l10n/app_zh.arb',
  ],
};
const dartStringPattern = /'((?:\\.|[^'\\])*)'/g;

/** 为生成资产保留相同顺序的手机源路径和内容摘要。 */
function sourceHashes(files, contents) {
  return files.map((file, index) => ({ file, sha256: createHash('sha256').update(contents[index]).digest('hex') }));
}

/** 解析手机源文件中的字符串转义，避免币种符号中的美元和英文名中的撇号失真。 */
function dartString(value) {
  return value.replace(/\\(.)/g, (_, escaped) => {
    const escapes = { '\\': '\\', "'": "'", '"': '"', $: '$', n: '\n', r: '\r', t: '\t' };
    if (!Object.hasOwn(escapes, escaped)) throw new Error(`不支持的 Dart 字符串转义：\\${escaped}`);
    return escapes[escaped];
  });
}

/** 读取列表中全部字符串，保留手机源定义的先后顺序。 */
function strings(source) {
  return [...source.matchAll(dartStringPattern)].map((match) => dartString(match[1]));
}

/** 从手机币种目录、本地化映射和中文翻译生成可独立随 Web 构建的内容资产。 */
export function buildCurrencyCatalog(definitions, nameMappings, arb) {
  try {
    const translations = JSON.parse(arb);
    const definitionBlock = definitions.match(/const List<_Cur> _kCurrencyDefs = \[([\s\S]*?)\];/)?.[1];
    const commonBlock = definitions.match(/const List<String> kCommonCurrencyCodes = \[([\s\S]*?)\];/)?.[1];
    const commonPriorityBlock = definitions.match(/_kCommonCurrencyPriority = \{([\s\S]*?)\};/)?.[1];
    const chinesePriority = commonPriorityBlock?.match(/'zh':\s*\[([\s\S]*?)\]/)?.[1];
    if (!definitionBlock || !commonBlock || !chinesePriority)
      throw new Error('手机币种目录或中文排序结构发生变化，请检查生成器。');

    const translationKeys = new Map(
      [...nameMappings.matchAll(/'([A-Z]{3})':\s*l10n\.(\w+)/g)].map((match) => [match[1], match[2]]),
    );
    if (!translationKeys.size) throw new Error('未读取到手机币种名称映射，请检查生成器。');

    // 一次匹配完整构造调用，带转义的字符串不会被括号或撇号错误截断。
    const entries = [...definitionBlock.matchAll(/_Cur\(\s*((?:'(?:\\.|[^'\\])*'\s*,?\s*){3})\)/g)];
    if (!entries.length || entries.length !== (definitionBlock.match(/_Cur\(/g) ?? []).length)
      throw new Error('手机币种定义包含无法解析的条目，请检查生成器。');
    const currencies = entries.map((match) => {
      const [code, symbol, englishName] = strings(match[1]);
      const translationKey = translationKeys.get(code);
      const translated = translationKey ? translations[translationKey] : undefined;
      if (!/^[A-Z]{3}$/.test(code) || !symbol || !englishName) throw new Error(`手机币种定义无效：${code}`);
      if (translationKey && (typeof translated !== 'string' || !translated.trim()))
        throw new Error(`手机币种缺少中文翻译：${code} / ${translationKey}`);
      // 名称与代码分开存储，展示和搜索均无需再次从文案拆分代码。
      const name = (translated ?? englishName).replace(new RegExp(`\\s*[（(]${code}[）)]\\s*$`), '').trim();
      if (!name) throw new Error(`手机币种显示名称为空：${code}`);
      return { code, name, symbol, englishName };
    });
    const codes = new Set(currencies.map((currency) => currency.code));
    if (codes.size !== currencies.length) throw new Error('手机币种目录包含重复代码。');

    const common = strings(commonBlock);
    const priority = strings(chinesePriority);
    if (new Set(common).size !== common.length || new Set(priority).size !== priority.length)
      throw new Error('手机常用币种或中文优先级存在重复代码。');
    if (common.some((code) => !codes.has(code)) || priority.some((code) => !common.includes(code)))
      throw new Error('手机常用币种或中文优先级引用了目录外币种。');
    // 与手机 commonCurrencyOrderForLocale('zh', '') 相同：中文优先级在前，其余常用币种接在后面。
    const commonCodes = [...priority, ...common.filter((code) => !priority.includes(code))];
    const contents = [definitions, nameMappings, arb];
    const sources = sourceHashes(sourceFiles.currencies, contents);
    return { version: 1, sources, commonCodes, currencies };
  } catch (error) {
    throw new Error('生成 Web 币种目录失败，请检查手机币种源文件与中文翻译。', { cause: error });
  }
}

/** 从手机分类模板生成 Web 目录、图标和服务端官方身份资产。 */
export function buildCategoryCatalogs(keys, seed, arb, identitySource) {
  try {
    const contents = [keys, seed, arb, identitySource];
    const translations = JSON.parse(arb);
    const groupText = keys.match(/kExpenseCategoryTemplates = \{([\s\S]*?)\};/)?.[1] ?? '';
    const definitions = [...groupText.matchAll(/'([^']+)':\s*\[([\s\S]*?)\]/g)].map((match) => ({
      key: match[1],
      children: strings(match[2]),
    }));
    const icons = Object.fromEntries(
      [...(seed.match(/const expenseIcons = \{([\s\S]*?)\};/)?.[1] ?? '').matchAll(/'([^']+)':\s*'([^']+)'/g)].map(
        (match) => [match[1], match[2]],
      ),
    );
    // 身份来源与手机纯 helper 一致；算法改动必须显式更新生成器。
    const namespace = identitySource.match(/const _namespace = '([0-9a-f-]+)'/)?.[1]?.replaceAll('-', '');
    if (!namespace || namespace.length !== 32 || !identitySource.includes("'cat:expense:$level:$key'"))
      throw new Error('手机官方分类身份算法发生变化，请检查生成器');
    if (!definitions.length || !Object.keys(icons).length) throw new Error('手机模板源结构发生变化，请检查生成器');
    /** 每个资源键独立读取翻译；名称中的连字符属于内容，不参与拆分结构。 */
    const item = (key) => {
      const translationKey = `categoryName${key
        .split('_')
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join('')}`;
      const name = translations[translationKey];
      if (typeof name !== 'string' || !name.trim()) throw new Error(`分类缺少独立翻译：${key}`);
      return { key, name: name.trim(), icon: icons[key] ?? 'category' };
    };
    const groups = definitions.map((group) => ({ ...item(group.key), children: group.children.map(item) }));
    const selectionSource = seed.match(/hybridCategoryTemplate = \[([\s\S]*?)\r?\n\s*\];/)?.[1] ?? '';
    const initialSelection = [
      ...selectionSource.matchAll(/\(\s*key:\s*'([^']+)',\s*children:\s*(null|\[[\s\S]*?\]),?\s*\)/g),
    ].map((match) => ({
      key: match[1],
      children: match[2] === 'null' ? [] : strings(match[2]),
    }));
    if (!initialSelection.length) throw new Error('手机默认分类选择结构发生变化，请检查生成器');
    const sources = sourceHashes(sourceFiles.categories, contents);
    const input = { namespace, sources, groups, initialSelection };
    return { ...buildCategoryAssets(input), input };
  } catch (error) {
    throw new Error('生成分类目录失败，请检查手机分类源文件与中文翻译。', { cause: error });
  }
}
