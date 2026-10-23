import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const COMPONENTS = new Set(['api', 'web', 'admin']);
const INCREMENTS = new Set(['patch', 'minor', 'major']);
const HELP = `用法：node scripts/build-tools/bump-version.mjs <api|web|admin> [patch|minor|major] [--dry-run]

只递增指定端 package.json 的版本号，默认递增 patch。
  patch      1.2.3 -> 1.2.4
  minor      1.2.3 -> 1.3.0
  major      1.2.3 -> 2.0.0
  --dry-run  预览新版本，不写入任何文件
  --help     显示帮助

本脚本不读取 Git 历史，不提交代码，也不执行构建或部署。`;

/** 检查固定路径的类型并拒绝符号链接，防止清单写入经过 junction 跳出仓库。 */
async function inspectPath(path, type, optional = false) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`路径不能是符号链接或 junction：${path}`);
    if (type === 'directory' ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`路径必须是${type === 'directory' ? '目录' : '普通文件'}：${path}`);
    }
    return info;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw new Error(`无法安全访问路径：${path}；${error.message}`, { cause: error });
  }
}

/** 校验仓库与清单路径；返回原文件属性用于保留写入后的文件权限。 */
async function inspectPackage(root, component) {
  try {
    await inspectPath(root, 'directory');
    await inspectPath(join(root, 'apps'), 'directory');
    await inspectPath(join(root, 'apps', component), 'directory');
    await inspectPath(join(root, 'Temp'), 'directory', true);
    return await inspectPath(join(root, 'apps', component, 'package.json'), 'file');
  } catch (error) {
    throw new Error(`版本清单路径校验失败：${error.message}`, { cause: error });
  }
}

