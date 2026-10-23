import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ps = 'pwsh';
const available =
  spawnSync(ps, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
const targetTest = available ? test : test.skip;
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

/** 使用模拟命令验证来源约束与 Flutter 参数，不连接网络、不创建资源。 */
function run(args, fail = false) {
  const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
function docker { throw 'FORBIDDEN_DOCKER' }
function pnpm { throw 'FORBIDDEN_PNPM' }
function node {
  Write-Output '{"TEST_API_ORIGIN":"http://10.20.30.40:8080","TEST_WEB_ORIGIN":"http://127.0.0.1:4173"}'
  $global:LASTEXITCODE = 0
}
function Get-Command { param([string]$Name)
  if ($Name -eq 'node') { return [pscustomobject]@{ Source = 'node' } }
  return Microsoft.PowerShell.Core\\Get-Command $Name
}
function Invoke-RestMethod { throw 'FORBIDDEN_HTTP' }
function Start-Process { throw 'FORBIDDEN_PROCESS' }
function Remove-Item { throw 'FORBIDDEN_REMOVE' }
function New-Item { throw 'FORBIDDEN_CREATE' }
function Test-Path { param([string]$LiteralPath)
  if ([IO.Path]::GetFileName($LiteralPath) -cnotin @('real_backend_roundtrip_test.dart', '.env.test')) { throw 'UNEXPECTED_PATH' }
  return $true
}
function flutter {
  Write-Output ('MOCK_FLUTTER:' + ($args -join '|'))
  $global:LASTEXITCODE = ${fail ? '17' : '0'}
}
$before = (Get-Location).Path
try {
  & ${quote(path.join(root, 'scripts/dev/test-mobile-backend.ps1'))} -MobilePath ${quote(root)} ${args}
  Write-Output 'RESULT:ok'
} catch {
  Write-Output ('RESULT:error:' + $_.Exception.Message)
}
if ((Get-Location).Path -ne $before) { throw 'CWD_NOT_RESTORED' }
`;
  const result = spawnSync(ps, ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    cwd: root,
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /FORBIDDEN_/);
  return result.stdout;
}

for (const address of ['http://10.20.30.40:8080', 'http://10.20.30.40:8080/']) {
  targetTest(`existing mode accepts only confirmed target ${address}`, () => {
    const output = run(`-Mode existing-backend -ConfirmExistingBackend -BaseUrl ${quote(address)}`);
    assert.match(output, /RESULT:ok/);
    assert.match(output, /MOCK_FLUTTER:test\|e2e\/real_backend_roundtrip_test.dart/);
    assert.match(output, /--dart-define=E2E_EXISTING_BACKEND_CONFIRMED=true/);
    assert.match(output, /--dart-define=E2E_BASE_URL=http:\/\/10.20.30.40:8080/);
    assert.match(output, /--dart-define=E2E_EXPECTED_BACKEND_URL=http:\/\/10.20.30.40:8080/);
  });
}
for (const args of [
  '-Mode existing-backend -BaseUrl http://10.20.30.40:8080',
  '-Mode existing-backend -ConfirmExistingBackend',
  ...[
    'http://10.20.30.41:8080',
    'https://10.20.30.40:8080',
    'http://10.20.30.40:8081',
    'http://user:secret@10.20.30.40:8080',
    'http://10.20.30.40:8080/api',
    'http://10.20.30.40:8080/?query=1',
    'http://10.20.30.40:8080/#fragment',
    'http://127.0.0.1:8080',
  ].map((address) => `-Mode existing-backend -ConfirmExistingBackend -BaseUrl ${quote(address)}`),
  '-Mode isolated -BaseUrl http://10.20.30.40:8080',
  '-Mode isolated -ConfirmExistingBackend',
]) {
  targetTest(`rejects unconfirmed or out-of-scope selection: ${args}`, () => {
    const output = run(args);
    assert.match(output, /RESULT:error:/);
    assert.doesNotMatch(output, /MOCK_FLUTTER:/);
  });
}
targetTest('Flutter failure is propagated and never invokes lifecycle cleanup', () => {
  const output = run('-Mode existing-backend -ConfirmExistingBackend -BaseUrl http://10.20.30.40:8080', true);
  assert.match(output, /RESULT:error:.*17/);
});
