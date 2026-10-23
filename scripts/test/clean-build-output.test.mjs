import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, win32 } from 'node:path';
import test from 'node:test';
import { BUILD_OUTPUTS, cleanBuildOutput, resolveBuildOutput } from '../build-tools/clean-build-output.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

/** 模拟完整目录树；测试绝不调用真实文件系统删除或改变正式 dist。 */
function filesystem({ missing = false, ancestorLink = false, childLink = false, failure = false } = {}) {
  const deleted = [];
  const entry = (directory, link = false) => ({
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => link,
  });
  return {
    deleted,
    lstatSync(path) {
      if (failure) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      if (missing && BUILD_OUTPUTS.some((name) => path === resolveBuildOutput(name)))
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      if (ancestorLink && path === join(ROOT, 'apps')) return entry(true, true);
      if (path.endsWith('nested.js')) return entry(false, childLink);
      return entry(true);
    },
    readdirSync: () => ['nested.js'],
    rmSync: (...args) => deleted.push(args),
  };
}

/** 捕获实际 Windows 调用正文，仍使用模拟树，禁止启动删除进程。 */
function windowsCall(requested = 'apps/api/dist') {
  let captured;
  const io = filesystem();
  cleanBuildOutput(requested, {
    platform: 'win32',
    io,
    run: (...args) => {
      captured = args;
    },
  });
  assert.deepEqual(io.deleted, []);
  return {
    executable: captured[0],
    args: captured[1],
    options: captured[2],
    script: captured[1].at(-1),
  };
}

test('构建清理只接受三个固定名称，拒绝根、绝对路径、相邻前缀、跨根与 ..', () => {
  for (const name of BUILD_OUTPUTS) assert.equal(resolveBuildOutput(name), resolve(ROOT, name));
  for (const invalid of [
    undefined,
    '',
    '/',
    ROOT,
    'Temp',
    'dist',
    'apps/api',
    'apps/api/dist-old',
    'apps/api/dist/../src',
    'apps/api/../api/dist',
    './apps/api/dist',
    'apps\\api\\dist',
    'Apps/api/dist',
    'C:\\',
    'C:\\other\\apps\\api\\dist',
    '\\\\server\\share\\apps\\api\\dist',
    'apps/api/dist ',
  ])
    assert.throws(() => resolveBuildOutput(invalid), /固定 dist/);
});

test('POSIX 保留原 rm 行为且只删除精确目标，缺少 dist 时无删除', () => {
  for (const name of BUILD_OUTPUTS) {
    const io = filesystem();
    cleanBuildOutput(name, { platform: 'linux', io });
    assert.deepEqual(io.deleted, [[resolveBuildOutput(name), { recursive: true, force: true }]]);
  }
  const missing = filesystem({ missing: true });
  cleanBuildOutput('apps/api/dist', { platform: 'linux', io: missing });
  assert.deepEqual(missing.deleted, []);
});

test('祖先 junction、子树符号链接及读取错误均拒绝，不能调用删除器', () => {
  for (const config of [{ ancestorLink: true }, { childLink: true }, { failure: true }]) {
    for (const platform of ['win32', 'linux']) {
      const io = filesystem(config);
      let spawned = false;
      assert.throws(() =>
        cleanBuildOutput('apps/api/dist', {
          platform,
          io,
          run: () => {
            spawned = true;
          },
        }),
      );
      assert.deepEqual(io.deleted, []);
      assert.equal(spawned, false);
    }
  }
});

