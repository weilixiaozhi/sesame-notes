<#
.SYNOPSIS
使用本机 Edge 执行真实验收；可显式复用已确认测试服务，或使用隔离模式。
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 100)][int]$MaxFailures = 0,
    [ValidateSet('isolated', 'existing-backend')][string]$Mode = 'isolated',
    [string]$ExistingApiOrigin = '',
    [string]$ExistingWebOrigin = '',
    [switch]$ConfirmExistingBackend,
    [ValidateSet('127.0.0.1','127.0.0.2')][string]$WebHost = '127.0.0.1',
    [string[]]$TestFiles = @()
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$RunId = [guid]::NewGuid().ToString('N')
$RunDirectory = Join-Path $Root "Temp/web-e2e-$RunId"
$DatabaseName = "web_e2e_$RunId"
$ContainerName = "sesame-web-e2e-$RunId"
$ContainerId = $null
$ApiProcess = $null
$WebProcess = $null
$Saved = @{}
$OriginalDirectory = Get-Location
$Failed = $false
$Docker = $null

<# .SYNOPSIS 查找已安装工具，绝不自行下载安装。 #>
function Resolve-Tool {
    param([string]$Name, [System.Collections.IDictionary]$Candidates)
    try {
        $Found = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($Found) { return $Found.Source }
        # 只有 PATH 未提供工具时才读取安装目录；未配置的目录不能参与路径拼接。
        foreach ($Location in $Candidates.GetEnumerator()) {
            $Base = [Environment]::GetEnvironmentVariable($Location.Key, 'Process')
            if ([string]::IsNullOrWhiteSpace($Base)) { continue }
            $Candidate = Join-Path $Base $Location.Value
            if (Test-Path -LiteralPath $Candidate -PathType Leaf) { return $Candidate }
        }
        throw "未找到已安装的 $Name，验收被阻塞。"
    } catch { throw [InvalidOperationException]::new("工具查找失败：$($_.Exception.Message)", $_.Exception) }
}
<# .SYNOPSIS 原生子命令失败必须使验收失败。 #>
function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command 执行失败，退出码 $LASTEXITCODE。" }
}
<# .SYNOPSIS 获取随机回环端口，服务启动失败时不回落默认端口。 #>
function Get-TestPort {
    $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try { $Listener.Start(); return $Listener.LocalEndpoint.Port } finally { $Listener.Stop() }
}
<# .SYNOPSIS 短轮询检查测试服务与进程，启动失败时保留明确原因。 #>
function Wait-Service {
    param([System.Diagnostics.Process]$Process, [string]$Url, [switch]$Api)
    for ($Attempt = 0; $Attempt -lt 80; $Attempt++) {
        if ($Process.HasExited) { throw "服务提前退出 $($Process.ExitCode)：$Url" }
        try {
            if ($Api) { if ((Invoke-RestMethod -Uri $Url -TimeoutSec 1).status -eq 'ok') { return } }
            elseif ((Invoke-WebRequest -Uri $Url -TimeoutSec 1).StatusCode -eq 200) { return }
        } catch { if ($Attempt -eq 79) { throw "服务未就绪：$Url；$($_.Exception.Message)" } }
        Start-Sleep -Milliseconds 250
    }
    throw "服务未在限定时间内就绪：$Url"
}
<# .SYNOPSIS 只停止本次保存的进程对象及其子进程。 #>
function Stop-TestProcess {
    param([System.Diagnostics.Process]$Process)
    if ($Process) {
        try { if (-not $Process.HasExited) { $Process.Kill($true); $Process.WaitForExit() } }
        finally { $Process.Dispose() }
    }
}
<# .SYNOPSIS 对本轮生产源码和契约记录逐文件指纹，不读取凭证或环境文件。 #>
function Get-SourceSnapshot {
    $SourceFiles = @()
    foreach ($Relative in @('apps/web/src', 'apps/web/e2e', 'apps/api/src', 'packages/api-client/src', 'apps/api/prisma/migrations')) {
        $Directory = Join-Path $Root $Relative
        $SourceFiles += Get-ChildItem -LiteralPath $Directory -File -Recurse
    }
    foreach ($Relative in @('packages/api-contract/openapi.json', 'packages/api-contract/compatibility-baseline.json', 'packages/api-contract/fitness-catalog.json', 'apps/api/prisma/schema.prisma', 'apps/api/prisma/setup.mjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'tsconfig.json', 'apps/web/package.json', 'apps/web/index.html', 'apps/web/vite.config.ts', 'apps/web/playwright.config.ts', 'apps/api/package.json', 'packages/api-client/package.json', 'scripts/dev/test-web-backend.ps1')) {
        $SourceFiles += Get-Item -LiteralPath (Join-Path $Root $Relative)
    }
    $Entries = @($SourceFiles | Sort-Object FullName -Unique | ForEach-Object {
        [ordered]@{ path = [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
    })
    $Head = & git -C $Root rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $Head -notmatch '^[a-f0-9]{40}$') { throw '无法读取源码基准 HEAD。' }
    return [ordered]@{ head = $Head; files = $Entries }
}
try {
    # 只接受现有测试文件名，防止选择参数被当作额外命令选项或仓库外路径。
    foreach ($TestFile in $TestFiles) {
        if ($TestFile -cnotmatch '^[a-z0-9-]+\.spec\.ts$' -or
            -not (Test-Path -LiteralPath (Join-Path $Root "apps/web/e2e/$TestFile") -PathType Leaf)) {
            throw "测试文件无效：$TestFile"
        }
    }
    $Pnpm = Resolve-Tool pnpm ([ordered]@{ APPDATA = 'npm/pnpm.cmd' })
    $Node = Resolve-Tool node ([ordered]@{ ProgramFiles = 'nodejs/node.exe' })
    $null = Resolve-Tool msedge ([ordered]@{ 'ProgramFiles(x86)' = 'Microsoft/Edge/Application/msedge.exe'; ProgramFiles = 'Microsoft/Edge/Application/msedge.exe' })
    if ($Mode -eq 'existing-backend') {
        if (-not $ConfirmExistingBackend) { throw '既有模式必须传入 -ConfirmExistingBackend，明确同意向本地配置的测试服务写入合成测试账号。' }
        # 子作用域仅返回来源配置，避免覆盖本脚本的进程清理函数。
        $Origins = & { . (Join-Path $PSScriptRoot '../lib/test-environment-runtime.ps1'); Read-TestOrigins $Root $Node }
        if ($ExistingApiOrigin -cne $Origins.TEST_API_ORIGIN -or $ExistingWebOrigin -cne $Origins.TEST_WEB_ORIGIN) {
            throw '既有服务必须显式提供与 .env.test 中 TEST_API_ORIGIN、TEST_WEB_ORIGIN 完全一致的来源。'
        }
    } elseif ($ExistingApiOrigin -or $ExistingWebOrigin -or $ConfirmExistingBackend) { throw '既有服务参数只能与 -Mode existing-backend 一起使用。' }
    $null = New-Item -ItemType Directory -Path $RunDirectory
    Set-Location -LiteralPath $Root
    $SourceSnapshot = Get-SourceSnapshot
    $SourceSnapshot | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $RunDirectory 'source-snapshot.json') -Encoding utf8
    if ($Mode -eq 'existing-backend') {
        # 不读取、伪造或使用数据库连接，不初始化、不构建、不启停共享服务。
        $ApiOrigin = $ExistingApiOrigin
        $WebOrigin = $ExistingWebOrigin
        $Environment = @{
            WEB_E2E_MODE = $Mode; WEB_API_TARGET = $ApiOrigin; WEB_E2E_BASE_URL = $WebOrigin
            WEB_E2E_EXISTING_API_ORIGIN = $ApiOrigin; WEB_E2E_EXISTING_WEB_ORIGIN = $WebOrigin
            WEB_E2E_EXISTING_BACKEND_CONFIRMED = 'true'
            WEB_E2E_EXPECTED_API_ORIGIN = $Origins.TEST_API_ORIGIN; WEB_E2E_EXPECTED_WEB_ORIGIN = $Origins.TEST_WEB_ORIGIN
            WEB_E2E_RUN_ID = $RunId; WEB_E2E_ARTIFACTS = $RunDirectory
        }
        foreach ($Key in $Environment.Keys) {
            $Saved[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process')
            [Environment]::SetEnvironmentVariable($Key, $Environment[$Key], 'Process')
        }
        foreach ($Url in @("$ApiOrigin/api/v1/health/ready", "$WebOrigin/api/v1/health/ready")) {
            if ((Invoke-RestMethod -Uri $Url -TimeoutSec 10).status -ne 'ok') { throw "既有测试目标未就绪：$Url" }
        }
        if ((Invoke-WebRequest -Uri $WebOrigin -TimeoutSec 10).StatusCode -ne 200) { throw '既有测试 Web 不可用。' }
        @{
            mode = $Mode; run_id = $RunId; web_url = $WebOrigin; api_url = $ApiOrigin
            started_at = [DateTime]::UtcNow.ToString('O'); workers = 1
            manages_services = $false; manages_database = $false
            source_verification_scope = 'local-source-only; deployed build provenance must be recorded by deployment owner'
            test_data_policy = 'new synthetic accounts only; no account cleanup; test-data-identities.jsonl contains UUIDs only'
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RunDirectory 'environment.json') -Encoding utf8
    } else {
        $Docker = Resolve-Tool docker ([ordered]@{ LOCALAPPDATA = 'Programs/DockerDesktop/resources/bin/docker.exe'; ProgramFiles = 'Docker/Docker/resources/bin/docker.exe' })
        # 引擎故障时超时退出，不无限等待、不创建或接触任何既有数据库。
        $Check = Start-Process -FilePath $Docker -ArgumentList @('image', 'inspect', 'postgres:17-alpine', '--format', '{{.Id}}') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $RunDirectory 'docker-check.stdout.log') -RedirectStandardError (Join-Path $RunDirectory 'docker-check.stderr.log')
        try {
            if (-not $Check.WaitForExit(15000)) { $Check.Kill($true); throw 'Docker 引擎检查超时。请先恢复 Docker；未运行数据库初始化。' }
            if ($Check.ExitCode -ne 0) { throw 'Docker 未就绪或 postgres:17-alpine 未缓存；验收被阻塞，未拉取镜像。' }
        } finally { $Check.Dispose() }
        $ContainerId = & $Docker run --pull=never --detach --rm --name $ContainerName --publish '127.0.0.1::5432' --tmpfs /var/lib/postgresql/data --env POSTGRES_USER=sesame --env POSTGRES_PASSWORD=sesame --env "POSTGRES_DB=$DatabaseName" postgres:17-alpine
        if ($LASTEXITCODE -ne 0 -or $ContainerId -notmatch '^[a-f0-9]{64}$') { $ContainerId = $null; throw '无法创建本次隔离 PostgreSQL。' }
        $DatabasePort = (& $Docker port $ContainerId 5432/tcp) -replace '^127\.0\.0\.1:', ''
        if ($LASTEXITCODE -ne 0 -or $DatabasePort -notmatch '^\d+$') { throw '无法读取隔离数据库回环端口。' }
        $Ready = $false
        for ($Attempt = 0; $Attempt -lt 80; $Attempt++) {
            & $Docker exec $ContainerId pg_isready -U sesame -d $DatabaseName *> $null
            if ($LASTEXITCODE -eq 0) { $Ready = $true; break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $Ready) { throw '隔离 PostgreSQL 未就绪。' }
        $ApiPort = Get-TestPort
        $WebPort = Get-TestPort
        while ($WebPort -eq $ApiPort) { $WebPort = Get-TestPort }
        $ApiOrigin = "http://127.0.0.1:$ApiPort"
        $WebOrigin = "http://{0}:{1}" -f $WebHost, $WebPort
        $DatabaseUrl = "postgresql://sesame:sesame@127.0.0.1:$DatabasePort/$DatabaseName"
        $Environment = @{
            DATABASE_URL = $DatabaseUrl; E2E_DATABASE_URL = $DatabaseUrl
            NODE_ENV = 'test'; JWT_SECRET = "web-e2e-only-$RunId"
            STORAGE_PATH = (Join-Path $RunDirectory 'storage')
            HOST = '127.0.0.1'; PORT = "$ApiPort"; CORS_ORIGINS = $WebOrigin
            WEB_E2E_MODE = 'isolated'; WEB_API_TARGET = $ApiOrigin; WEB_E2E_BASE_URL = $WebOrigin
            WEB_E2E_RUN_ID = $RunId; WEB_E2E_ARTIFACTS = $RunDirectory
            ACCESS_TOKEN_TTL = '8'; AUTH_RATE_LIMIT_MAX = '10000'; RATE_LIMIT_MAX = '10000'; SYNC_RETENTION_MIN_CURSOR = '0'
        }
        $Saved = & {
            . (Join-Path $PSScriptRoot '../lib/test-environment-runtime.ps1')
            # 隔离库使用独立名称，必须清除终端中的部署身份和未显式指定的 API 配置。
            Set-TestEnvironment $Environment
        }
        Set-Location -LiteralPath $Root
        # Prisma 客户端由项目安装/统一生成步骤准备，避免并行测试时重写 Windows 已加载的引擎 DLL。
        Invoke-Checked $Node @('apps/api/prisma/setup.mjs')
        Invoke-Checked $Pnpm @('--filter', '@sesame-notes/api', 'exec', 'tsc', '-p', 'tsconfig.build.json')
        Invoke-Checked $Pnpm @('--filter', '@sesame-notes/api-client', 'exec', 'tsc', '-p', 'tsconfig.build.json')
        $ApiProcess = Start-Process -FilePath $Node -ArgumentList @('apps/api/dist/server.js') -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $RunDirectory 'api.stdout.log') -RedirectStandardError (Join-Path $RunDirectory 'api.stderr.log')
        Wait-Service $ApiProcess "$ApiOrigin/api/v1/health/ready" -Api
        # 每轮生成独立静态包，避免并行编辑触发 HMR 干扰真实验收，同时验证可发布产物。
        $WebBuild = Join-Path $RunDirectory 'web-dist'
        if (Test-Path -LiteralPath $WebBuild) { throw '本轮静态产物目录应当尚不存在' }
        $env:NODE_ENV = 'production'
        try { Invoke-Checked $Pnpm @('--filter', '@sesame-notes/web', 'exec', 'vite', 'build', '--outDir', $WebBuild) }
        finally { $env:NODE_ENV = 'test' }
        $WebProcess = Start-Process -FilePath $Node -ArgumentList @('node_modules/vite/bin/vite.js', 'preview', '--outDir', "`"$WebBuild`"", '--host', $WebHost, '--port', "$WebPort", '--strictPort') -WorkingDirectory (Join-Path $Root 'apps/web') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $RunDirectory 'web.stdout.log') -RedirectStandardError (Join-Path $RunDirectory 'web.stderr.log')
        Wait-Service $WebProcess $WebOrigin
        @{
            run_id = $RunId; web_url = $WebOrigin; api_url = $ApiOrigin
            build_directory = $WebBuild; built_at = [DateTime]::UtcNow.ToString('O')
            web_index_sha256 = (Get-FileHash -LiteralPath (Join-Path $WebBuild 'index.html') -Algorithm SHA256).Hash
            container_id = $ContainerId; container_name = $ContainerName; docker = $Docker
            processes = @(
                @{ id = $ApiProcess.Id; started = $ApiProcess.StartTime.ToUniversalTime().ToString('O') },
                @{ id = $WebProcess.Id; started = $WebProcess.StartTime.ToUniversalTime().ToString('O') }
            )
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RunDirectory 'environment.json') -Encoding utf8
    }
    Invoke-Checked $Pnpm (@('--filter', '@sesame-notes/web', 'test:e2e', '--max-failures', "$MaxFailures", '--workers', '1') + $TestFiles)
    Write-Host "真实浏览器验收通过；报告：$(Join-Path $RunDirectory 'html-report/index.html')"
    $AfterSource = Get-SourceSnapshot
    $BeforeJson = $SourceSnapshot | ConvertTo-Json -Depth 6 -Compress
    $AfterJson = $AfterSource | ConvertTo-Json -Depth 6 -Compress
    if ($BeforeJson -ne $AfterJson) { throw '验收期间生产源码或契约发生变化；当前报告不能作为最终版本验收，必须重新构建。' }
    @{ checked_at = [DateTime]::UtcNow.ToString('O'); files = $SourceSnapshot.files.Count; head = $SourceSnapshot.head; identical = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDirectory 'source-verification.json') -Encoding utf8

} catch {
    $Failed = $true
    [Console]::Error.WriteLine("真实验收失败或被阻塞：$($_.Exception.Message)")
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    foreach ($Log in @('docker-check.stderr.log', 'api.stderr.log', 'web.stderr.log')) {
        $LogPath = Join-Path $RunDirectory $Log
        if (Test-Path -LiteralPath $LogPath) { Get-Content -LiteralPath $LogPath -Tail 40 }
    }
} finally {
    Set-Location -LiteralPath $OriginalDirectory
    & {
        . (Join-Path $PSScriptRoot '../lib/test-environment-runtime.ps1')
        foreach ($Key in $Saved.Keys) { Set-TestEnvironmentValue $Key $Saved[$Key] }
    }
    # 每项资源独立清理，停止一个进程失败仍继续回收其余进程和本轮容器。
    foreach ($Process in @($WebProcess, $ApiProcess)) {
        try { Stop-TestProcess $Process }
        catch { $Failed = $true; [Console]::Error.WriteLine("停止本次进程失败：$($_.Exception.Message)") }
    }
    if ($ContainerId) {
        try {
            $Actual = & $Docker inspect --format '{{.Name}}' $ContainerId
            if ($LASTEXITCODE -eq 0 -and $Actual -eq "/$ContainerName") {
                & $Docker rm --force $ContainerId
                if ($LASTEXITCODE -ne 0) { $Failed = $true; [Console]::Error.WriteLine('清理本次测试容器失败。') }
            } else { $Failed = $true; [Console]::Error.WriteLine('测试容器身份核验失败，未执行删除。') }
        } catch { $Failed = $true; [Console]::Error.WriteLine("清理本次测试容器失败：$($_.Exception.Message)") }
    }

}
if ($Failed) { exit 1 }
