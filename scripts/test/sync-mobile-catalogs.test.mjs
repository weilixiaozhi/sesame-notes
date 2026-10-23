import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, copyFile, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildCategoryCatalogs, buildCurrencyCatalog } from '../maintenance/mobile-catalog-parser.mjs';
import { syncCatalogs } from '../maintenance/sync-mobile-catalogs.mjs';
import { importCatalogs } from '../maintenance/import-mobile-catalogs.mjs';
import { validateCatalogInput } from '../lib/catalog-data.mjs';
import { writeCatalogOutputs } from '../lib/catalog-output.mjs';

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
const sourceContents = {
  'lib/utils/default_category_keys.dart': categoryKeys,
  'lib/shared/services/seed_service.dart': categorySeed,
  'lib/utils/default_category_ids.dart': categoryIdentity,
  'lib/utils/currency/currencies.dart': definitions,
  'lib/shared/presentation/currency_names.dart': mappings,
  'lib/l10n/app_zh.arb': combinedArb,
  'assets/fitness/exercises.json': JSON.stringify({
    source: 'https://example.com/exercises',
    source_commit: 'a'.repeat(40),
    exercises: [{ id: '0025', body_part: 'chest' }],
  }),
};
const assetPaths = [
  'apps/api/src/modules/accounting/official-category-identities.json',
  'apps/api/src/modules/accounting/default-category-catalog.json',
  'apps/web/src/features/accounting/category-catalog.json',
  'apps/web/src/features/accounting/category-icons.tsx',
  'apps/web/src/features/accounting/currency-catalog.json',
  'apps/api/src/modules/fitness/fitness-catalog.json',
  'packages/api-contract/fitness-catalog.json',
];
const root = resolve(import.meta.dirname, '../..');

