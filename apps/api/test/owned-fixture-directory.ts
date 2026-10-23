import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const TEMP = resolve(import.meta.dirname, '../../../Temp');
const DEPENDENCIES = resolve(import.meta.dirname, '../node_modules');
const owned = new Map<string, { ino: number; dev: number; dependencyLink: boolean }>();

/** 从磁盘根依次检查祖先，不穿过符号链接；只允许尚不存在的末级 Temp。 */
async function inspectAncestors(target: string, allowMissing = false): Promise<void> {
  const paths: string[] = [];
  for (let path = target; ; path = dirname(path)) {
    paths.unshift(path);
    if (dirname(path) === path) break;
  }
  for (const path of paths) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('fixture 祖先必须是普通目录');
    } catch (error) {
      if (allowMissing && path === target && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

/** 只登记本进程刚刚以非递归方式创建的唯一目录，不认领已有同名内容。 */
export async function createOwnedFixture(prefix: string): Promise<string> {
  if (!/^[a-z][a-z-]+$/.test(prefix)) throw new Error('fixture 前缀仅允许小写字母和连字符');
  await inspectAncestors(TEMP, true);
  await mkdir(TEMP, { recursive: true });
  const target = join(TEMP, `${prefix}-${process.pid}-${randomUUID()}`);
  await mkdir(target);
  const stat = await lstat(target);
  owned.set(target, { ino: stat.ino, dev: stat.dev, dependencyLink: false });
  return target;
}

/** 临时迁移项目仅能链接固定的 API 依赖；清理时精确解除链接本体，不递归访问依赖。 */
export async function linkOwnedFixtureDependencies(target: string): Promise<void> {
  const ownership = owned.get(target);
  if (!ownership || ownership.dependencyLink) throw new Error('依赖链接仅允许本次创建的 fixture');
  await inspectAncestors(target);
  await symlink(DEPENDENCIES, join(target, 'node_modules'), 'junction');
  ownership.dependencyLink = true;
}

const WINDOWS_CLEANUP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Fixture cleanup requires Windows PowerShell 5.1.'
  }
  $temp = [IO.Path]::GetFullPath($env:SESAME_FIXTURE_TEMP)
  $target = [IO.Path]::GetFullPath($env:SESAME_FIXTURE_PATH)
  if (-not [IO.Path]::IsPathRooted($target) -or
      -not [string]::Equals($target, $env:SESAME_FIXTURE_PATH, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([IO.Path]::GetDirectoryName($target), $temp, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($target) -cnotmatch '^[a-z][a-z-]+-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'Fixture path is outside the exact owned directory.'
  }
  $ancestors = New-Object 'System.Collections.Generic.List[string]'
  for ($current = $target; $current; $current = [IO.Path]::GetDirectoryName($current)) { $ancestors.Insert(0, $current) }
  foreach ($path in $ancestors) {
    $entry = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::Equals($entry.FullName, $path, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Fixture cleanup refuses linked or unresolved ancestors.'
    }
  }
  $dependencyLink = [IO.Path]::Combine($target, 'node_modules')
  $dependencyTarget = [IO.Path]::GetFullPath($env:SESAME_FIXTURE_DEPENDENCIES)
  $expectedLink = $env:SESAME_FIXTURE_HAS_DEPENDENCY_LINK -ceq 'true'
  $seenLink = $false
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($target)
  while ($pending.Count -gt 0) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
      $child = [IO.Path]::GetFullPath($entry.FullName)
      if (-not $child.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Fixture descendant escaped its owned directory.'
      }
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        if (-not $expectedLink -or -not [string]::Equals($child, $dependencyLink, [StringComparison]::OrdinalIgnoreCase) -or
            $entry.LinkType -ne 'Junction' -or @($entry.Target).Count -ne 1 -or
            -not [string]::Equals([IO.Path]::GetFullPath([string]$entry.Target), $dependencyTarget, [StringComparison]::OrdinalIgnoreCase)) {
          throw 'Fixture cleanup refuses unregistered reparse points.'
        }
        $seenLink = $true
        continue
      }
      if ($entry.PSIsContainer) { $pending.Push($child) }
    }
  }
  if ($seenLink -ne $expectedLink) { throw 'Fixture dependency link identity changed.' }
  if ($seenLink) {
    # 单参数 Directory.Delete 只解除已校验的 junction 本体，不递归其目标；仍在固定 PS5.1 内执行。
    [IO.Directory]::Delete($dependencyLink)
  }
  Write-Output ('[owned-fixture] PowerShell ' + $PSVersionTable.PSVersion + '; remove: ' + $target)
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

/** 只构造绝对且已归一化的系统 PS5.1 路径，缺少环境变量时仍不能退回驱动器相对路径。 */
export function fixturePowerShellPath(systemRoot: string | undefined): string {
  const root = systemRoot ?? 'C:\\Windows';
  if (!win32.isAbsolute(root) || !/^[a-z]:\\/i.test(root) || win32.normalize(root) !== root) {
    throw new Error('PowerShell 系统目录必须是已归一化的绝对磁盘路径');
  }
  const powershell = win32.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!win32.isAbsolute(powershell)) throw new Error('PowerShell 入口必须是绝对路径');
  return powershell;
}

/** 仅清理本次真实创建且身份未变化的 fixture；Windows 文件删除统一由固定 PS5.1 执行。 */
export async function removeOwnedFixture(target: string): Promise<void> {
  const ownership = owned.get(target);
  if (!ownership || resolve(target) !== target || relative(TEMP, target) !== basename(target)) {
    throw new Error('只允许清理本进程真实创建的 fixture');
  }
  await inspectAncestors(target);
  const root = await lstat(target);
  if (root.ino !== ownership.ino || root.dev !== ownership.dev) throw new Error('fixture 目录身份已变化');
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of await readdir(directory)) {
      const child = join(directory, name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        if (
          !ownership.dependencyLink ||
          child !== join(target, 'node_modules') ||
          resolve(await readlink(child)) !== DEPENDENCIES
        ) {
          throw new Error('fixture 子树存在未登记的链接');
        }
      } else if (stat.isDirectory()) pending.push(child);
      else if (!stat.isFile()) throw new Error('fixture 子树只允许普通目录、文件和精确登记的依赖链接');
    }
  }
  if (process.platform === 'win32') {
    const powershell = fixturePowerShellPath(process.env.SystemRoot);
    const result = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CLEANUP], {
      env: {
        ...process.env,
        SESAME_FIXTURE_TEMP: TEMP,
        SESAME_FIXTURE_PATH: target,
        SESAME_FIXTURE_DEPENDENCIES: DEPENDENCIES,
        SESAME_FIXTURE_HAS_DEPENDENCY_LINK: String(ownership.dependencyLink),
      },
      encoding: 'utf8',
    });
    process.stdout.write(result.stdout);
  } else {
    await rm(target, { recursive: true, force: true });
  }
  owned.delete(target);
}
