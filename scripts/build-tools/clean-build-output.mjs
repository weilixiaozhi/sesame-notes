import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, relative, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
export const BUILD_OUTPUTS = Object.freeze(['apps/api/dist', 'packages/api-client/dist', 'apps/web/dist']);

/** 只接受三个正式构建目录的原始白名单名称，不接受绝对路径、别名或路径归一化绕行。 */
export function resolveBuildOutput(requested) {
  if (!BUILD_OUTPUTS.includes(requested)) throw new Error('只允许清理三个正式应用的固定 dist 目录');
  const target = resolve(ROOT, requested);
  if (relative(ROOT, target).replaceAll('\\', '/') !== requested) throw new Error('构建目录必须位于当前仓库白名单内');
  return target;
}

/** 缺少目标是干净构建的正常状态；其他读取错误必须中止，不能当成目录不存在。 */
function readEntry(io, target) {
  try {
    return io.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** 删除前拒绝祖先和输出子树中的符号链接；Windows 另在 PS5.1 核验所有重解析点。 */
function inspectOutput(io, target) {
  const ancestors = [];
  for (let current = target; ; current = dirname(current)) {
    ancestors.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const ancestor of ancestors) {
    const entry = readEntry(io, ancestor);
    if (!entry) {
      if (ancestor === target) return false;
      throw new Error('构建输出的父目录不存在');
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('构建输出及其祖先必须是普通目录');
  }
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of io.readdirSync(directory)) {
      const child = join(directory, name);
      const rel = relative(target, child);
      if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('构建输出子项越界');
      const entry = io.lstatSync(child);
      if (entry.isSymbolicLink()) throw new Error('构建输出子树不得包含符号链接');
      if (entry.isDirectory()) pending.push(child);
      else if (!entry.isFile()) throw new Error('构建输出子树只能包含普通文件和目录');
    }
  }
  return true;
}

const WINDOWS_CLEANUP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Build cleanup requires Windows PowerShell 5.1.'
  }
  $allowed = @('apps/api/dist', 'packages/api-client/dist', 'apps/web/dist')
  $requested = $env:SESAME_BUILD_OUTPUT
  if (-not ($allowed -ccontains $requested)) { throw 'Build output is not allowlisted.' }
  $workspace = [IO.Path]::GetFullPath($env:SESAME_BUILD_ROOT)
  if (-not [IO.Path]::IsPathRooted($workspace) -or
      -not [string]::Equals($workspace, $env:SESAME_BUILD_ROOT, [StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($workspace, [IO.Path]::GetPathRoot($workspace), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build workspace must be a resolved absolute non-root directory.'
  }
  $target = [IO.Path]::GetFullPath([IO.Path]::Combine($workspace, $requested.Replace('/', '\')))
  if (-not $target.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Build output escapes the workspace.'
  }
  $ancestors = New-Object 'System.Collections.Generic.List[string]'
  for ($current = $target; $current; $current = [IO.Path]::GetDirectoryName($current)) {
    $ancestors.Insert(0, $current)
  }
  # 先从磁盘根依次检查祖先，再检查子树；不穿过任何 junction 或其他重解析点。
  foreach ($path in $ancestors) {
    if ($path -eq $target -and -not (Test-Path -LiteralPath $path)) {
      Write-Output ('[clean-build-output] PowerShell ' + $PSVersionTable.PSVersion + '; absent: ' + $target)
      exit 0
    }
    $entry = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $entry.PSIsContainer -or
        ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::Equals($entry.FullName, $path, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Build cleanup refuses linked or unresolved ancestors.'
    }
  }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($target)
  while ($pending.Count -gt 0) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
      $child = [IO.Path]::GetFullPath($entry.FullName)
      if (-not $child.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
          ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Build cleanup refuses linked or escaped descendants.'
      }
      if ($entry.PSIsContainer) { $pending.Push($child) }
    }
  }
  Write-Output ('[clean-build-output] PowerShell ' + $PSVersionTable.PSVersion + '; remove: ' + $target)
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

/** 正式构建共用一次清理；测试可替换 I/O 与进程执行器，但不能改变白名单或仓库根。 */
export function cleanBuildOutput(requested, { platform = process.platform, io = fs, run = execFileSync } = {}) {
  const target = resolveBuildOutput(requested);
  const present = inspectOutput(io, target);
  if (platform === 'win32') {
    const powershell = win32.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    if (!win32.isAbsolute(powershell)) throw new Error('PowerShell 入口必须是绝对路径');
    run(powershell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CLEANUP], {
      env: { ...process.env, SESAME_BUILD_ROOT: ROOT, SESAME_BUILD_OUTPUT: requested },
      stdio: 'inherit',
    });
  } else if (present) {
    io.rmSync(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3)
      throw new Error('用法：node scripts/build-tools/clean-build-output.mjs <固定 dist 名称>');
    cleanBuildOutput(process.argv[2]);
  } catch (error) {
    console.error('构建输出清理失败：', error.message);
    process.exitCode = 1;
  }
}