/** 所有测试输入、输出和清理目标都限制在仓库根 Temp 的独立目录内。 */
async function withCatalogFixture(callback) {
  const tempRoot = resolve(root, 'Temp');
  let directory;
  try {
    await mkdir(tempRoot, { recursive: true });
    directory = await mkdtemp(resolve(tempRoot, 'catalog-sync-test-'));
    const mobile = resolve(directory, 'mobile');
    const outputRoot = resolve(directory, 'server');
    for (const [file, content] of Object.entries(sourceContents)) {
      const destination = resolve(mobile, file);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    for (const file of assetPaths) await mkdir(dirname(resolve(outputRoot, file)), { recursive: true });
    const input = resolve(directory, 'catalog.json');
    const data = validateCatalogInput({
      format: 'sesame-notes.shared-catalogs',
      version: 1,
      source: {
        repository: 'sesame-notes-mobile',
        revision: 'b'.repeat(40),
        files: Object.entries(sourceContents).map(([file, content]) => ({
          file,
          sha256: createHash('sha256').update(content).digest('hex'),
        })),
      },
      categories: buildCategoryCatalogs(categoryKeys, categorySeed, combinedArb, categoryIdentity).input,
      currencies: buildCurrencyCatalog(definitions, mappings, combinedArb),
      fitness: JSON.parse(sourceContents['assets/fitness/exercises.json']),
    });
    await writeFile(input, JSON.stringify(data));
    await callback({ directory, mobile, outputRoot, input, data });
  } catch (error) {
    throw new Error('目录同步夹具运行失败。', { cause: error });
  } finally {
    if (directory) {
      const actual = await realpath(directory);
      assert.ok(actual.startsWith((await realpath(tempRoot)) + sep));
      assert.equal((await lstat(directory)).isSymbolicLink(), false);
      await rm(actual, { recursive: true, force: true });
    }
  }
}

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
  assert.equal(catalog.currencies.length, 146);
  assert.equal(new Set(catalog.currencies.map((item) => item.code)).size, 146);
  assert.equal(catalog.commonCodes.length, 13);
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
  assert.match(catalog.icons, /bus: Bus/);
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

test('本仓输入支持单项生成、全量生成、重复运行与只读差异核对', async () => {
  await withCatalogFixture(async ({ input, outputRoot }) => {
    assert.deepEqual((await syncCatalogs({ input, outputRoot, check: true })).changed, assetPaths);
    const currencies = await syncCatalogs({ target: 'currencies', input, outputRoot });
    assert.deepEqual(currencies.files, [assetPaths[4]]);
    await assert.rejects(readFile(resolve(outputRoot, assetPaths[0])), { code: 'ENOENT' });
    assert.deepEqual(
      (await syncCatalogs({ input, outputRoot })).changed,
      assetPaths.filter((_, index) => index !== 4),
    );
    assert.deepEqual((await syncCatalogs({ input, outputRoot, check: true })).changed, []);
    const categoryPath = resolve(outputRoot, assetPaths[2]);
    const generated = await readFile(categoryPath, 'utf8');
    await writeFile(categoryPath, generated.replaceAll('\n', '\r\n'));
    assert.deepEqual((await syncCatalogs({ input, outputRoot, check: true })).changed, []);
    await writeFile(categoryPath, 'outdated');
    assert.deepEqual((await syncCatalogs({ input, outputRoot, check: true })).changed, [assetPaths[2]]);
    assert.equal(await readFile(categoryPath, 'utf8'), 'outdated');
  });
});

test('未知格式版本、来源版本和无效目录拒绝写入全部已有输出', async () => {
  await withCatalogFixture(async ({ input, data, outputRoot }) => {
    await syncCatalogs({ input, outputRoot });
    const before = await Promise.all(assetPaths.map((file) => readFile(resolve(outputRoot, file), 'utf8')));
    for (const invalidate of [
      (value) => {
        value.version = 2;
      },
      (value) => {
        value.source.revision = 'main';
      },
      (value) => {
        value.source.files[0].sha256 = 'invalid';
      },
      (value) => {
        value.categories.hybrid[0].seed_id = 'invalid';
      },
      (value) => {
        value.categories.hybrid[1].sort_order = 99;
      },
      (value) => {
        value.currencies.commonCodes.push('XXX');
      },
      (value) => {
        value.fitness.exercises.push(value.fitness.exercises[0]);
      },
      (value) => {
        value.fitness.source_commit = 'latest';
      },
    ]) {
      const invalid = structuredClone(data);
      invalidate(invalid);
      await writeFile(input, JSON.stringify(invalid));
      await assert.rejects(syncCatalogs({ input, outputRoot }), /无法生成共同目录/);
      assert.deepEqual(
        await Promise.all(assetPaths.map((file) => readFile(resolve(outputRoot, file), 'utf8'))),
        before,
      );
    }
    await writeFile(input, '{');
    await assert.rejects(syncCatalogs({ input, outputRoot }), /无法生成共同目录/);
    await assert.rejects(syncCatalogs({ input: `${input}.missing`, outputRoot }), /无法生成共同目录/);
  });
});

test('导入要求显式路径和完整SHA，读取固定Git对象且失败不改变快照', async () => {
  await withCatalogFixture(async ({ mobile, outputRoot }) => {
    const calls = [];
    const revision = 'b'.repeat(40);
    /** 模拟本地 Git 对象读取，确保工作区路径内容不参与导入。 */
    const readSource = async (source, args) => {
      assert.equal(source, mobile);
      calls.push(args);
      if (args[0] === 'rev-parse') return revision;
      assert.ok(args[1].startsWith(`${revision}:`));
      return sourceContents[args[1].slice(41)];
    };
    for (const options of [{}, { source: mobile }, { source: mobile, revision: 'main' }, { revision }]) {
      await assert.rejects(importCatalogs({ ...options, outputRoot, readSource }), /共同目录导入失败/);
    }
    assert.equal(calls.length, 0);
    await importCatalogs({ source: mobile, revision, outputRoot, readSource });
    assert.equal(calls.length, 8);
    const destination = resolve(outputRoot, 'data/catalogs/mobile-catalogs.v1.json');
    const before = await readFile(destination, 'utf8');
    assert.equal(JSON.parse(before).source.revision, revision);
    assert.deepEqual((await importCatalogs({ source: mobile, revision, outputRoot, readSource })).changed, []);
    await assert.rejects(
      importCatalogs({
        source: mobile,
        revision,
        outputRoot,
        readSource: async () => {
          throw new Error('missing git object');
        },
      }),
      /共同目录导入失败/,
    );
    await assert.rejects(
      importCatalogs({
        source: mobile,
        revision,
        outputRoot,
        readSource: async (source, args) =>
          args[0] === 'show' && args[1].endsWith('assets/fitness/exercises.json') ? '{}' : readSource(source, args),
      }),
      /共同目录导入失败/,
    );
    assert.equal(await readFile(destination, 'utf8'), before);
  });
});

test('真实 partial clone 缺对象时本地导入禁止隐式 fetch，完整来源可生成且失败不改输出', async () => {
  await withCatalogFixture(async ({ directory, mobile, outputRoot }) => {
    const execute = promisify(execFile);
    const emptyConfig = resolve(directory, 'empty.config');
    const emptyTemplate = resolve(directory, 'empty-template');
    await writeFile(emptyConfig, '');
    await mkdir(emptyTemplate);
    // 隔离机器级 Git 配置和继承的 Git 控制变量，所有传输只允许访问夹具中的 file 协议。
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_SYSTEM: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_TERMINAL_PROMPT: '0',
      // 刻意允许父进程按需抓取，验证生产代码必须主动覆盖该值。
      GIT_NO_LAZY_FETCH: '0',
    };
    /** 仅对独立夹具执行 Git；失败保留诊断，不能调用真实仓库或网络来源。 */
    async function git(args, overrides = {}) {
      try {
        return await execute('git', args, { cwd: directory, env: { ...env, ...overrides }, windowsHide: true });
      } catch (error) {
        throw new Error('本地 partial clone 夹具 Git 命令失败。', { cause: error });
      }
    }
    /** 缺失列表只检查对象是否存在，不允许在验证过程中补全夹具。 */
    async function missingObjects(source) {
      try {
        const { stdout } = await git(['-C', source, 'rev-list', '--objects', '--all', '--missing=print'], {
          GIT_NO_LAZY_FETCH: '1',
        });
        return stdout.split(/\r?\n/).filter((line) => line.startsWith('?'));
      } catch (error) {
        throw new Error('无法确认 partial clone 的缺失对象。', { cause: error });
      }
    }
    /** 读取真实 Git Trace2，统计按需抓取子进程，不依赖模拟的 Git 返回值。 */
    async function fetchCount(trace) {
      try {
        const events = (await readFile(trace, 'utf8'))
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        return events.filter((event) => event.event === 'cmd_name' && event.name === 'fetch').length;
      } catch (error) {
        throw new Error('无法读取 partial clone 的 Git Trace2 证据。', { cause: error });
      }
    }

    await git(['init', `--template=${emptyTemplate}`, mobile]);
    await git(['-C', mobile, 'add', '.']);
    await git([
      '-C',
      mobile,
      '-c',
      'user.name=Catalog Fixture',
      '-c',
      'user.email=catalog-fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'catalog fixture',
    ]);
    await git(['-C', mobile, 'config', 'uploadpack.allowFilter', 'true']);
    const revision = (await git(['-C', mobile, 'rev-parse', 'HEAD'])).stdout.trim();
    const control = resolve(directory, 'partial-control');
    const protectedSource = resolve(directory, 'partial-protected');
    for (const destination of [control, protectedSource]) {
      await git([
        'clone',
        `--template=${emptyTemplate}`,
        '--no-checkout',
        '--filter=blob:none',
        pathToFileURL(mobile).href,
        destination,
      ]);
      assert.equal(
        await git(['-C', destination, 'config', '--get', 'remote.origin.promisor']).then((result) =>
          result.stdout.trim(),
        ),
        'true',
      );
      assert.equal((await missingObjects(destination)).length, 7);
    }

    // 对照组确实会为七个目录文件逐一触发本地 fetch，证明夹具覆盖 Git 的真实按需抓取路径。
    const controlTrace = resolve(directory, 'control.trace.json');
    for (const file of Object.keys(sourceContents))
      await git(['-C', control, 'show', `${revision}:${file}`], { GIT_TRACE2_EVENT: controlTrace });
    assert.equal(await fetchCount(controlTrace), 7);
    assert.equal((await missingObjects(control)).length, 0);

    for (const file of [
      'package.json',
      'scripts/maintenance/sync-mobile-catalogs.mjs',
      'scripts/maintenance/import-mobile-catalogs.mjs',
      'scripts/maintenance/mobile-catalog-parser.mjs',
      'scripts/lib/catalog-data.mjs',
      'scripts/lib/catalog-output.mjs',
    ]) {
      await mkdir(dirname(resolve(outputRoot, file)), { recursive: true });
      await copyFile(resolve(root, file), resolve(outputRoot, file));
    }
    const syncScript = resolve(outputRoot, 'scripts/maintenance/sync-mobile-catalogs.mjs');
    const importScript = resolve(outputRoot, 'scripts/maintenance/import-mobile-catalogs.mjs');
    // 完整来源走相同的生产 CLI，先生成可用于失败保护检查的快照和七份消费者资产。
    await execute(process.execPath, [syncScript, '--source', mobile], { env });
    await execute(process.execPath, [importScript, '--source', mobile, '--revision', revision], { env });
    const outputs = ['data/catalogs/mobile-catalogs.v1.json', ...assetPaths];
    const before = await Promise.all(outputs.map((file) => readFile(resolve(outputRoot, file), 'utf8')));
    assert.equal(JSON.parse(before[0]).source.revision, revision);
    const protectedTrace = resolve(directory, 'protected.trace.json');
    for (const args of [
      [syncScript, '--source', protectedSource],
      [importScript, '--source', protectedSource, '--revision', revision],
    ]) {
      await writeFile(protectedTrace, '');
      await assert.rejects(
        execute(process.execPath, args, { env: { ...env, GIT_TRACE2_EVENT: protectedTrace } }),
        (error) => error.code === 1 && /禁止自动下载/.test(error.stderr) && /手动补齐/.test(error.stderr),
      );
      assert.equal(await fetchCount(protectedTrace), 0);
      assert.equal((await missingObjects(protectedSource)).length, 7);
      assert.deepEqual(await Promise.all(outputs.map((file) => readFile(resolve(outputRoot, file), 'utf8'))), before);
    }
  });
});

