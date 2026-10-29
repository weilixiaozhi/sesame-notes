import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const catalogRoot = resolve(import.meta.dirname, '../..');
export const catalogInput = resolve(catalogRoot, 'data/catalogs/mobile-catalogs.v2.json');
const commitPattern = /^[0-9a-f]{40}$/;

/** 将固定命名空间、层级与键转换为客户端相同的 UUID v5 身份。 */
export function categoryId(namespace, level, key) {
  try {
    const bytes = createHash('sha1')
      .update(Buffer.from(namespace, 'hex'))
      .update(`cat:expense:${level}:${key}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch (error) {
    throw new Error('分类身份生成失败，请核对命名空间与分类键。', { cause: error });
  }
}

/** 对机器生成的共同输入做完整校验，拒绝未知版本、重复身份和失效父关系。 */
export function validateCatalogInput(input) {
  try {
    if (input?.format !== 'sesame-notes.shared-catalogs' || input.version !== 2)
      throw new Error('共同目录格式或版本不支持。');
    if (input.source?.repository !== 'sesame-notes-mobile' || !commitPattern.test(input.source.revision))
      throw new Error('共同目录必须记录客户端完整 commit SHA。');
    const expectedFiles = [
      'lib/utils/default_category_keys.dart',
      'lib/shared/services/seed_service.dart',
      'lib/l10n/app_zh.arb',
      'lib/utils/default_category_ids.dart',
      'lib/utils/currency/currencies.dart',
      'lib/shared/presentation/currency_names.dart',
      'assets/fitness/exercises.json',
    ];
    const sourceMap = new Map(input.source.files?.map((item) => [item.file, item.sha256]));
    if (
      sourceMap.size !== expectedFiles.length ||
      input.source.files.length !== expectedFiles.length ||
      expectedFiles.some((file) => !/^[0-9a-f]{64}$/.test(sourceMap.get(file)))
    )
      throw new Error('共同目录源文件摘要缺失或无效。');
    for (const [catalog, files] of [
      [input.categories, expectedFiles.slice(0, 4)],
      [input.currencies, [expectedFiles[4], expectedFiles[5], expectedFiles[2]]],
    ]) {
      if (
        catalog.sources?.length !== files.length ||
        catalog.sources.some((item, index) => item.file !== files[index] || sourceMap.get(item.file) !== item.sha256)
      )
        throw new Error('目录与源文件摘要不一致。');
    }
    validateCategoryContent(input.categories);
    const { version, currencies, commonCodes } = input.currencies;
    if (
      version !== 1 ||
      !Array.isArray(currencies) ||
      !currencies.length ||
      !Array.isArray(commonCodes) ||
      !commonCodes.length
    )
      throw new Error('币种目录格式无效。');
    const codes = new Set();
    for (const currency of currencies) {
      if (
        !/^[A-Z]{3}$/.test(currency.code) ||
        codes.has(currency.code) ||
        ['name', 'symbol', 'englishName'].some(
          (field) => typeof currency[field] !== 'string' || !currency[field].trim(),
        )
      )
        throw new Error('币种字段缺失或代码重复。');
      codes.add(currency.code);
    }
    if (new Set(commonCodes).size !== commonCodes.length || commonCodes.some((code) => !codes.has(code)))
      throw new Error('常用币种引用无效或重复。');
    validateFitnessCatalog(input.fitness);
    return input;
  } catch (error) {
    throw new Error('共同目录输入校验失败，请使用显式导入命令重新生成并审查快照。', { cause: error });
  }
}

/** 模板只有资源键与两级包含关系；默认初始化独立保存有序键选择。 */
export function validateCategoryContent({ namespace, sources, groups, initialSelection, ...extra }) {
  try {
    if (Object.keys(extra).length || !/^[0-9a-f]{32}$/.test(namespace))
      throw new Error('分类输入字段或兼容命名空间无效。');
    if (
      !Array.isArray(sources) ||
      !Array.isArray(groups) ||
      !groups.length ||
      !Array.isArray(initialSelection) ||
      !initialSelection.length
    )
      throw new Error('分类模板与默认选择不能为空。');
    const keys = new Set();
    const byKey = new Map();
    for (const group of groups) {
      if (!Array.isArray(group.children)) throw new Error('分类模板必须显式提供子项数组。');
      for (const item of [group, ...group.children]) {
        const fields = item === group ? ['key', 'name', 'icon', 'children'] : ['key', 'name', 'icon'];
        if (
          Object.keys(item).length !== fields.length ||
          Object.keys(item).some((key) => !fields.includes(key)) ||
          !/^[a-z][a-z0-9_]*$/.test(item.key) ||
          keys.has(item.key) ||
          typeof item.name !== 'string' ||
          !item.name.trim() ||
          !/^[a-z][a-zA-Z0-9]*$/.test(item.icon)
        )
          throw new Error('分类资源字段无效、键重复或包含额外层级。');
        keys.add(item.key);
      }
      byKey.set(group.key, group);
    }
    const selected = new Set();
    for (const selection of initialSelection) {
      const group = byKey.get(selection.key);
      if (
        !group ||
        selected.has(selection.key) ||
        Object.keys(selection).length !== 2 ||
        !Array.isArray(selection.children)
      )
        throw new Error('默认分类选择无效或重复。');
      selected.add(selection.key);
      const children = new Set();
      for (const key of selection.children) {
        if (children.has(key) || !group.children.some((item) => item.key === key))
          throw new Error('默认子分类没有对应模板或存在重复选择。');
        children.add(key);
      }
    }
    return byKey;
  } catch (cause) {
    throw new Error('统一分类内容校验失败，请检查资源树与默认选择。', { cause });
  }
}

/** 校验健身身份投影，保留上游来源版本与动作原始顺序。 */
export function validateFitnessCatalog(catalog) {
  try {
    const source = new URL(catalog.source);
    if (
      source.protocol !== 'https:' ||
      source.username ||
      source.password ||
      source.search ||
      source.hash ||
      !commitPattern.test(catalog.source_commit)
    )
      throw new Error('健身来源必须是 HTTPS URL 和完整 commit SHA。');
    if (!Array.isArray(catalog.exercises) || !catalog.exercises.length) throw new Error('健身动作不能为空。');
    const ids = new Set();
    for (const item of catalog.exercises) {
      if (
        typeof item.id !== 'string' ||
        !item.id.trim() ||
        ids.has(item.id) ||
        typeof item.body_part !== 'string' ||
        !item.body_part.trim()
      )
        throw new Error('健身动作身份重复或字段无效。');
      ids.add(item.id);
    }
    return catalog;
  } catch (error) {
    throw new Error('健身目录输入无效。', { cause: error });
  }
}

/** 只从显式文件或服务端版本化快照读取输入，不探测其他仓库。 */
export async function readCatalogInput(path = catalogInput) {
  try {
    return validateCatalogInput(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    throw new Error('读取共同目录失败，请确认本仓快照存在且格式有效。', { cause: error });
  }
}

/** 统一内容树生成模板资源；固定身份只用于初始化及历史同步兼容资产。 */
export function buildCategoryAssets(input) {
  try {
    const byKey = validateCategoryContent(input);
    const { namespace, sources, groups, initialSelection } = input;
    /** 兼容身份从资源位置生成，永远不会写回模板资源。 */
    const identity = (item, level, parentKey = null) => ({
      id: categoryId(namespace, level, item.key),
      key: item.key,
      level,
      parent_id: parentKey === null ? null : categoryId(namespace, 1, parentKey),
    });
    const identities = groups
      .flatMap((group) => [identity(group, 1), ...group.children.map((child) => identity(child, 2, group.key))])
      .sort((left, right) => left.id.localeCompare(right.id));
    /** 默认选择仅决定首次初始化内容及显示排序，不限制用户使用模板的次数。 */
    const initialItem = (item, level, sortOrder, parentKey = null) => ({
      key: item.key,
      id: categoryId(namespace, level, item.key),
      name: item.name,
      kind: 'expense',
      level,
      sort_order: sortOrder,
      parent_id: parentKey === null ? null : categoryId(namespace, 1, parentKey),
      icon: item.icon,
    });
    const defaults = initialSelection.flatMap((selection, order) => {
      const group = byKey.get(selection.key);
      return [
        initialItem(group, 1, order),
        ...selection.children.map((key, childOrder) =>
          initialItem(
            group.children.find((child) => child.key === key),
            2,
            childOrder,
            group.key,
          ),
        ),
      ];
    });
    const iconNames = [
      ...new Set(groups.flatMap((group) => [group.icon, ...group.children.map((item) => item.icon)])),
    ].sort();
    /** 将手机图标名转换为 Lucide 导出组件名。 */
    const named = (name) => name[0].toUpperCase() + name.slice(1);
    return {
      identities: { version: 1, sources, items: identities },
      defaults: {
        version: 1,
        sources,
        items: defaults,
      },
      templates: { sources, groups },
      icons: `// 从手机分类内容提取图标清单；通过 pnpm sync:web:categories 更新。\nimport { Shapes, ${iconNames.map(named).join(', ')} } from 'lucide-react';\n\nexport const categoryIcons = { ${iconNames.map((name) => `${name}: ${named(name)}`).join(', ')} };\n\n/** 未知历史图标仍保留原值，仅在 Web 展示中回落为通用分类图标。 */\nexport function CategoryIcon({ name, size = 18 }: { name: string | null; size?: number }) {\n const Icon = name && Object.hasOwn(categoryIcons, name) ? categoryIcons[name as keyof typeof categoryIcons] : Shapes;\n return <Icon size={size} aria-hidden />;\n}\n`,
    };
  } catch (error) {
    throw new Error('生成分类资产失败，请校验共同目录输入。', { cause: error });
  }
}
