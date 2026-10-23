import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { inspect } from 'node:util';
import { catalogRoot } from './catalog-data.mjs';

/** 读取可选目标，只有不存在才视为首次生成，权限等错误必须保留。 */
async function readOptional(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** 只清理根 Temp 内的真实暂存目录，拒绝符号链接及越界路径。 */
async function cleanStaging(staging) {
  try {
    const tempRoot = await realpath(resolve(catalogRoot, 'Temp'));
    const actual = await realpath(staging);
    if (
      !tempRoot.startsWith((await realpath(catalogRoot)) + sep) ||
      dirname(actual) !== tempRoot ||
      (await lstat(staging)).isSymbolicLink()
    )
      throw new Error('暂存清理路径不安全。');
    await rm(actual, { recursive: true, force: true });
  } catch (error) {
    await reportCatalogError(new Error(`目录暂存清理失败，请检查并清理 ${staging}。`, { cause: error }));
  }
}

/** 暂存全部内容再替换输出；可捕获的写入失败恢复全部已替换文件。 */
export async function writeCatalogOutputs(outputs, { outputRoot = catalogRoot, check = false, replace = rename } = {}) {
  let staging;
  const committed = [];
  let preserveRecovery = false;
  try {
    const changed = [];
    for (const output of outputs) {
      const destination = resolve(outputRoot, output.file);
      if (!destination.startsWith(resolve(outputRoot) + sep)) throw new Error('目录输出必须位于指定仓库内。');
      const previous = await readOptional(destination);
      if (previous?.toString('utf8').replaceAll('\r\n', '\n') !== output.content.replaceAll('\r\n', '\n'))
        changed.push({ ...output, destination, previous });
    }
    if (!check && changed.length) {
      await mkdir(resolve(catalogRoot, 'Temp'), { recursive: true });
      staging = await mkdtemp(resolve(catalogRoot, 'Temp/catalog-write-'));
      // 所有暂存和备份完成后才触碰输出文件，格式化失败不会留下部分资产。
      for (const [index, output] of changed.entries()) {
        await mkdir(dirname(output.destination), { recursive: true });
        output.staged = resolve(staging, `${index}.new`);
        output.backup = resolve(staging, `${index}.old`);
        await writeFile(output.staged, output.content);
        if (output.previous !== undefined) await writeFile(output.backup, output.previous);
      }
      for (const output of changed) {
        const current = await readOptional(output.destination);
        if (output.previous === undefined ? current !== undefined : !current?.equals(output.previous))
          throw new Error('输出在生成期间发生变化，请重新运行。');
        await replace(output.staged, output.destination);
        committed.push(output);
      }
    }
    return { changed: changed.map((output) => output.file), files: outputs.map((output) => output.file) };
  } catch (error) {
    const failures = [];
    for (const output of committed.reverse()) {
      try {
        if (output.previous === undefined) await unlink(output.destination);
        else await rename(output.backup, output.destination);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length) {
      preserveRecovery = true;
      throw new AggregateError([error, ...failures], `目录写入与恢复失败，请保留并检查备份：${staging}`);
    }
    throw new Error('目录写入失败，已恢复本次替换；请检查磁盘空间及文件权限后重试。', { cause: error });
  } finally {
    if (staging && !preserveRecovery) await cleanStaging(staging);
  }
}

/** 错误详情仅写根 Temp，命令行保留简明原因与可追踪日志位置。 */
export async function reportCatalogError(error) {
  process.exitCode = 1;
  try {
    await mkdir(resolve(catalogRoot, 'Temp'), { recursive: true });
    const log = resolve(catalogRoot, 'Temp', `catalog-error-${randomUUID()}.log`);
    const details = inspect(error, { depth: null })
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已脱敏]@')
      .replace(/((?:password|passwd|token|secret|authorization|connection_string)\s*[:=]\s*)[^\s,;]+/gi, '$1[已脱敏]');
    await writeFile(log, `${new Date().toISOString()}\n${details}\n`);
    const reasons = [];
    for (let current = error; current; current = current.cause) reasons.push(current.message);
    const summary = reasons
      .join(' ')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已脱敏]@')
      .replace(/((?:password|passwd|token|secret|authorization|connection_string)\s*[:=]\s*)[^\s,;]+/gi, '$1[已脱敏]');
    console.error(`目录操作失败：${summary}\n请使用 --help 核对参数；详细日志：${log}`);
  } catch {
    console.error('目录操作失败，详细日志无法写入；请检查仓库根 Temp 权限后重试。');
  }
}