test('Windows 固定绝对 PS5.1 入口且仅传白名单名称，不把路径拼成命令', () => {
  const call = windowsCall('packages/api-client/dist');
  assert.ok(win32.isAbsolute(call.executable));
  assert.match(call.executable, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.deepEqual(call.args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(call.options.env.SESAME_BUILD_ROOT, ROOT);
  assert.equal(call.options.env.SESAME_BUILD_OUTPUT, 'packages/api-client/dist');
  assert.match(call.script, /PSVersion\.Major -ne 5 -or \$PSVersionTable\.PSVersion\.Minor -ne 1/);
  assert.match(call.script, /Remove-Item -LiteralPath \$target -Recurse -Force/);
  assert.doesNotMatch(call.script, /FollowSymlink|cmd\.exe|ExecutionPolicy/);
});

const WINDOWS_MOCKS = String.raw`
$script:removed = 0
function global:Test-Path {
  param([string]$LiteralPath)
  return $env:SESAME_CLEAN_TEST_CASE -ne 'absent'
}
function global:Get-Item {
  param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction)
  $attributes = [IO.FileAttributes]::Directory
  if ($env:SESAME_CLEAN_TEST_CASE -eq 'ancestor' -and
      $LiteralPath -eq [IO.Path]::Combine($env:SESAME_BUILD_ROOT, 'apps')) {
    $attributes = $attributes -bor [IO.FileAttributes]::ReparsePoint
  }
  return [pscustomobject]@{ FullName = $LiteralPath; PSIsContainer = $true; Attributes = $attributes }
}
function global:Get-ChildItem {
  param([string]$LiteralPath, [switch]$Force, [string]$ErrorAction)
  $attributes = [IO.FileAttributes]::Normal
  if ($env:SESAME_CLEAN_TEST_CASE -eq 'descendant') {
    $attributes = $attributes -bor [IO.FileAttributes]::ReparsePoint
  }
  return [pscustomobject]@{
    FullName = [IO.Path]::Combine($LiteralPath, 'nested.js')
    PSIsContainer = $false
    Attributes = $attributes
  }
}
function global:Remove-Item {
  param([string]$LiteralPath, [switch]$Recurse, [switch]$Force, [string]$ErrorAction)
  # 函数遮蔽真实 cmdlet：仅记录经过校验的目标，绝不删除任何文件。
  $expected = [IO.Path]::GetFullPath([IO.Path]::Combine($env:SESAME_BUILD_ROOT, $env:SESAME_BUILD_OUTPUT))
  if ($LiteralPath -ne $expected -or -not $Recurse -or -not $Force) { throw 'Unexpected mock removal.' }
  $script:removed++
  Write-Output 'SIMULATED_REMOVE'
}
`;

/** 真实 PS5.1 解释正式正文，但所有文件系统 cmdlet 被无副作用 mock 遮蔽。 */
function runWindowsMock(mode, env = {}) {
  const call = windowsCall();
  return spawnSync(call.executable, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_MOCKS + call.script], {
    env: { ...call.options.env, SESAME_CLEAN_TEST_CASE: mode, ...env },
    encoding: 'utf8',
  });
}

test('PS5.1 实际解析与模拟执行：校验后仅一次删除、缺失输出无删除', { skip: process.platform !== 'win32' }, () => {
  const accepted = runWindowsMock('valid');
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /PowerShell 5\.1\./);
  assert.equal(accepted.stdout.split('SIMULATED_REMOVE').length - 1, 1);
  const absent = runWindowsMock('absent');
  assert.equal(absent.status, 0, absent.stderr);
  assert.doesNotMatch(absent.stdout, /SIMULATED_REMOVE/);
});

test('PS5.1 模拟重解析祖先/子树、根目录与越界输入均在删除前拒绝', { skip: process.platform !== 'win32' }, () => {
  for (const [mode, env] of [
    ['ancestor', {}],
    ['descendant', {}],
    ['valid', { SESAME_BUILD_ROOT: win32.parse(ROOT).root }],
    ['valid', { SESAME_BUILD_ROOT: 'relative' }],
    ['valid', { SESAME_BUILD_OUTPUT: '../apps/api/dist' }],
    ['valid', { SESAME_BUILD_OUTPUT: 'apps/api/dist-other' }],
    ['valid', { SESAME_BUILD_OUTPUT: '\\\\server\\share\\dist' }],
  ]) {
    const rejected = runWindowsMock(mode, env);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.doesNotMatch(rejected.stdout, /SIMULATED_REMOVE/);
  }
});
