import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { buildCategoryAssets, catalogRoot, readCatalogInput } from '../lib/catalog-data.mjs';
import { reportCatalogError, writeCatalogOutputs } from '../lib/catalog-output.mjs';

/** 使用本仓输入或显式客户端来源生成资产，来源快照与全部资产校验后统一写入。 */
export async function syncCatalogs({
  target = 'all',
  input,
  source,
  revision,
  check = false,
  outputRoot = catalogRoot,
  readSource,
  replace,
} = {}) {
  try {
    if (!['all', 'categories', 'currencies', 'fitness'].includes(target))
      throw new Error('未知目录目标，请使用 --help 查看用法。');
    if (source !== undefined && (input !== undefined || target !== 'all'))
      throw new Error('--source 必须同步全部目录，不能与 --input 或单项目标同时使用。');
    if (source === undefined && revision !== undefined) throw new Error('--revision 需要同时提供 --source。');
    // 普通生成只加载本仓输入；显式跨仓更新才加载客户端解析器。
    const data =
      source === undefined
        ? await readCatalogInput(input)
        : await (await import('./import-mobile-catalogs.mjs')).readSourceCatalogs({ source, revision, readSource });
    const assets = [];
    if (target === 'all' || target === 'categories') {
      const catalog = buildCategoryAssets(data.categories);
      assets.push(
        ['apps/api/src/modules/accounting/official-category-identities.json', catalog.identities],
        ['apps/api/src/modules/accounting/default-category-catalog.json', catalog.defaults],
        ['apps/web/src/features/accounting/category-catalog.json', catalog.templates],
        ['apps/web/src/features/accounting/category-icons.tsx', catalog.icons],
      );
    }
    if (target === 'all' || target === 'currencies')
      assets.push(['apps/web/src/features/accounting/currency-catalog.json', data.currencies]);
    if (target === 'all' || target === 'fitness')
      assets.push(
        ['apps/api/src/modules/fitness/fitness-catalog.json', data.fitness],
        ['packages/api-contract/fitness-catalog.json', data.fitness],
      );
    const config = await resolveConfig(resolve(catalogRoot, 'package.json'));
    const outputs = await Promise.all(
      assets.map(async ([file, value]) => ({
        file,
        // 健身投影与公开契约保持既有两空格 JSON 格式。
        content: file.endsWith('/fitness-catalog.json')
          ? `${JSON.stringify(value, null, 2)}\n`
          : await format(typeof value === 'string' ? value : JSON.stringify(value), {
              ...config,
              filepath: resolve(catalogRoot, file),
            }),
      })),
    );
    if (source !== undefined)
      outputs.unshift({ file: 'data/catalogs/mobile-catalogs.v2.json', content: `${JSON.stringify(data, null, 2)}\n` });
    // 快照与消费者资产使用同一批暂存和恢复机制，避免只更新来源记录而留下旧资产。
    const result = await writeCatalogOutputs(outputs, { outputRoot, check, replace });
    return { ...result, sourceRevision: source === undefined ? undefined : data.source.revision };
  } catch (error) {
    throw new Error('无法生成共同目录，请检查输入、显式来源与输出权限。', { cause: error });
  }
}

/** 解析维护参数，显式来源默认更新到本地最新提交并自动记录固定版本。 */
export async function main(args = process.argv.slice(2)) {
  try {
    if (args.includes('--help')) {
      console.log(
        '用法：node scripts/maintenance/sync-mobile-catalogs.mjs [all|categories|currencies|fitness] [--check] [--input <共同目录JSON>]\n更新来源：pnpm sync:catalogs --source <本地客户端路径> [--revision <40位commit SHA>] [--check]\n默认只读取本仓 data/catalogs/mobile-catalogs.v2.json；指定 --source 时一次更新来源快照及全部资产。省略 --revision 使用本地 HEAD，不联网、不读取未提交内容；不能与 --input 或单项目标组合。',
      );
      return;
    }
    let target = 'all';
    const options = {};
    let check = false;
    let hasTarget = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--check' && !check) check = true;
      else if (
        ['--input', '--source', '--revision'].includes(arg) &&
        options[arg.slice(2)] === undefined &&
        args[index + 1] &&
        !args[index + 1].startsWith('--')
      )
        options[arg.slice(2)] = arg === '--revision' ? args[++index] : resolve(args[++index]);
      else if (!arg.startsWith('--') && !hasTarget) {
        target = arg;
        hasTarget = true;
      } else throw new Error('命令参数无效，请使用 --help 查看用法。');
    }
    const result = await syncCatalogs({ target, ...options, check });
    if (result.sourceRevision) console.log(`来源已固定为本地提交 ${result.sourceRevision}，未读取未提交内容。`);
    if (check && result.changed.length) {
      console.error(`目录输入或资产已过期，请使用相同来源参数运行生成命令后审查差异：\n${result.changed.join('\n')}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `已${check ? '核对' : '生成'} ${result.files.length} 份本仓目录资产，${result.changed.length} 份更新。`,
    );
  } catch (error) {
    await reportCatalogError(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
