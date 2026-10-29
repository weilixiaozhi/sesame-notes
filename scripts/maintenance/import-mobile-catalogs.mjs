import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { catalogRoot, validateCatalogInput, validateFitnessCatalog } from '../lib/catalog-data.mjs';
import { reportCatalogError, writeCatalogOutputs } from '../lib/catalog-output.mjs';
import { buildCategoryCatalogs, buildCurrencyCatalog, sourceFiles } from './mobile-catalog-parser.mjs';

const execute = promisify(execFile);

/** 从明确路径中的已提交 Git 对象读取，忽略工作区未提交内容且绝不自动拉取。 */
async function readGit(source, args) {
  try {
    const { stdout } = await execute('git', ['-C', source, ...args], {
      // partial clone 的文件读取也可能触发隐式 fetch，所有 Git 子进程必须只使用已下载对象。
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    // 不记录 Git stderr，避免本地配置或诊断包含认证信息。
    throw new Error(
      `无法读取本地来源 Git 对象（git ${args[0]}，${error.code ?? '未知错误'}），请确认 Git 可用、来源路径正确且指定提交已在本地。导入禁止自动下载；若为 partial clone 或缺少文件对象，请在来源仓库手动补齐所选提交的目录文件，或改用完整本地克隆后重试。`,
    );
  }
}

/** 将明确来源的本地 HEAD 或指定提交固定为完整 SHA，再读取同一版本的全部目录。 */
export async function readSourceCatalogs({ source, revision, readSource = readGit } = {}) {
  try {
    if (!source) throw new Error('必须提供 --source 本地客户端仓库路径。');
    if (revision !== undefined && !/^[0-9a-f]{40}$/.test(revision))
      throw new Error('--revision 必须是完整的 40 位 commit SHA。');
    const directory = resolve(source);
    // HEAD 只解析一次，后续即使来源仓库切换提交，也不会把不同版本的数据混在一起。
    const actualRevision = (
      await readSource(directory, ['rev-parse', '--verify', `${revision ?? 'HEAD'}^{commit}`])
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(actualRevision) || (revision !== undefined && actualRevision !== revision))
      throw new Error('无法确认来源的完整 commit SHA，请检查本地仓库与指定提交。');
    const files = [...new Set([...sourceFiles.categories, ...sourceFiles.currencies, 'assets/fitness/exercises.json'])];
    const contents = new Map();
    for (const file of files) contents.set(file, await readSource(directory, ['show', `${actualRevision}:${file}`]));
    const categories = buildCategoryCatalogs(...sourceFiles.categories.map((file) => contents.get(file))).input;
    const currencies = buildCurrencyCatalog(...sourceFiles.currencies.map((file) => contents.get(file)));
    const fitnessSource = validateFitnessCatalog(JSON.parse(contents.get('assets/fitness/exercises.json')));
    return validateCatalogInput({
      format: 'sesame-notes.shared-catalogs',
      version: 2,
      source: {
        repository: 'sesame-notes-mobile',
        revision: actualRevision,
        files: files.map((file) => ({ file, sha256: createHash('sha256').update(contents.get(file)).digest('hex') })),
      },
      categories,
      currencies,
      fitness: {
        source: fitnessSource.source,
        source_commit: fitnessSource.source_commit,
        exercises: fitnessSource.exercises.map(({ id, body_part }) => ({ id, body_part })),
      },
    });
  } catch (error) {
    throw new Error('共同目录来源读取失败，请检查客户端本地提交与数据格式。', { cause: error });
  }
}

/** 仅导入指定不可变版本；全部解析通过后一次替换共同输入，不写消费者资产。 */
export async function importCatalogs({ source, revision, outputRoot = catalogRoot, readSource = readGit } = {}) {
  try {
    if (!revision) throw new Error('独立导入必须提供 --revision 完整的 40 位 commit SHA。');
    const data = await readSourceCatalogs({ source, revision, readSource });
    return await writeCatalogOutputs(
      [{ file: 'data/catalogs/mobile-catalogs.v2.json', content: `${JSON.stringify(data, null, 2)}\n` }],
      { outputRoot },
    );
  } catch (error) {
    throw new Error('共同目录导入失败，请核对来源与提交后重试。', { cause: error });
  }
}

/** 要求显式来源与固定版本，成功后提示维护者生成并审查全部资产。 */
async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log(
        '用法：node scripts/maintenance/import-mobile-catalogs.mjs --source <客户端仓库路径> --revision <40位commit SHA>\n仅读取本地已提交对象；成功后运行 pnpm sync:catalogs，并审查输入与全部资产差异。',
      );
      return;
    }
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      if (
        !['--source', '--revision'].includes(key) ||
        options[key.slice(2)] ||
        !args[index + 1] ||
        args[index + 1].startsWith('--')
      )
        throw new Error('导入参数无效，请使用 --help 查看用法。');
      options[key.slice(2)] = args[index + 1];
    }
    const result = await importCatalogs(options);
    console.log(`已导入固定版本共同输入，${result.changed.length} 份更新。请运行 pnpm sync:catalogs 并审查差异。`);
  } catch (error) {
    await reportCatalogError(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