test('中途输出替换失败时恢复旧文件并清理首次生成文件', async () => {
  await withCatalogFixture(async ({ outputRoot }) => {
    await writeFile(resolve(outputRoot, 'existing.json'), 'original');
    const outputs = [
      { file: 'existing.json', content: 'changed' },
      { file: 'new.json', content: 'new' },
      { file: 'last.json', content: 'last' },
    ];
    let count = 0;
    /** 模拟替换阶段的磁盘故障，前两份输出必须恢复。 */
    const replace = async (source, target) => {
      if (++count === 3) throw new Error('simulated disk error');
      await rename(source, target);
    };
    await assert.rejects(writeCatalogOutputs(outputs, { outputRoot, replace }), /已恢复本次替换/);
    assert.equal(await readFile(resolve(outputRoot, 'existing.json'), 'utf8'), 'original');
    await assert.rejects(readFile(resolve(outputRoot, 'new.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(resolve(outputRoot, 'last.json')), { code: 'ENOENT' });
  });
});

test('一条命令更新本地HEAD，版本只解析一次且全部源文件读取固定提交', async () => {
  await withCatalogFixture(async ({ mobile, outputRoot }) => {
    const revision = 'c'.repeat(40);
    const calls = [];
    /** 模拟更新中的来源仓库，第二次解析 HEAD 将得到另一提交以捕获重复解析。 */
    const readSource = async (source, args) => {
      assert.equal(source, mobile);
      calls.push(args);
      if (args[0] === 'rev-parse') {
        assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD^{commit}']);
        return calls.length === 1 ? revision : 'd'.repeat(40);
      }
      assert.ok(args[1].startsWith(`${revision}:`));
      return sourceContents[args[1].slice(41)];
    };
    // 未提交工作区内容故意无效，成功生成必须仅依赖已提交 Git 对象。
    await writeFile(resolve(mobile, 'assets/fitness/exercises.json'), 'uncommitted invalid content');
    const result = await syncCatalogs({ source: mobile, outputRoot, readSource });
    assert.equal(result.sourceRevision, revision);
    assert.deepEqual(result.files, ['data/catalogs/mobile-catalogs.v1.json', ...assetPaths]);
    assert.equal(calls.filter((args) => args[0] === 'rev-parse').length, 1);
    assert.equal(calls.filter((args) => args[0] === 'show').length, 7);
    const data = JSON.parse(await readFile(resolve(outputRoot, result.files[0]), 'utf8'));
    assert.equal(data.source.revision, revision);
    assert.equal(data.fitness.exercises[0].id, '0025');
    assert.equal(
      await readFile(resolve(mobile, 'assets/fitness/exercises.json'), 'utf8'),
      'uncommitted invalid content',
    );
    calls.length = 0;
    assert.deepEqual((await syncCatalogs({ source: mobile, outputRoot, readSource })).changed, []);
  });
});

test('来源只读核对包含快照，指定完整版本可以复现且不写输出', async () => {
  await withCatalogFixture(async ({ mobile, outputRoot }) => {
    const revision = 'c'.repeat(40);
    /** 使用显式不可变对象，拒绝意外退回 HEAD。 */
    const readSource = async (_source, args) => {
      if (args[0] === 'rev-parse') {
        assert.deepEqual(args, ['rev-parse', '--verify', `${revision}^{commit}`]);
        return revision;
      }
      assert.ok(args[1].startsWith(`${revision}:`));
      return sourceContents[args[1].slice(41)];
    };
    const options = { source: mobile, revision, outputRoot, readSource };
    const result = await syncCatalogs({ ...options, check: true });
    assert.deepEqual(result.changed, ['data/catalogs/mobile-catalogs.v1.json', ...assetPaths]);
    for (const file of result.files) await assert.rejects(readFile(resolve(outputRoot, file)), { code: 'ENOENT' });
    await syncCatalogs(options);
    assert.deepEqual((await syncCatalogs({ ...options, check: true })).changed, []);
    const snapshot = resolve(outputRoot, result.files[0]);
    const current = await readFile(snapshot, 'utf8');
    const stale = current.replace(revision, 'd'.repeat(40));
    await writeFile(snapshot, stale);
    assert.deepEqual((await syncCatalogs({ ...options, check: true })).changed, [result.files[0]]);
    assert.equal(await readFile(snapshot, 'utf8'), stale);
  });
});

test('来源组合参数与无效版本拒绝读取，源对象缺失或结构无效不改变快照和资产', async () => {
  await withCatalogFixture(async ({ mobile, input, outputRoot }) => {
    let reads = 0;
    /** 返回有效提交和源内容，统计参数校验前是否触发读取。 */
    const readSource = async (_source, args) => {
      reads++;
      return args[0] === 'rev-parse' ? 'c'.repeat(40) : sourceContents[args[1].slice(41)];
    };
    for (const options of [
      { source: mobile, input },
      { source: mobile, target: 'categories' },
      { source: mobile, target: 'currencies' },
      { source: mobile, target: 'fitness' },
      { revision: 'c'.repeat(40) },
      { source: '' },
      { source: mobile, revision: 'main' },
      { source: mobile, revision: '' },
    ])
      await assert.rejects(syncCatalogs({ ...options, outputRoot, readSource }), /无法生成共同目录/);
    assert.equal(reads, 0);
    const result = await syncCatalogs({ source: mobile, outputRoot, readSource });
    const before = await Promise.all(result.files.map((file) => readFile(resolve(outputRoot, file), 'utf8')));
    for (const fault of ['invalid-head', 'missing-object', 'invalid-content', 'revision-mismatch']) {
      await assert.rejects(
        syncCatalogs({
          source: mobile,
          revision: fault === 'revision-mismatch' ? 'b'.repeat(40) : undefined,
          outputRoot,
          readSource: async (source, args) => {
            if (args[0] === 'rev-parse' && fault === 'invalid-head') return 'main';
            if (args[0] === 'show' && args[1].endsWith('assets/fitness/exercises.json')) {
              if (fault === 'missing-object') throw new Error('missing committed object');
              if (fault === 'invalid-content') return '{}';
            }
            return readSource(source, args);
          },
        }),
        /无法生成共同目录/,
      );
      assert.deepEqual(
        await Promise.all(result.files.map((file) => readFile(resolve(outputRoot, file), 'utf8'))),
        before,
      );
    }
  });
});

test('来源更新写入中断时共同快照和消费者资产一起恢复', async () => {
  await withCatalogFixture(async ({ mobile, outputRoot }) => {
    const files = ['data/catalogs/mobile-catalogs.v1.json', ...assetPaths];
    for (const file of files) {
      await mkdir(dirname(resolve(outputRoot, file)), { recursive: true });
      await writeFile(resolve(outputRoot, file), `original ${file}`);
    }
    let writes = 0;
    /** 在快照和第一份资产已替换后失败，验证二者都进入同一批回滚。 */
    const replace = async (source, destination) => {
      if (++writes === 3) throw new Error('simulated disk failure');
      await rename(source, destination);
    };
    await assert.rejects(
      syncCatalogs({
        source: mobile,
        outputRoot,
        replace,
        readSource: async (_source, args) =>
          args[0] === 'rev-parse' ? 'c'.repeat(40) : sourceContents[args[1].slice(41)],
      }),
      /无法生成共同目录/,
    );
    for (const file of files) assert.equal(await readFile(resolve(outputRoot, file), 'utf8'), `original ${file}`);
  });
});

test('隔离服务端目录没有兄弟客户端时仍能完整生成和核对，过期或输入失败退出非零', async () => {
  await withCatalogFixture(async ({ directory }) => {
    const standalone = resolve(directory, 'isolated/server');
    const files = [
      'package.json',
      'scripts/maintenance/sync-mobile-catalogs.mjs',
      'scripts/lib/catalog-data.mjs',
      'scripts/lib/catalog-output.mjs',
      'data/catalogs/mobile-catalogs.v1.json',
      'apps/api/scripts/generate-fitness-catalog.ts',
    ];
    for (const file of files) {
      await mkdir(dirname(resolve(standalone, file)), { recursive: true });
      await copyFile(resolve(root, file), resolve(standalone, file));
    }
    await assert.rejects(readFile(resolve(directory, 'isolated/sesame-notes-mobile')), { code: 'ENOENT' });
    const execute = promisify(execFile);
    const script = resolve(standalone, 'scripts/maintenance/sync-mobile-catalogs.mjs');
    await execute(process.execPath, [script], { cwd: directory });
    const result = await execute(process.execPath, [script, '--check'], { cwd: directory });
    assert.match(result.stdout, /7 份/);
    await execute(process.execPath, [resolve(standalone, 'apps/api/scripts/generate-fitness-catalog.ts'), '--check']);
    await writeFile(resolve(standalone, assetPaths[0]), 'stale');
    await assert.rejects(
      execute(process.execPath, [script, '--check']),
      (error) => error.code === 1 && /已过期/.test(error.stderr),
    );
    await assert.rejects(
      execute(process.execPath, [script, '--input', resolve(directory, 'missing.json')]),
      (error) => error.code === 1 && /详细日志/.test(error.stderr),
    );
  });
});
