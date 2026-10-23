import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const available = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']).status === 0;

/** 将本机路径作为 PowerShell 单引号文本传入，避免被解释为命令。 */
function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

for (const component of ['web', 'mobile']) {
  (available ? test : test.skip)(`${component} 隔离验收清除终端 API 配置，失败后恢复原始环境`, () => {
    // 执行真实编排到首个构建命令；Docker、服务进程和 Flutter 全部由模拟边界接管。
    const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$env:SESAME_ENV = 'prod'
$env:ADMIN_ORIGINS = 'http://localhost:55174'
$env:GITHUB_RELEASE_REPOSITORY = 'owner/private-production'
$env:TRUST_PROXY_CIDRS = 'invalid-production-proxy'
$env:RATE_LIMIT_MAX = '73'
[Environment]::SetEnvironmentVariable('E2E_DATABASE_URL', [NullString]::Value, 'Process')
$before = (Get-Location).Path
$global:containerName = ''
$global:checked = $false
function Get-Command {
  [CmdletBinding()] param([string]$Name)
  return [pscustomobject]@{ Source = $Name }
}
function Test-Path {
  [CmdletBinding()] param([string]$LiteralPath, [string]$PathType)
  if ($LiteralPath.EndsWith('real_backend_roundtrip_test.dart')) { return $true }
  return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath
}
function docker {
  $global:LASTEXITCODE = 0
  switch ($args[0]) {
    'image' { return 'sha256:' + ('a' * 64) }
    'run' { $global:containerName = $args[[Array]::IndexOf($args, '--name') + 1]; return 'a' * 64 }
    'port' { return '127.0.0.1:54321' }
    'exec' { return }
    'inspect' { return '/' + $global:containerName }
    'logs' { return }
    'rm' { return }
    default { throw 'UNEXPECTED_DOCKER_COMMAND' }
  }
}
function Start-Process {
  [CmdletBinding()] param([string]$FilePath, [string[]]$ArgumentList, [string]$WindowStyle,
    [switch]$PassThru, [string]$RedirectStandardOutput, [string]$RedirectStandardError)
  if ($FilePath -ne 'docker' -or $ArgumentList[0] -ne 'image') { throw 'UNEXPECTED_SERVICE_START' }
  $process = [pscustomobject]@{ ExitCode = 0 }
  $process | Add-Member ScriptMethod WaitForExit { param($timeout) return $true }
  $process | Add-Member ScriptMethod Dispose {}
  return $process
}
function Assert-IsolatedConfiguration {
  & ${quote(process.execPath)} --input-type=module -e ${quote(`
    const { loadConfig } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'apps/api/src/config.ts')).href)});
    for (const key of ['SESAME_ENV', 'ADMIN_ORIGINS', 'GITHUB_RELEASE_REPOSITORY', 'TRUST_PROXY_CIDRS']) {
      if (Object.hasOwn(process.env, key)) throw new Error('INHERITED_CONFIGURATION:' + key);
    }
    const config = loadConfig();
    if (config.rateLimitMax !== 10000 || config.databaseUrl !== process.env.E2E_DATABASE_URL)
      throw new Error('ISOLATED_CONFIGURATION_CHANGED');
  `)}
  if ($LASTEXITCODE -ne 0) { throw 'INVALID_ISOLATED_CONFIGURATION' }
  $global:checked = $true
  Set-Content -LiteralPath (Join-Path $RunDirectory 'api.stderr.log') -Value 'test-only detailed diagnostic'
  throw 'TEST_STOP_BEFORE_BUILD'
}
function node { Assert-IsolatedConfiguration }
function pnpm { Assert-IsolatedConfiguration }
function flutter { throw 'UNEXPECTED_FLUTTER' }
try {
  & ${quote(path.join(root, `scripts/dev/test-${component}-backend.ps1`))} ${component === 'mobile' ? `-MobilePath ${quote(root)}` : ''}
} finally {
  if (-not $global:checked) { throw 'CONFIGURATION_CHECK_NOT_REACHED' }
  if ($env:SESAME_ENV -cne 'prod' -or $env:ADMIN_ORIGINS -cne 'http://localhost:55174' -or
      $env:GITHUB_RELEASE_REPOSITORY -cne 'owner/private-production' -or
      $env:TRUST_PROXY_CIDRS -cne 'invalid-production-proxy' -or $env:RATE_LIMIT_MAX -cne '73') {
    throw 'ORIGINAL_CONFIGURATION_NOT_RESTORED'
  }
  & ${quote(process.execPath)} -e 'if(Object.hasOwn(process.env,"E2E_DATABASE_URL"))throw Error("ABSENT_VARIABLE_NOT_RESTORED")'
  if ($LASTEXITCODE -ne 0) { throw 'ABSENT_VARIABLE_NOT_RESTORED' }
  if ((Get-Location).Path -ne $before) { throw 'WORKING_DIRECTORY_NOT_RESTORED' }
  Write-Output 'ISOLATED_ENVIRONMENT_VERIFIED'
}
`;
    try {
      // PATH 已提供模拟工具时，安装目录变量缺失不能阻断真实编排与环境隔离检查。
      const environment = { ...process.env };
      const installationDirectories = new Set(['appdata', 'localappdata', 'programfiles', 'programfiles(x86)']);
      for (const key of Object.keys(environment)) {
        if (installationDirectories.has(key.toLowerCase())) delete environment[key];
      }
      const result = spawnSync('pwsh', ['-NoProfile', '-Command', command], {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.match(result.stdout, /ISOLATED_ENVIRONMENT_VERIFIED/, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /INHERITED_CONFIGURATION|UNEXPECTED_|NOT_RESTORED/);
      if (component === 'mobile') {
        const retained = /本轮详细日志已保留：([^\r\n]+)/.exec(result.stderr)?.[1];
        assert.ok(retained, result.stderr);
        assert.match(readFileSync(path.join(retained, 'api.stderr.log'), 'utf8'), /test-only detailed diagnostic/);
      }
    } catch (error) {
      throw new Error(`${component} 隔离验收环境回归失败`, { cause: error });
    }
  });
}
