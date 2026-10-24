import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const runtime = path.join(root, 'scripts/lib/test-environment-runtime.ps1');
const available =
  spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
  }).status === 0;
const runtimeTest = available ? test : test.skip;

/** 将路径转换为 PowerShell 单引号字面量，测试夹具路径不会被解释为代码。 */
function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 仅运行配置与身份函数，禁止测试启动服务；全部临时文件在仓库 Temp 内创建并由 PowerShell 清理。 */
function run(body, environment = '') {
  mkdirSync(path.join(root, 'Temp'), { recursive: true });
  const fixture = mkdtempSync(path.join(root, 'Temp/test-runtime-'));
  writeFileSync(path.join(fixture, '.env.test'), environment);
  const result = spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-Command',
      `
$ErrorActionPreference = 'Stop'
try {
    . ${quote(runtime)}
    $Root = ${quote(fixture)}
    $Node = ${quote(process.execPath)}
    function Start-Process { throw 'FORBIDDEN_PROCESS' }
    function Invoke-TestCommand { throw 'FORBIDDEN_COMMAND' }
    ${body}
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
`,
    ],
    { encoding: 'utf8', cwd: root, timeout: 20_000 },
  );
  // 删除始终留在同一 PowerShell 进程体系内，先核对精确目标与 Temp 边界。
  const cleanup = spawnSync(
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
      : 'pwsh',
    [
      '-NoProfile',
      '-Command',
      `
$ErrorActionPreference = 'Stop'
try {
    $target = [IO.Path]::GetFullPath(${quote(fixture)})
    $parent = [IO.Path]::GetFullPath(${quote(path.join(root, 'Temp'))})
    if ([IO.Path]::GetDirectoryName($target) -cne $parent -or [IO.Path]::GetFileName($target) -cnotlike 'test-runtime-*') { throw 'INVALID_CLEANUP_TARGET' }
    if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'LINKED_CLEANUP_TARGET' }
    Remove-Item -LiteralPath $target -Recurse -Force
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_/);
  return result.stdout;
}

const config = `SESAME_ENV=test
NODE_ENV=development
HOST=0.0.0.0
PORT=8080
TEST_API_ORIGIN=http://127.0.0.1:8080
TEST_WEB_ORIGIN=http://127.0.0.1:4173
DATABASE_URL=postgresql://sesame:sesame@localhost:55432/sesame_notes_test
JWT_SECRET=test-runtime-secret-at-least-32-bytes
STORAGE_PATH=./data
CORS_ORIGINS=http://127.0.0.1:4173,http://127.0.0.1:5173
`;

runtimeTest('只使用 .env.test，并清除终端残留的生产配置', () => {
  const output = run(
    `
    $env:DATABASE_URL = 'postgresql://prod/prod'
    $env:TRUST_PROXY_CIDRS = '0.0.0.0/0'
    $env:GITHUB_RELEASE_REPOSITORY = 'owner/production-updates'
    Set-TestEnvironmentValue 'RATE_LIMIT_MAX' $null
    $Config = Read-TestEnvironment $Root $Node
    $Saved = Set-TestEnvironment $Config.values
    if ($env:DATABASE_URL -cne $Config.values.DATABASE_URL -or $env:TRUST_PROXY_CIDRS -or $env:GITHUB_RELEASE_REPOSITORY) { throw 'ENVIRONMENT_LEAK' }
    if ($Saved.DATABASE_URL -cne 'postgresql://prod/prod') { throw 'MISSING_SAVED_VALUE' }
    & $Node --input-type=module -e 'const {loadConfig}=await import(process.argv[1]);if(Object.hasOwn(process.env,"RATE_LIMIT_MAX")||Object.hasOwn(process.env,"TRUST_PROXY_CIDRS"))throw Error("ABSENT_ENV_BECAME_EMPTY");if(loadConfig().rateLimitMax!==300)throw Error("API_DEFAULT_LOST");' ${quote(pathToFileURL(path.join(root, 'apps/api/src/config.ts')).href)}
    if ($LASTEXITCODE -ne 0) { throw 'API_DEFAULT_CONFIGURATION_FAILED' }
    Set-TestEnvironmentValue 'RATE_LIMIT_MAX' '123'
    Set-TestEnvironmentValue 'RATE_LIMIT_MAX' $Saved.RATE_LIMIT_MAX
    & $Node -e 'if(Object.hasOwn(process.env,"RATE_LIMIT_MAX"))throw Error("ABSENT_ENV_NOT_RESTORED");'
    if ($LASTEXITCODE -ne 0) { throw 'ENVIRONMENT_RESTORATION_FAILED' }
    Write-Output 'PASS'
  `,
    config,
  );
  assert.match(output, /PASS/);
});

runtimeTest('后台配置使用测试值，省略时清除终端残留值，并恢复调用者环境', () => {
  const output = run(
    `
    $OriginalAdmin = @{
        ADMIN_ORIGINS = 'https://admin.production.example'
        ADMIN_SESSION_TTL = '7200'
        ADMIN_SESSION_IDLE_TTL = '600'
        ADMIN_API_TARGET = 'https://api.production.example'
    }
    foreach ($Key in $OriginalAdmin.Keys) { Set-TestEnvironmentValue $Key $OriginalAdmin[$Key] }
    $Config = Read-TestEnvironment $Root $Node
    $Saved = Set-TestEnvironment $Config.values
    foreach ($Key in $OriginalAdmin.Keys) {
        if ($Saved[$Key] -cne $OriginalAdmin[$Key]) { throw "ADMIN_SAVED_VALUE_MISSING:$Key" }
    }
    & $Node -e 'for(const key of ["ADMIN_ORIGINS","ADMIN_SESSION_TTL","ADMIN_SESSION_IDLE_TTL","ADMIN_API_TARGET"]){if(Object.hasOwn(process.env,key))throw Error("ADMIN_ENVIRONMENT_LEAK:"+key);}'
    if ($LASTEXITCODE -ne 0) { throw 'ADMIN_ENVIRONMENT_NOT_CLEARED' }
    foreach ($Key in $Saved.Keys) { Set-TestEnvironmentValue $Key $Saved[$Key] }
    foreach ($Key in $OriginalAdmin.Keys) {
        if ([Environment]::GetEnvironmentVariable($Key, 'Process') -cne $OriginalAdmin[$Key]) { throw "ADMIN_RESTORATION_FAILED:$Key" }
    }
    $TestAdmin = @{
        ADMIN_ORIGINS = 'http://localhost:55174'
        ADMIN_SESSION_TTL = '28800'
        ADMIN_SESSION_IDLE_TTL = '1800'
        ADMIN_API_TARGET = 'http://127.0.0.1:8080'
    }
    foreach ($Key in $TestAdmin.Keys) { $Config.values[$Key] = $TestAdmin[$Key] }
    $Saved = Set-TestEnvironment $Config.values
    foreach ($Key in $TestAdmin.Keys) {
        if ([Environment]::GetEnvironmentVariable($Key, 'Process') -cne $TestAdmin[$Key]) { throw "ADMIN_TEST_VALUE_NOT_APPLIED:$Key" }
    }
    foreach ($Key in $Saved.Keys) { Set-TestEnvironmentValue $Key $Saved[$Key] }
    foreach ($Key in $OriginalAdmin.Keys) {
        if ([Environment]::GetEnvironmentVariable($Key, 'Process') -cne $OriginalAdmin[$Key]) { throw "ADMIN_OVERRIDE_RESTORATION_FAILED:$Key" }
    }
    Write-Output 'PASS'
  `,
    config,
  );
  assert.match(output, /PASS/);
});

runtimeTest('拒绝生产库、独立 API/数据库端口与手机不可访问的回环绑定', () => {
  const output = run(
    `
    $Original = Get-Content -LiteralPath (Join-Path $Root '.env.test') -Raw
    foreach ($Changed in @(
        $Original.Replace('SESAME_ENV=test', 'SESAME_ENV=prod'),
        $Original.Replace('sesame_notes_test', 'sesame_notes_prod'),
        $Original.Replace('PORT=8080', 'PORT=8081'),
        $Original.Replace(':55432/', ':55433/'),
        $Original.Replace('HOST=0.0.0.0', 'HOST=127.0.0.1')
    )) {
        Set-Content -LiteralPath (Join-Path $Root '.env.test') -Value $Changed
        $Rejected = $false
        try { $null = Read-TestEnvironment $Root $Node } catch { $Rejected = $true }
        if (-not $Rejected) { throw 'UNSAFE_CONFIG_ACCEPTED' }
    }
    Write-Output 'PASS'
  `,
    config,
  );
  assert.match(output, /PASS/);
});

runtimeTest('进程登记使用可执行文件与精确时间，允许显示名称变化并拒绝重用 PID', () => {
  const output = run(`
    $Moment = [DateTime]::Parse('2026-10-06T08:09:10.1234567Z').ToUniversalTime()
    $ActualExecutable = $Node
    function Get-Process { return [pscustomobject]@{ Id = $PID; ProcessName = 'renamed-worker'; StartTime = $Moment; Path = $ActualExecutable; HasExited = $false } }
    $StatePath = Join-Path $Root 'process.json'
    @{ root = $Root; role = 'api'; id = $PID; executable = $Node; started = $Moment.ToString('O') } |
        ConvertTo-Json | Set-Content -LiteralPath $StatePath
    if (-not (Get-TestProcess $StatePath 'api')) { throw 'VALID_PROCESS_REJECTED' }
    # 使用当前 PowerShell 的真实路径验证不同可执行文件被拒绝。
    $ActualExecutable = [Environment]::ProcessPath
    $Rejected = $false
    try { $null = Get-TestProcess $StatePath 'api' } catch { $Rejected = $true }
    if (-not $Rejected) { throw 'FOREIGN_EXECUTABLE_ACCEPTED' }
    $ActualExecutable = $Node
    $Moment = $Moment.AddTicks(1)
    $Rejected = $false
    try { $null = Get-TestProcess $StatePath 'api' } catch { $Rejected = $true }
    if (-not $Rejected) { throw 'RECYCLED_PID_ACCEPTED' }
    Write-Output 'PASS'
  `);
  assert.match(output, /PASS/);
});

runtimeTest('本地测试来源必须显式配置，拒绝公网、凭据、路径与非可信 Web 来源', () => {
  const output = run(
    `
    $Original = Get-Content -LiteralPath (Join-Path $Root '.env.test') -Raw
    $Origins = Read-TestOrigins $Root $Node
    if ($Origins.TEST_API_ORIGIN -cne 'http://127.0.0.1:8080' -or $Origins.Keys.Count -ne 2) { throw 'ORIGIN_CONFIGURATION_INVALID' }
    foreach ($Address in @('http://10.20.30.40:8080', 'http://172.20.1.2:8080', 'http://192.168.100.10:8080', 'http://localhost:8080')) {
        if ((Get-LocalTestOrigin $Address 'fixture') -cne $Address) { throw 'PRIVATE_ORIGIN_REJECTED' }
    }
    foreach ($Changed in @(
        $Original.Replace('TEST_API_ORIGIN=http://127.0.0.1:8080', 'TEST_API_ORIGIN='),
        $Original.Replace('TEST_API_ORIGIN=http://127.0.0.1:8080', 'TEST_API_ORIGIN=http://203.0.113.10:8080'),
        $Original.Replace('TEST_API_ORIGIN=http://127.0.0.1:8080', 'TEST_API_ORIGIN=http://api.example.com:8080'),
        $Original.Replace('TEST_API_ORIGIN=http://127.0.0.1:8080', 'TEST_API_ORIGIN=https://127.0.0.1:8080'),
        $Original.Replace('TEST_API_ORIGIN=http://127.0.0.1:8080', 'TEST_API_ORIGIN=http://user:secret@127.0.0.1:8080'),
        $Original.Replace('TEST_API_ORIGIN=http://127.0.0.1:8080', 'TEST_API_ORIGIN=http://127.0.0.1:8080/api'),
        $Original.Replace('TEST_WEB_ORIGIN=http://127.0.0.1:4173', 'TEST_WEB_ORIGIN=http://10.20.30.40:4173')
    )) {
        Set-Content -LiteralPath (Join-Path $Root '.env.test') -Value $Changed
        $Rejected = $false
        try { $null = Read-TestOrigins $Root $Node } catch { $Rejected = $true }
        if (-not $Rejected) { throw 'UNSAFE_ORIGIN_ACCEPTED' }
    }
    Write-Output 'PASS'
  `,
    config,
  );
  assert.match(output, /PASS/);
});

runtimeTest('统一启动入口按组件保留构建模式、监听地址和进程隔离，结束后恢复环境', () => {
  const starter = path.join(root, 'scripts/dev/start-test-environment.ps1');
  const mocks = String.raw`
$script:ApiChecks = 0
function Get-Command { param([string]$Name) return @{ Source = $Name } }
function Read-TestEnvironment {
    return @{ fingerprint = 'fixture'; values = @{
        TEST_API_ORIGIN = 'http://10.20.30.40:8080'; TEST_WEB_ORIGIN = 'http://127.0.0.1:4173'
        ADMIN_ORIGINS = 'http://localhost:55174'; POSTGRES_IMAGE_REVISION = ('a' * 64)
    } }
}
function Get-TestProcess { return $null }
function Get-SharedTestApi {
    $script:ApiChecks++
    if ($Component -eq 'api' -and $script:ApiChecks -eq 1) { return $null }
    return @{ kind = 'node'; process = $null }
}
function Assert-TestPort { param([int]$Port) Write-Host "PORT:$Port" }
function Wait-TestReady { param([string]$Url) Write-Host "READY:$Url" }
function Stop-TestProcess { param($Managed, [string]$Path, [string]$Role) Write-Host "STOP:$Role" }
function Set-TestEnvironment {
    $saved = @{ NODE_ENV = $env:NODE_ENV; WEB_API_TARGET = $env:WEB_API_TARGET }
    $env:NODE_ENV = 'development'
    return $saved
}
function Set-TestEnvironmentValue { param($Key, $Value) [Environment]::SetEnvironmentVariable($Key, $Value, 'Process') }
function Test-Path { param([string]$LiteralPath) return -not $LiteralPath.EndsWith('.env.test.bootstrap.json') }
function docker { $global:LASTEXITCODE = 0 }
function Assert-TestComposeConfiguration {
    param([string]$Docker, [string[]]$Compose)
    if ($Compose[0] -cne 'compose' -or $Compose[1] -cne '--project-name' -or $Compose[2] -cne 'sesame-notes-test') {
        throw 'COMPOSE_PROJECT_NOT_PINNED'
    }
    Write-Host 'VERIFY_COMPOSE_CONFIG'
}
function Invoke-TestCommand {
    param([string]$Command, [string[]]$Arguments)
    Write-Host ('COMMAND:' + $Command + '|' + ($Arguments -join '|') + '|MODE:' + $env:NODE_ENV)
}
function Start-TestProcess {
    param([string]$Role, [string[]]$Arguments, [string]$Directory, [string]$Path)
    Write-Host ('START:' + $Role + '|' + ($Arguments -join '|') + '|STATE:' + $Path)
    return [pscustomobject]@{ Id = 42; HasExited = $false }
}
function Write-TestFailure { param($Failure) throw $Failure }
`;
  const output = run(`
    $fixtureRoot = $Root
    $directory = Join-Path $Root 'scripts/dev'
    $library = Join-Path $Root 'scripts/lib'
    $null = New-Item -ItemType Directory -Force -Path $directory, $library
    Copy-Item -LiteralPath ${quote(starter)} -Destination (Join-Path $directory 'start-test-environment.ps1')
    Set-Content -LiteralPath (Join-Path $library 'test-environment-runtime.ps1') -Value ${quote(mocks)}
    $env:NODE_ENV = 'original-mode'
    $env:WEB_API_TARGET = 'original-web'
    $env:ADMIN_API_TARGET = 'original-admin'
    foreach ($component in @('api', 'web', 'admin')) {
        & (Join-Path $directory 'start-test-environment.ps1') -Component $component -Rebuild
        if ($env:NODE_ENV -cne 'original-mode' -or $env:WEB_API_TARGET -cne 'original-web' -or $env:ADMIN_API_TARGET -cne 'original-admin') {
            throw 'STARTUP_CHANGED_CALLER_ENVIRONMENT'
        }
        & (Join-Path $directory 'start-test-environment.ps1') -Component $component -Stop
    }
    Write-Output 'STARTERS_PASS'
  `);
  assert.match(output, /STARTERS_PASS/);
  assert.ok(output.indexOf('VERIFY_COMPOSE_CONFIG') < output.indexOf('COMMAND:docker|volume|inspect'));
  assert.match(output, /COMMAND:docker\|compose\|--project-name\|sesame-notes-test\|/);
  assert.match(output, /START:api\|apps\/api\/dist\/server\.js/);
  assert.match(output, /COMMAND:node\|apps\/api\/prisma\/setup\.mjs\|--test-admin/);
  assert.match(output, /COMMAND:pnpm\|--filter\|@sesame-notes\/web\|build\|MODE:production/);
  assert.match(output, /START:web\|node_modules\/vite\/bin\/vite\.js\|preview\|--host\|127\.0\.0\.1\|--port\|4173/);
  assert.match(output, /START:admin\|node_modules\/vite\/bin\/vite\.js\|--host\|127\.0\.0\.1\|--port\|55174/);
  assert.doesNotMatch(output, /@sesame-notes\/admin\|build|COMMAND:docker\|.*(?:down|volume\|rm)/);
  for (const component of ['api', 'web', 'admin']) assert.match(output, new RegExp(`STOP:${component}`));
});
