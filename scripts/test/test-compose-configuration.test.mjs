import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const temporaryRoot = path.join(root, 'Temp');
const runtime = path.join(root, 'scripts/lib/test-environment-runtime.ps1');
const secret = 'synthetic-compose-secret-must-not-appear';
const environment = `SESAME_ENV=test
NODE_ENV=development
HOST=0.0.0.0
PORT=8080
TEST_API_ORIGIN=http://127.0.0.1:8080
TEST_WEB_ORIGIN=http://127.0.0.1:4173
DATABASE_URL=postgresql://sesame:sesame@localhost:55432/sesame_notes_test
JWT_SECRET=${secret}
STORAGE_PATH=./data
CORS_ORIGINS=http://127.0.0.1:4173
POSTGRES_IMAGE_REVISION=${'a'.repeat(64)}
TEST_IMAGE_TAG=local
`;

/** 只探测工具版本，不访问 Docker daemon 或创建任何资源。 */
function probe(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

const hasPowerShell = probe('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
const hasCompose = hasPowerShell && probe('docker', ['compose', 'version']);
const powershellOptions = { skip: hasPowerShell ? false : '环境问题：缺少可运行的 PowerShell 7。' };
const composeOptions = {
  skip: hasCompose ? false : '环境问题：缺少 PowerShell 7 或 Docker Compose CLI；未执行真实 config 回归。',
};

/** 将路径编码为 PowerShell 单引号字面量，防止路径被解释为命令。 */
function quote(value) {
  try {
    return `'${value.replaceAll("'", "''")}'`;
  } catch (error) {
    throw new Error('配置回归的路径编码失败。', { cause: error });
  }
}

/** 验证解析后的精确路径及目录链接边界，仅删除本次创建的 Temp 夹具。 */
function cleanup(fixture) {
  try {
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
try {
    $Target = [IO.Path]::GetFullPath(${quote(fixture)})
    $Parent = [IO.Path]::GetFullPath(${quote(temporaryRoot)})
    if ([IO.Path]::GetDirectoryName($Target) -cne $Parent -or [IO.Path]::GetFileName($Target) -cnotlike 'test-compose-*') { throw 'INVALID_CLEANUP_TARGET' }
    foreach ($Path in @($Parent, $Target)) {
        if ((Resolve-Path -LiteralPath $Path).ProviderPath -cne $Path) { throw 'CHANGED_CLEANUP_TARGET' }
        if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'LINKED_CLEANUP_TARGET' }
    }
    if (@(Get-ChildItem -LiteralPath $Target -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'LINKED_CLEANUP_CONTENT' }
    Remove-Item -LiteralPath $Target -Recurse -Force
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(result.status, 0, `环境问题：配置夹具清理失败。${result.stderr}`);
  } catch (error) {
    throw new Error('隔离配置测试清理失败。', { cause: error });
  }
}

/** 仅加载纯配置函数；环境文件与 Compose 文件均在隔离夹具中，不读取真实私有配置。 */
function run(body) {
  let fixture;
  try {
    mkdirSync(temporaryRoot, { recursive: true });
    fixture = mkdtempSync(path.join(temporaryRoot, 'test-compose-'));
    mkdirSync(path.join(fixture, 'deploy'));
    copyFileSync(
      path.join(root, 'deploy/docker-compose.test.yml'),
      path.join(fixture, 'deploy/docker-compose.test.yml'),
    );
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
    $Runtime = $Root
    # 固定使用合成配置，调用者的 Compose、Docker 与插值变量不能影响回归结果。
    foreach ($Entry in @(Get-ChildItem Env:)) {
        if ($Entry.Name -match '^(COMPOSE_|DOCKER_|POSTGRES_IMAGE_REVISION$|TEST_IMAGE_TAG$|TEST_SOURCE_ROOT$|CORS_ORIGINS$|ADMIN_)') {
            Set-TestEnvironmentValue $Entry.Name $null
        }
    }
    ${body}
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
`,
      ],
      { encoding: 'utf8', cwd: fixture, timeout: 30_000 },
    );
    assert.equal(result.status, 0, `实现错或环境问题：配置回归未完成。${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_/);
    assert.ok(!(result.stdout + result.stderr).includes(secret), '实现错：配置诊断泄露了合成私有值。');
    return result.stdout;
  } catch (error) {
    throw new Error('测试 Compose 配置保护回归失败。', { cause: error });
  } finally {
    if (fixture) cleanup(fixture);
  }
}

const readOnlyDocker = `
    $RealDocker = (Get-Command docker -ErrorAction Stop).Source
    <# .SYNOPSIS 真实 Docker 仅允许解析配置，阻断任何容器、镜像、卷及 daemon 操作。 #>
    function Invoke-ReadOnlyDocker {
        try {
            if ($args[0] -cne 'compose' -or ($args | Where-Object { $_ -ceq 'config' }).Count -ne 1 -or
                ($args[-3..-1] -join ' ') -cne 'config --format json') { throw 'FORBIDDEN_DOCKER_OPERATION' }
            & $RealDocker @args
        } catch { throw }
    }
`;

test('配置文件拒绝任意大小写的 Compose 与 Docker 控制字段', powershellOptions, () => {
  const output = run(`
    $Original = Get-Content -LiteralPath (Join-Path $Root '.env.test') -Raw
    foreach ($Key in @('COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES', 'compose_project_name', 'Compose_Project_Name', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'docker_context', 'DOCKER_FUTURE_CONTROL')) {
        Set-Content -LiteralPath (Join-Path $Root '.env.test') -Value ($Original + $Key + '=' + ${quote(secret)})
        $Rejected = $false
        try { $null = Read-TestEnvironment $Root $Node } catch {
            $Rejected = $true
            if ($_.Exception.ToString().Contains(${quote(secret)})) { throw 'CONTROL_VALUE_LEAK' }
        }
        if (-not $Rejected) { throw ('实现错：配置文件控制字段被接受：' + $Key) }
    }
    Write-Output 'CONTROL_FIELDS_PASS'
  `);
  assert.match(output, /CONTROL_FIELDS_PASS/);
});

test('真实 Compose 配置中的项目覆盖被固定参数阻断，合法最终模型通过核验', composeOptions, () => {
  const output = run(`
    ${readOnlyDocker}
    $Values = (Read-TestEnvironment $Root $Node).values
    $Compose = @(Get-TestComposeArguments $Root)
    $Expected = @('compose', '--project-name', 'sesame-notes-test', '--env-file', (Join-Path $Root '.env.test'), '-f', (Join-Path $Root 'deploy/docker-compose.test.yml'))
    if (($Compose -join '|') -cne ($Expected -join '|')) { throw '实现错：Compose 入口未固定项目与文件参数。' }
    Add-Content -LiteralPath (Join-Path $Root '.env.test') -Value 'COMPOSE_PROJECT_NAME=unexpected-fixture-project'
    $Unpinned = @('compose', '--env-file', (Join-Path $Root '.env.test'), '-f', (Join-Path $Root 'deploy/docker-compose.test.yml'))
    $UnpinnedJson = & Invoke-ReadOnlyDocker @Unpinned config --format json
    if ($LASTEXITCODE -ne 0) { throw '环境问题：未固定项目的隔离配置解析失败。' }
    if ((($UnpinnedJson -join [Environment]::NewLine) | ConvertFrom-Json).name -cne 'unexpected-fixture-project') {
        throw '测试错：隔离配置未复现文件中的项目名覆盖路径。'
    }
    $Json = & Invoke-ReadOnlyDocker @Compose config --format json
    if ($LASTEXITCODE -ne 0) { throw '环境问题：真实 Compose config 解析失败。' }
    $Model = ($Json -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable
    if ($Model.name -cne 'sesame-notes-test') { throw '实现错：文件中的控制字段覆盖了固定项目名。' }
    $Output = @(Assert-TestComposeModel $Model $Values)
    if ($Output.Count) { throw '实现错：模型核验向标准输出泄露配置。' }
    $Output = @(Assert-TestComposeConfiguration 'Invoke-ReadOnlyDocker' $Compose $Values)
    if ($Output.Count) { throw '实现错：最终配置核验向标准输出泄露配置。' }
    $ArrayJson = '[' + ($Json -join [Environment]::NewLine) + ']'
    <# .SYNOPSIS 返回单元素合法模型数组，验证 JSON 管道不能解包数组并绕过根节点校验。 #>
    function Invoke-ArrayCompose {
        try { $global:LASTEXITCODE = 0; Write-Output $ArrayJson } catch { throw }
    }
    $Rejected = $false
    try { Assert-TestComposeConfiguration 'Invoke-ArrayCompose' $Compose $Values } catch { $Rejected = $true }
    if (-not $Rejected) { throw '实现错：单元素合法模型数组绕过了对象根节点校验。' }
    Write-Output 'REAL_COMPOSE_PASS'
  `);
  assert.match(output, /REAL_COMPOSE_PASS/);
});

test('真实 Compose 模型的项目、资源、挂载、镜像、数据库与端口改变时均拒绝', composeOptions, () => {
  const output = run(`
    ${readOnlyDocker}
    $Values = (Read-TestEnvironment $Root $Node).values
    $Compose = @(Get-TestComposeArguments $Root)
    $Json = & Invoke-ReadOnlyDocker @Compose config --format json
    if ($LASTEXITCODE -ne 0) { throw '环境问题：真实 Compose config 解析失败。' }
    $Changes = @(
        @{ label = '项目名'; change = { param($m) $m.name = 'another-project' } },
        @{ label = '数据库物理卷'; change = { param($m) $m.volumes.pg_data.name = 'other_pg_data' } },
        @{ label = 'API 物理卷'; change = { param($m) $m.volumes.api_data.name = 'other_api_data' } },
        @{ label = '数据库卷 external'; change = { param($m) $m.volumes.pg_data.external = $false } },
        @{ label = 'API 卷 external'; change = { param($m) $m.volumes.api_data.external = $false } },
        @{ label = '数据库镜像'; change = { param($m) $m.services.postgres.image = 'postgres:latest' } },
        @{ label = 'API 镜像'; change = { param($m) $m.services.api.image = 'another-api:latest' } },
        @{ label = '数据库拉取策略'; change = { param($m) $m.services.postgres.pull_policy = 'always' } },
        @{ label = 'API 拉取策略'; change = { param($m) $m.services.api.pull_policy = 'always' } },
        @{ label = '数据库挂载源'; change = { param($m) $m.services.postgres.volumes[0].source = 'api_data' } },
        @{ label = '数据库挂载位置'; change = { param($m) $m.services.postgres.volumes[0].target = '/other' } },
        @{ label = '数据库挂载类型'; change = { param($m) $m.services.postgres.volumes[0].type = 'bind' } },
        @{ label = 'API 数据挂载'; change = { param($m) ($m.services.api.volumes | Where-Object { $_.target -eq '/data' }).source = 'pg_data' } },
        @{ label = '网络名'; change = { param($m) $m.networks.default.name = 'other-network' } },
        @{ label = '数据库网络'; change = { param($m) $m.services.postgres.networks = @{ other = $null } } },
        @{ label = '数据库名称'; change = { param($m) $m.services.postgres.environment.POSTGRES_DB = 'another_database' } },
        @{ label = '数据库监听地址'; change = { param($m) $m.services.postgres.ports[0].host_ip = '0.0.0.0' } },
        @{ label = '数据库宿主端口'; change = { param($m) $m.services.postgres.ports[0].published = '55433' } },
        @{ label = '数据库内部端口'; change = { param($m) $m.services.postgres.ports[0].target = 5433 } },
        @{ label = '额外服务'; change = { param($m) $m.services.other = @{} } }
    )
    foreach ($Change in $Changes) {
        $Model = ($Json -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable
        & $Change.change $Model
        $Rejected = $false
        try { Assert-TestComposeModel $Model $Values } catch { $Rejected = $true }
        if (-not $Rejected) { throw ('实现错：最终 Compose 配置未拒绝变更：' + $Change.label) }
    }
    Write-Output ('MODEL_MUTATIONS_PASS:' + $Changes.Count)
  `);
  assert.match(output, /MODEL_MUTATIONS_PASS:20/);
});

test('Compose 执行失败、无效 JSON 与非对象根节点都终止校验且不泄露私有值', powershellOptions, () => {
  const output = run(`
    $Values = (Read-TestEnvironment $Root $Node).values
    $MockPath = Join-Path $Root 'fake-compose.mjs'
    $Secret = ${quote(secret)}
    $Cases = @(
        @{ label = '非零退出'; code = 23; output = $Secret; error = $Secret },
        @{ label = '无效 JSON'; code = 0; output = $Secret; error = $Secret },
        @{ label = '字符串根节点'; code = 0; output = (ConvertTo-Json -InputObject $Secret -Compress); error = '' },
        @{ label = '数组根节点'; code = 0; output = (ConvertTo-Json -InputObject @($Secret, $Secret) -Compress); error = '' }
    )
    foreach ($Case in $Cases) {
        $Source = 'process.stdout.write(' + (ConvertTo-Json -InputObject $Case.output -Compress) + ');process.stderr.write(' + (ConvertTo-Json -InputObject $Case.error -Compress) + ');process.exit(' + $Case.code + ');'
        Set-Content -LiteralPath $MockPath -Value $Source
        $Rejected = $false
        try { Assert-TestComposeConfiguration $Node @($MockPath) $Values } catch {
            $Rejected = $true
            $Diagnostic = $_.Exception.ToString() + ($_ | Out-String)
            if ($Diagnostic.Contains(${quote(secret)})) { throw '实现错：失败诊断保留了原始配置输出。' }
        }
        if (-not $Rejected) { throw ('实现错：Compose 错误未终止配置核验：' + $Case.label) }
    }
    <# .SYNOPSIS 模拟执行阶段直接抛出包含私有值的异常，验证完整异常链均经过脱敏。 #>
    function Invoke-ThrowingCompose {
        try { throw $Secret } catch { throw }
    }
    $Rejected = $false
    try { Assert-TestComposeConfiguration 'Invoke-ThrowingCompose' @('compose') $Values } catch {
        $Rejected = $true
        $Diagnostic = $_.Exception.ToString() + ($_ | Out-String)
        if ($Diagnostic.Contains($Secret)) { throw '实现错：执行异常链泄露了私有值。' }
    }
    if (-not $Rejected) { throw '实现错：执行异常未终止配置核验。' }
    Write-Output 'FAILED_CONFIG_REDACTED_PASS'
  `);
  assert.match(output, /FAILED_CONFIG_REDACTED_PASS/);
});
