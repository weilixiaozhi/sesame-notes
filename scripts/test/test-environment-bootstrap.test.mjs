import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const temporaryRoot = path.join(root, 'Temp');
const runtime = path.join(root, 'scripts/lib/test-environment-runtime.ps1');
const bootstrap = path.join(root, 'scripts/lib/test-environment-bootstrap.ps1');
const available =
  spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
const bootstrapTest = available ? test : test.skip;

/** 将测试文件路径编码为 PowerShell 单引号字面量，避免特殊字符被执行。 */
function quote(value) {
  try {
    return `'${value.replaceAll("'", "''")}'`;
  } catch (error) {
    throw new Error('测试路径编码失败。', { cause: error });
  }
}

/** 创建仅包含依赖存在标记的夹具；不安装软件，也不访问真实数据库。 */
function createFixture() {
  try {
    mkdirSync(temporaryRoot, { recursive: true });
    const fixture = mkdtempSync(path.join(temporaryRoot, 'test-bootstrap-'));
    copyFileSync(path.join(root, '.env.test.example'), path.join(fixture, '.env.test.example'));
    for (const dependency of [
      'node_modules/.modules.yaml',
      'apps/api/node_modules/prisma/package.json',
      'apps/api/node_modules/typescript/package.json',
    ]) {
      const target = path.join(fixture, dependency);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, '{}');
    }
    return fixture;
  } catch (error) {
    throw new Error('无法在仓库 Temp 内创建初始化测试夹具。', { cause: error });
  }
}