/** 只在已校验的仓库根目录中创建 Temp；再次检查以拒绝并发创建的目录链接。 */
async function ensureTemp(root) {
  try {
    await inspectPath(root, 'directory');
    const temporary = join(root, 'Temp');
    if (!(await inspectPath(temporary, 'directory', true))) {
      try {
        await mkdir(temporary);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    await inspectPath(temporary, 'directory');
    return temporary;
  } catch (error) {
    throw new Error(`无法准备版本操作的 Temp 目录：${error.message}`, { cause: error });
  }
}

/** 跳过合法 JSON 字符串中的转义字符，返回结束引号后的位置。 */
function stringEnd(source, start) {
  for (let position = start + 1; position < source.length; position += 1) {
    if (source[position] === '\\') position += 1;
    else if (source[position] === '"') return position + 1;
  }
  throw new Error('版本清单中存在未闭合的字符串。');
}

/** 定位唯一的顶层 version 字符串，仅替换其值，保留缩进、换行和嵌套元数据。 */
function locateVersion(source) {
  try {
    let depth = 0;
    const locations = [];
    for (let position = 0; position < source.length; position += 1) {
      const character = source[position];
      if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth -= 1;
      else if (character === '"') {
        const end = stringEnd(source, position);
        if (depth === 1 && JSON.parse(source.slice(position, end)) === 'version') {
          let valueStart = end;
          while (/\s/.test(source[valueStart] ?? '') && valueStart < source.length) valueStart += 1;
          // 冒号用于区分属性名与碰巧等于 version 的普通字符串值。
          if (source[valueStart] === ':') {
            valueStart += 1;
            while (/\s/.test(source[valueStart] ?? '') && valueStart < source.length) valueStart += 1;
            locations.push({ start: valueStart, end: stringEnd(source, valueStart) });
          }
        }
        position = end - 1;
      }
    }
    if (locations.length !== 1) throw new Error('package.json 必须且只能包含一个顶层 version 字段。');
    return locations[0];
  } catch (error) {
    throw new Error(`无法定位版本字段：${error.message}`, { cause: error });
  }
}

/** 使用整数运算递增正式版本，避免大数字转换为浮点数后丢失精度。 */
function nextVersion(version, increment) {
  try {
    if (
      typeof version !== 'string' ||
      version.length > 64 ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)
    ) {
      throw new Error('version 必须是长度不超过 64 的正式版本 x.y.z，不能包含前导零、预发布或构建后缀。');
    }
    const parts = version.split('.').map((part) => BigInt(part));
    const index = { major: 0, minor: 1, patch: 2 }[increment];
    parts[index] += 1n;
    for (let trailing = index + 1; trailing < parts.length; trailing += 1) parts[trailing] = 0n;
    const next = parts.join('.');
    if (next.length > 64) throw new Error('递增后的版本超过 64 个字符，请检查版本号。');
    return next;
  } catch (error) {
    throw new Error(`无法计算新版本：${error.message}`, { cause: error });
  }
}

/** 关闭句柄并删除本次成功创建的临时文件；清理失败会作为正式错误返回。 */
async function cleanup(handle, path, errors) {
  try {
    if (handle) await handle.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    if (path) await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(error);
  }
}

/** 为指定端准备新版本；只改其清单，不依赖 Git、网络、构建或部署环境。 */
export async function bumpVersion(component, increment = 'patch', { root = ROOT, dryRun = false } = {}) {
  let lockHandle;
  let lockPath;
  let outputHandle;
  let outputPath;
  let result;
  const errors = [];
  try {
    if (!COMPONENTS.has(component)) throw new Error('发布端只能是 api、web 或 admin。');
    if (!INCREMENTS.has(increment)) throw new Error('递增方式只能是 patch、minor 或 major。');
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('仓库根目录必须是绝对路径。');
    if (typeof dryRun !== 'boolean') throw new Error('dryRun 必须是布尔值。');
    root = resolve(root);
    const info = await inspectPackage(root, component);
    const packagePath = join(root, 'apps', component, 'package.json');
    let temporary;
    if (!dryRun) {
      temporary = await ensureTemp(root);
      const candidate = join(temporary, `bump-version-${component}.lock`);
      try {
        lockHandle = await open(candidate, 'wx', 0o600);
        lockPath = candidate;
        await lockHandle.writeFile(
          `pid=${process.pid}\ncomponent=${component}\ncreatedAt=${new Date().toISOString()}\n`,
        );
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error(
            `该端版本准备已被锁定。请确认没有正在执行的操作；若上次被强制中断，可删除 ${candidate} 后重试。`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    const source = await readFile(packagePath, 'utf8');
    const manifest = JSON.parse(source.replace(/^\uFEFF/, ''));
    if (!manifest || Array.isArray(manifest) || manifest.name !== `@sesame-notes/${component}`) {
      throw new Error(`包名必须是 @sesame-notes/${component}，请检查指定端的 package.json。`);
    }
    const version = nextVersion(manifest.version, increment);
    const location = locateVersion(source);
    result = { component, previousVersion: manifest.version, version, dryRun };
    if (!dryRun) {
      // 独占锁仅保护当前端；其他端可以独立准备各自版本。
      const candidate = join(temporary, `bump-version-${component}-${randomUUID()}.tmp`);
      outputHandle = await open(candidate, 'wx', info.mode & 0o777);
      outputPath = candidate;
      await outputHandle.writeFile(
        source.slice(0, location.start) + JSON.stringify(version) + source.slice(location.end),
      );
      await outputHandle.sync();
      await outputHandle.close();
      outputHandle = undefined;
      // 完整写入临时文件后再次核对原始清单，避免覆盖准备期间产生的外部修改。
      await inspectPackage(root, component);
      if ((await readFile(packagePath, 'utf8')) !== source) throw new Error('版本清单已被其他操作修改，请检查后重试。');
      await rename(outputPath, packagePath);
      outputPath = undefined;
    }
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup(outputHandle, outputPath, errors);
    await cleanup(lockHandle, lockPath, errors);
  }
  if (errors.length) {
    const cause = errors.length === 1 ? errors[0] : new AggregateError(errors, '版本操作及清理过程中发生错误。');
    throw new Error(`准备版本失败：${errors.map((error) => error.message).join('；')}`, { cause });
  }
  return result;
}

/** 将完整错误链与堆栈保存到根目录 Temp，控制台只显示简短错误和日志位置。 */
async function writeErrorLog(error) {
  let handle;
  try {
    const temporary = await ensureTemp(ROOT);
    const path = join(temporary, `bump-version-error-${Date.now()}-${randomUUID()}.log`);
    const details = [`时间：${new Date().toISOString()}`, `参数：${JSON.stringify(process.argv.slice(2))}`];
    const pending = [error];
    const visited = new Set();
    while (pending.length) {
      const current = pending.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      details.push(current.stack ?? String(current));
      // 系统异常的 code、路径与权限资源不一定出现在 stack 中，需要单独记录。
      for (const key of ['code', 'syscall', 'path', 'dest', 'permission', 'resource']) {
        if (current[key] !== undefined) details.push(`${key}: ${String(current[key])}`);
      }
      if (current.cause) pending.push(current.cause);
      if (current instanceof AggregateError) pending.push(...current.errors);
    }
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${details.join('\n\n')}\n`);
    return path;
  } catch (logError) {
    throw new Error(`详细日志写入失败：${logError.message}`, { cause: logError });
  } finally {
    try {
      if (handle) await handle.close();
    } catch (closeError) {
      console.error(`错误日志关闭失败：${closeError.message}`);
    }
  }
}

/** 解析独立 CLI 参数并展示操作结果，失败时记录完整诊断并设置非零退出码。 */
async function main(args) {
  try {
    if (args.length === 1 && args[0] === '--help') {
      console.log(HELP);
      return;
    }
    let dryRun = false;
    const positional = [];
    for (const argument of args) {
      if (argument === '--dry-run' && !dryRun) dryRun = true;
      else if (argument.startsWith('-')) throw new Error(`未知或重复选项：${argument}。使用 --help 查看用法。`);
      else positional.push(argument);
    }
    if (positional.length < 1 || positional.length > 2)
      throw new Error('请指定一个发布端和可选递增方式。使用 --help 查看用法。');
    const result = await bumpVersion(positional[0], positional[1], { dryRun });
    console.log(
      `${dryRun ? '预览' : '已更新'} ${result.component}：v${result.previousVersion} -> v${result.version}${dryRun ? '（未写入文件）' : ''}`,
    );
  } catch (error) {
    console.error(error.message);
    try {
      console.error(`详细错误日志：${await writeErrorLog(error)}`);
    } catch (logError) {
      console.error(logError.message);
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