/** 限定并验证 Temp 内的独立夹具路径后，通过同一 PowerShell 进程体系删除。 */
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
    if ([IO.Path]::GetDirectoryName($Target) -cne $Parent -or [IO.Path]::GetFileName($Target) -cnotlike 'test-bootstrap-*') { throw 'INVALID_CLEANUP_TARGET' }
    if ((Get-Item -LiteralPath $Target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'LINKED_CLEANUP_TARGET' }
    Remove-Item -LiteralPath $Target -Recurse -Force
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`,
      ],
      { encoding: 'utf8', timeout: 20_000 },
    );
    assert.equal(result.status, 0, `环境问题：无法清理隔离测试夹具。${result.stderr}`);
  } catch (error) {
    throw new Error('隔离初始化测试清理失败。', { cause: error });
  }
}

// Docker 的每一种可接受命令均由内存状态模拟；未列出的命令直接失败。
const mock = `
$script:Images = @{}
$script:Volumes = @{}
$script:Calls = [Collections.Generic.List[object]]::new()
$script:ImageId = 'sha256:' + ('a' * 64)
$script:ImageMajor = '17'
$script:Engine = 'local-test-engine'
$script:EngineHost = 'npipe:////./pipe/docker_engine'
$script:EngineOs = 'linux'
$script:NodeVersion = 'v24.22.1'
$script:PnpmVersion = '10.0.0'
$script:Failure = ''
$script:FailureAfterMutation = $false
$script:FailureVolume = ''
$script:Containers = ''

<# .SYNOPSIS 所有外部准备命令均由内存替身处理，未知命令一律阻断。 #>
function Invoke-TestBootstrapCommand {
    param([string]$Command, [string[]]$Arguments, [string]$Label)
    try {
        $script:Calls.Add(@{ command = $Command; arguments = @($Arguments); label = $Label })
        if ($Command -ceq $Node -and ($Arguments -join ' ') -ceq '--version') { return $script:NodeVersion }
        if ($Command -ceq 'fake-pnpm' -and ($Arguments -join ' ') -ceq '--version') { return $script:PnpmVersion }
        if ($Command -cne 'fake-docker' -or $Arguments[0] -cne '--context' -or $Arguments[1] -cne 'default') { throw 'FORBIDDEN_EXTERNAL_COMMAND' }
        if ($env:DOCKER_CONTEXT -cne 'default' -or $env:DOCKER_HOST -or $env:COMPOSE_PROJECT_NAME) { throw '实现错：Docker 命令继承了调用者环境覆盖' }
        $Parts = @($Arguments | Select-Object -Skip 2)
        $Operation = ($Parts | Select-Object -First 2) -join ' '
        $Fail = $script:Failure -and (($Parts -join ' ').StartsWith($script:Failure)) -and (-not $script:FailureVolume -or $Parts[-1] -ceq $script:FailureVolume)
        if ($Fail -and -not $script:FailureAfterMutation) { $script:Failure = ''; throw 'SIMULATED_COMMAND_FAILURE' }
        switch ($Operation) {
            'context inspect' { return '[{"Endpoints":{"docker":{"Host":"' + $script:EngineHost + '"}}}]' }
            'info --format' { return (@{ OSType = $script:EngineOs; ID = $script:Engine } | ConvertTo-Json -Compress) }
            'compose version' { return 'Docker Compose version v2.40.0' }
            'volume ls' { return (@($script:Volumes.Keys) -join "\n") }
            'ps -a' { return $script:Containers }
            'image inspect' {
                $Reference = $Parts[2]
                if (-not $script:Images.ContainsKey($Reference)) { throw 'SIMULATED_MISSING_IMAGE' }
                return (ConvertTo-Json -InputObject @(@{ Id = $script:Images[$Reference]; Config = @{ Env = @('PG_MAJOR=' + $script:ImageMajor) } }) -Depth 5 -Compress)
            }
            'image ls' {
                $Reference = $Parts[-1].Substring('reference='.Length)
                if ($script:Images.ContainsKey($Reference)) { return $script:Images[$Reference] }
                return ''
            }
            'image tag' {
                if (-not $script:Images.ContainsKey($Parts[2])) { throw 'SIMULATED_MISSING_SOURCE_IMAGE' }
                $script:Images[$Parts[3]] = $script:Images[$Parts[2]]
                if ($Fail) { $script:Failure = ''; throw 'SIMULATED_COMMAND_FAILURE' }
                return ''
            }
            'volume create' {
                $Name = $Parts[-1]
                if (-not $script:Volumes.ContainsKey($Name)) {
                    $Owner = @($Parts | Where-Object { $_ -clike 'sesame.bootstrap=*' })[0].Substring('sesame.bootstrap='.Length)
                    $script:Volumes[$Name] = @{ Name = $Name; Driver = 'local'; Options = $null;
                        Labels = @{ 'com.docker.compose.project' = 'sesame-notes-test'; 'sesame.bootstrap' = $Owner }; Data = 'preserved-user-data' }
                }
                if ($Fail) { $script:Failure = ''; throw 'SIMULATED_COMMAND_FAILURE' }
                return $Name
            }
            'volume inspect' {
                if (-not $script:Volumes.ContainsKey($Parts[2])) { throw 'SIMULATED_MISSING_VOLUME' }
                return (ConvertTo-Json -InputObject @($script:Volumes[$Parts[2]]) -Depth 5 -Compress)
            }
            default {
                if ($Parts[0] -ceq 'pull' -and $Parts[1] -clike 'docker.io/library/postgres*') {
                    $script:Images[$Parts[1]] = $script:ImageId
                    $script:Images[$script:ImageId] = $script:ImageId
                    return 'Pulled official test image'
                }
                throw ('FORBIDDEN_DOCKER_OPERATION:' + ($Parts -join ' '))
            }
        }
    } catch { throw }
}

<# .SYNOPSIS 以需求期望核对失败信息，未拒绝时标记实现错误。 #>
function Assert-Rejected {
    param([scriptblock]$Action, [string]$Pattern)
    try {
        $Rejected = $false
        try { & $Action } catch {
            $Rejected = $true
            if ($_.Exception.Message -notmatch $Pattern) { throw ('实现错或测试夹具错：失败原因不符合需求，期望 ' + $Pattern + '，实际 ' + $_.Exception.Message) }
        }
        if (-not $Rejected) { throw ('实现错：要求拒绝的操作被接受，期望 ' + $Pattern) }
    } catch { throw }
}

<# .SYNOPSIS 返回发生资源写入的命令，验证失败或幂等路径没有产生写入。 #>
function Get-Mutations {
    try {
        return @($script:Calls | Where-Object {
            $_.command -ceq 'fake-docker' -and ($_.arguments[2] -ceq 'pull' -or
                ($_.arguments[2] -ceq 'image' -and $_.arguments[3] -ceq 'tag') -or
                ($_.arguments[2] -ceq 'volume' -and $_.arguments[3] -ceq 'create'))
        })
    } catch { throw }
}
`;

/** 使用真实 PowerShell 和 Node 解析器运行隔离场景，Docker 与 pnpm 始终为内存替身。 */
function run(body) {
  const fixture = createFixture();
  try {
    const script = `
$ErrorActionPreference = 'Stop'
try {
    . ${quote(runtime)}
    . ${quote(bootstrap)}
    $ActualBootstrapCommand = (Get-Item Function:Invoke-TestBootstrapCommand).ScriptBlock
    $Root = ${quote(fixture)}
    $Node = ${quote(process.execPath)}
    $Runtime = Join-Path $Root 'Temp/test-environment'
    ${mock}
    ${body}
    Write-Output 'SCENARIO_PASS'
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); [Console]::Error.WriteLine($_.ScriptStackTrace); exit 1 }
`;
    const scriptFile = path.join(fixture, 'scenario.ps1');
    writeFileSync(scriptFile, script);
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scriptFile], {
      encoding: 'utf8',
      cwd: root,
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `隔离场景失败，需以需求诊断实现或夹具：${result.stderr}`);
    assert.match(result.stdout, /SCENARIO_PASS/);
    assert.doesNotMatch(result.stdout + result.stderr, /FORBIDDEN_/);
    return result.stdout + result.stderr;
  } catch (error) {
    throw new Error('首次测试环境初始化的隔离验证未通过。', { cause: error });
  } finally {
    cleanup(fixture);
  }
}

bootstrapTest('首次初始化创建独立配置、不可变镜像别名和两个归属卷，重复运行保留配置与数据', () => {
  run(`
    $env:DOCKER_HOST = 'tcp://private.invalid:2375'
    $env:COMPOSE_PROJECT_NAME = 'production-override'
    Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm'
    $Config = Read-TestEnvironment $Root $Node
    $Receipt = Read-TestBootstrapReceipt $Root $Config.values
    if (-not $Receipt.complete -or $Receipt.created.Count -ne 2 -or $script:Volumes.Count -ne 2) { throw '实现错：初始化缺少完整资源登记' }
    if ($Config.values.JWT_SECRET -ceq 'replace-with-at-least-32-random-bytes' -or $Config.values.JWT_SECRET.Length -lt 64) { throw '实现错：没有生成独立随机密钥' }
    if ($Config.values.POSTGRES_IMAGE_REVISION -cne ('a' * 64)) { throw '实现错：没有记录实际 Image ID' }
    if ($script:Images['sesame-notes-test-postgres:test-17-' + ('a' * 64)] -cne $script:ImageId) { throw '实现错：镜像别名不匹配' }
    if ($env:DOCKER_HOST -cne 'tcp://private.invalid:2375' -or $env:COMPOSE_PROJECT_NAME -cne 'production-override') { throw '实现错：未恢复调用者环境' }
    $Hash = (Get-FileHash (Join-Path $Root '.env.test')).Hash
    $script:Calls.Clear()
    Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm'
    if (@(Get-Mutations).Count -ne 0 -or (Get-FileHash (Join-Path $Root '.env.test')).Hash -cne $Hash) { throw '实现错：重复初始化改写身份或资源' }
    foreach ($Volume in $script:Volumes.Values) { if ($Volume.Data -cne 'preserved-user-data') { throw '实现错：已有数据被改写' } }
  `);
});

for (const operation of ['image tag', 'volume create']) {
  for (const afterMutation of [false, true]) {
    bootstrapTest(`${operation} ${afterMutation ? '写入后' : '写入前'}失败可恢复，配置与已创建资源保持不变`, () => {
      run(`
    $script:Failure = ${quote(operation)}
    $script:FailureAfterMutation = $${afterMutation ? 'true' : 'false'}
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } 'SIMULATED_COMMAND_FAILURE'
    $Hash = (Get-FileHash (Join-Path $Root '.env.test')).Hash
    $Config = Read-TestEnvironment $Root $Node
    $Owner = $Config.values.TEST_BOOTSTRAP_ID
    $script:Calls.Clear()
    Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm'
    if ((Get-FileHash (Join-Path $Root '.env.test')).Hash -cne $Hash -or $script:Volumes.Count -ne 2) { throw '实现错：恢复改写配置或未完成资源' }
    if (@($script:Calls | Where-Object { $_.arguments[2] -ceq 'pull' }).Count) { throw '实现错：恢复时重新拉取镜像' }
    foreach ($Volume in $script:Volumes.Values) {
        if ($Volume.Labels.'sesame.bootstrap' -cne $Owner -or $Volume.Data -cne 'preserved-user-data') { throw '实现错：恢复未保留归属或数据' }
    }
  `);
    });
  }
}

bootstrapTest('未知同名卷和已有测试容器阻止首次初始化且不触发写入', () => {
  run(`
    $script:Volumes['sesame-notes-test_pg_data'] = @{ Data = 'unknown-owner-data' }
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } '已有同名测试卷'
    if (@(Get-Mutations).Count -ne 0 -or $script:Volumes['sesame-notes-test_pg_data'].Data -cne 'unknown-owner-data') { throw '实现错：操作了未知数据卷' }
    $script:Volumes.Clear()
    $script:Containers = 'existing-container'
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } '已有测试项目容器'
    if (@(Get-Mutations).Count -ne 0) { throw '实现错：操作了已有测试环境' }
  `);
});

bootstrapTest('手工配置保持字节不变，已有私有值不被替换', () => {
  run(`
    Copy-Item -LiteralPath (Join-Path $Root '.env.test.example') -Destination (Join-Path $Root '.env.test')
    Add-Content -LiteralPath (Join-Path $Root '.env.test') -Value 'PRIVATE_USER_SETTING=preserve-this-value'
    $Hash = (Get-FileHash (Join-Path $Root '.env.test')).Hash
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } '已有 .env.test 未登记'
    if (@(Get-Mutations).Count -ne 0 -or (Get-FileHash (Join-Path $Root '.env.test')).Hash -cne $Hash) { throw '实现错：覆盖了手工配置' }
  `);
});

bootstrapTest('异身份镜像别名拒绝覆盖，不创建卷', () => {
  run(`
    $Alias = 'sesame-notes-test-postgres:test-17-' + ('a' * 64)
    $script:Images[$Alias] = 'sha256:' + ('b' * 64)
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } '镜像身份核验失败'
    if ($script:Images[$Alias] -cne ('sha256:' + ('b' * 64)) -or $script:Volumes.Count -ne 0) { throw '实现错：覆盖异身份镜像或继续创建卷' }
  `);
});

bootstrapTest('已登记卷丢失不创建替代空库，已有数据仍保留', () => {
  run(`
    Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm'
    $script:Volumes.Remove('sesame-notes-test_pg_data')
    $script:Calls.Clear()
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } '已登记测试卷.*缺失'
    if (@(Get-Mutations).Count -ne 0 -or $script:Volumes['sesame-notes-test_api_data'].Data -cne 'preserved-user-data') { throw '实现错：用空卷替换丢失的数据' }
  `);
});

bootstrapTest('既有卷归属更改或更换 Docker 引擎时拒绝继续', () => {
  run(`
    Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm'
    $script:Calls.Clear()
    $Volume = $script:Volumes['sesame-notes-test_pg_data']
    $Owner = $Volume.Labels.'sesame.bootstrap'
    $Volume.Labels.'sesame.bootstrap' = 'another-owner'
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } '归属或存储配置不符'
    $Volume.Labels.'sesame.bootstrap' = $Owner
    $script:Engine = 'another-engine'
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } 'Docker 引擎与初始化登记不符'
    if (@(Get-Mutations).Count -ne 0) { throw '实现错：复用了未知归属或其他引擎资源' }
  `);
});

bootstrapTest('依赖缺失在 Docker 操作前失败，绝不安装依赖', () => {
  run(`
    Remove-Item -LiteralPath (Join-Path $Root 'node_modules/.modules.yaml') -Force
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } '缺少项目依赖'
    if (@($script:Calls | Where-Object command -CEQ 'fake-docker').Count) { throw '实现错：依赖缺失仍操作 Docker' }
  `);
});

for (const [variable, value, pattern] of [
  ['NodeVersion', 'v22.0.0', '需要 Node.js'],
  ['PnpmVersion', '9.0.0', '需要 Node.js'],
  ['EngineHost', 'tcp://remote.invalid:2375', '必须指向本机'],
  ['EngineHost', 'npipe:////remote-host/pipe/docker_engine', '必须指向本机'],
  ['EngineOs', 'windows', '本机 Linux Docker Engine'],
  ['ImageMajor', '18', '镜像身份核验失败'],
]) {
  bootstrapTest(`${variable} 不符合要求时失败且不创建配置、卷或别名`, () => {
    run(`
    $script:${variable} = ${quote(value)}
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } ${quote(pattern)}
    if ((Test-Path -LiteralPath (Join-Path $Root '.env.test')) -or $script:Volumes.Count -ne 0 -or
        @($script:Calls | Where-Object { $_.arguments[2] -ceq 'image' -and $_.arguments[3] -ceq 'tag' }).Count) { throw '实现错：预检失败仍创建配置或资源' }
  `);
  });
}

bootstrapTest('镜像下载失败保留非零失败原因，重试可完成初始化', () => {
  run(`
    $script:Failure = 'pull'
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } 'SIMULATED_COMMAND_FAILURE'
    if ((Test-Path -LiteralPath (Join-Path $Root '.env.test')) -or $script:Volumes.Count -ne 0) { throw '实现错：下载失败仍写配置或建卷' }
    Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm'
    if ($script:Volumes.Count -ne 2) { throw '实现错：镜像恢复后没有完成初始化' }
  `);
});

bootstrapTest('第二个卷创建失败时保留第一个卷的数据，恢复仅创建未完成资源', () => {
  run(`
    $script:Failure = 'volume create'
    $script:FailureVolume = 'sesame-notes-test_api_data'
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } 'SIMULATED_COMMAND_FAILURE'
    if ($script:Volumes.Count -ne 1) { throw '实现错：没有保留已完成数据卷' }
    $script:Volumes['sesame-notes-test_pg_data'].Data = 'first-volume-important-data'
    $script:Calls.Clear()
    Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm'
    $Creates = @(Get-Mutations | Where-Object { $_.arguments[2] -ceq 'volume' })
    if ($Creates.Count -ne 1 -or $Creates[0].arguments[-1] -cne 'sesame-notes-test_api_data' -or
        $script:Volumes['sesame-notes-test_pg_data'].Data -cne 'first-volume-important-data') { throw '实现错：恢复重复创建或覆盖已有卷' }
  `);
});

bootstrapTest('命令包装器保留非零退出码及脱敏诊断，不保存成功 inspect 内容', () => {
  const output = run(`
    $null = New-Item -ItemType Directory -Path $Runtime -Force
    Assert-Rejected { & $ActualBootstrapCommand $Node @('-e', 'process.stderr.write("password=private-password-value\\nTOKEN=private-token-value\\npostgresql://user:private-db-value@host/db\\n");process.stderr.write(JSON.stringify({JWT_SECRET:"private-json-secret-value",POSTGRES_PASSWORD:"private-json-password-value",GITHUB_RELEASE_TOKEN:"private-json-token-value"}));process.exit(7)') '受控失败命令' } '退出码 7'
    $Log = Get-Content -LiteralPath (Join-Path $Runtime 'bootstrap.log') -Raw
    if ($Log -notmatch 'exit=7' -or $Log -notmatch '已脱敏' -or $Log -match 'private-(json-)?(password|secret|token|db)-value') { throw '实现错：命令日志丢失诊断或泄露凭据' }
    $Success = & $ActualBootstrapCommand $Node @('-e', 'process.stdout.write("inspect-private-content")') '读取成功结果'
    if ($Success -cne 'inspect-private-content') { throw '实现错：命令成功结果没有返回调用方' }
    if ((Get-Content -LiteralPath (Join-Path $Runtime 'bootstrap.log') -Raw) -match 'inspect-private-content') { throw '实现错：记录了成功 inspect 的私有内容' }
    $Inner = [InvalidOperationException]::new('{"JWT_SECRET":"private-inner-secret-value"}')
    $Outer = [InvalidOperationException]::new('受控日志失败', $Inner)
    $Failure = [Management.Automation.ErrorRecord]::new($Outer, 'controlled-failure', [Management.Automation.ErrorCategory]::InvalidOperation, $null)
    Write-TestFailure $Failure '受控启动'
    $FailureLog = Get-Content -LiteralPath (Join-Path $Runtime 'startup-error.log') -Raw
    if ($FailureLog -match 'private-inner-secret-value' -or $FailureLog -notmatch '已脱敏') { throw '实现错：完整异常日志泄露内部凭据' }
  `);
  assert.doesNotMatch(output, /private-(json-|inner-)?(password|secret|token|db)-value|inspect-private-content/);
});

bootstrapTest('启动前就绪校验拒绝未完成或缺失的收据，不调用 Docker 或创建资源', () => {
  run(`
    $script:Failure = 'image tag'
    Assert-Rejected { Initialize-TestEnvironment $Root $Node 'fake-docker' 'fake-pnpm' } 'SIMULATED_COMMAND_FAILURE'
    $Config = Read-TestEnvironment $Root $Node
    $script:Calls.Clear()
    Assert-Rejected { Assert-TestBootstrapReady $Root 'fake-docker' $Config.values } '首次初始化尚未完成'
    if ($script:Calls.Count -ne 0) { throw '实现错：未完成初始化时访问了 Docker' }
    Remove-Item -LiteralPath (Join-Path $Root '.env.test.bootstrap.json') -Force
    Assert-Rejected { Assert-TestBootstrapReady $Root 'fake-docker' $Config.values } '缺少初始化收据'
    if ($script:Calls.Count -ne 0) { throw '实现错：缺少收据时访问了 Docker' }
  `);
});

bootstrapTest('初始化命令缺少 Docker 时退出非零并给出恢复提示，不创建配置或资源', () => {
  const fixture = createFixture();
  try {
    for (const source of [
      'scripts/dev/init-test-environment.ps1',
      'scripts/lib/test-environment-runtime.ps1',
      'scripts/lib/test-environment-bootstrap.ps1',
    ]) {
      const destination = path.join(fixture, source);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(root, source), destination);
    }
    const entry = path.join(fixture, 'scripts/dev/init-test-environment.ps1');
    const scenario = path.join(fixture, 'missing-docker.ps1');
    writeFileSync(
      scenario,
      `
$ErrorActionPreference = 'Stop'
<# .SYNOPSIS 模拟工具发现时缺少 Docker，确保入口不能触达宿主 Docker。 #>
function Get-Command {
    param([string]$Name, [string]$ErrorAction)
    try {
        if ($Name -ceq 'node') { return [pscustomobject]@{ Source = ${quote(process.execPath)} } }
        if ($Name -ceq 'pnpm') { return [pscustomobject]@{ Source = 'fake-pnpm' } }
        if ($Name -ceq 'docker') { throw 'SIMULATED_DOCKER_NOT_INSTALLED' }
        throw 'FORBIDDEN_TOOL_DISCOVERY'
    } catch { throw }
}
try { & ${quote(entry)}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`,
    );
    const result = spawnSync('pwsh', ['-NoProfile', '-File', scenario], {
      encoding: 'utf8',
      cwd: fixture,
      timeout: 20_000,
    });
    assert.equal(result.status, 1, `实现错：缺少 Docker 时命令未返回非零。${result.stderr}`);
    assert.match(result.stderr, /SIMULATED_DOCKER_NOT_INSTALLED/);
    assert.match(result.stderr, /Docker Desktop/);
    assert.match(result.stderr, /pnpm dev:test:init/);
    assert.equal(existsSync(path.join(fixture, '.env.test')), false);
    assert.equal(existsSync(path.join(fixture, '.env.test.bootstrap.json')), false);
    assert.match(
      readFileSync(path.join(fixture, 'Temp/test-environment/bootstrap.log'), 'utf8'),
      /SIMULATED_DOCKER_NOT_INSTALLED/,
    );
  } catch (error) {
    throw new Error('缺少 Docker 的初始化入口隔离验证失败。', { cause: error });
  } finally {
    cleanup(fixture);
  }
});

for (const ready of [true, false]) {
  bootstrapTest(`日常 API 入口${ready ? '先核验登记再复用服务并恢复环境' : '核验失败时禁止复用或启动服务'}`, () => {
    const fixture = createFixture();
    try {
      const entry = path.join(fixture, 'scripts/dev/start-test-environment.ps1');
      const library = path.join(fixture, 'scripts/lib');
      mkdirSync(path.dirname(entry), { recursive: true });
      mkdirSync(library, { recursive: true });
      copyFileSync(path.join(root, 'scripts/dev/start-test-environment.ps1'), entry);
      writeFileSync(
        path.join(library, 'test-environment-runtime.ps1'),
        `${readFileSync(runtime, 'utf8')}
<# .SYNOPSIS 隔离测试没有真实登记进程。 #>
function Get-TestProcess { try { return $null } catch { throw } }
<# .SYNOPSIS 提供初始化环境标记以进入启动身份校验分支。 #>
function Read-TestEnvironment { try { return @{ fingerprint = 'fixture'; values = @{ TEST_BOOTSTRAP_ID = ('a' * 32); TEST_API_ORIGIN = 'http://127.0.0.1:8080' } } } catch { throw } }
<# .SYNOPSIS 工具发现仅返回无法执行的替身路径。 #>
function Get-Command { param($Name, $ErrorAction) try { return [pscustomobject]@{ Source = ('fake-' + $Name) } } catch { throw } }
<# .SYNOPSIS 记录复用服务的调用顺序，不能早于资源身份校验。 #>
function Get-SharedTestApi { try { Add-Content -LiteralPath $global:BootstrapCalls -Value 'reuse'; return @{ kind = 'node'; process = $null } } catch { throw } }
<# .SYNOPSIS 健康检查只记录调用，不连接网络。 #>
function Wait-TestReady { try { Add-Content -LiteralPath $global:BootstrapCalls -Value 'ready' } catch { throw } }
<# .SYNOPSIS 当前场景禁止执行构建、迁移或 Compose 启动命令。 #>
function Invoke-TestCommand { try { throw 'FORBIDDEN_STARTUP_COMMAND' } catch { throw } }
<# .SYNOPSIS 当前场景禁止创建任何真实服务进程。 #>
function Start-Process { try { throw 'FORBIDDEN_SERVICE_PROCESS' } catch { throw } }
`,
      );
      writeFileSync(
        path.join(library, 'test-environment-bootstrap.ps1'),
        `${readFileSync(bootstrap, 'utf8')}
<# .SYNOPSIS 验证启动入口先隔离环境再调用身份检查，并模拟检查结论。 #>
function Assert-TestBootstrapReady {
    param($Root, $Docker, $Values)
    try {
        if ($env:DOCKER_CONTEXT -cne 'default' -or $env:DOCKER_HOST -or $env:COMPOSE_PROJECT_NAME) { throw 'ENVIRONMENT_NOT_ISOLATED' }
        Add-Content -LiteralPath $global:BootstrapCalls -Value 'verify'
        if (-not $global:BootstrapReady) { throw 'SIMULATED_UNFINISHED_BOOTSTRAP' }
    } catch { throw }
}
`,
      );
      const scenario = path.join(fixture, 'handoff.ps1');
      writeFileSync(
        scenario,
        `
$ErrorActionPreference = 'Stop'
try {
    $global:BootstrapCalls = ${quote(path.join(fixture, 'handoff.log'))}
    $global:BootstrapReady = $${ready ? 'true' : 'false'}
    $env:DOCKER_HOST = 'tcp://original.invalid:2375'
    $env:COMPOSE_PROJECT_NAME = 'original-project'
    & ${quote(entry)}
    $StartupExit = $LASTEXITCODE
    if ($env:DOCKER_HOST -cne 'tcp://original.invalid:2375' -or $env:COMPOSE_PROJECT_NAME -cne 'original-project') { throw 'ENVIRONMENT_NOT_RESTORED' }
    if ($null -ne $StartupExit -and $StartupExit -ne 0) { exit $StartupExit }
    Write-Output 'HANDOFF_PASS'
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`,
      );
      const result = spawnSync('pwsh', ['-NoProfile', '-File', scenario], {
        encoding: 'utf8',
        cwd: fixture,
        timeout: 20_000,
      });
      assert.equal(result.status, ready ? 0 : 1, `实现错：日常启动未遵守初始化身份边界。${result.stderr}`);
      const calls = readFileSync(path.join(fixture, 'handoff.log'), 'utf8').trim().split(/\r?\n/);
      assert.deepEqual(calls, ready ? ['verify', 'reuse', 'ready'] : ['verify']);
      if (ready) assert.match(result.stdout, /HANDOFF_PASS/);
      else assert.match(result.stderr, /SIMULATED_UNFINISHED_BOOTSTRAP/);
      assert.doesNotMatch(result.stderr + result.stdout, /FORBIDDEN_/);
    } catch (error) {
      throw new Error('首次初始化与日常启动交接的隔离验证失败。', { cause: error });
    } finally {
      cleanup(fixture);
    }
  });
}
