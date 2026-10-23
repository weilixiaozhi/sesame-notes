<#
.SYNOPSIS
验证移动端同步往返：默认使用隔离临时后端；显式确认后可仅连接既有测试后端。
#>
[CmdletBinding()]
param(
    [string]$MobilePath = (Join-Path $PSScriptRoot '../../../sesame-notes-mobile'),
    [ValidateSet('isolated', 'existing-backend')][string]$Mode = 'isolated',
    [string]$BaseUrl,
    [switch]$ConfirmExistingBackend
)

$ErrorActionPreference = 'Stop'
$BackendPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$RunId = [guid]::NewGuid().ToString('N')
$RunDirectory = Join-Path $BackendPath "Temp/backend-roundtrip-$RunId"
$RunDirectoryCreated = $false
$ContainerId = $null
$ApiProcess = $null
$SavedEnvironment = @{}
$OriginalDirectory = Get-Location
$Failed = $false

<# .SYNOPSIS 执行已有工具并将非零退出转为失败，避免后续步骤误报通过。 #>
function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') 执行失败，退出码 $LASTEXITCODE。"
    }
}

# 既有测试服务由调用方管理。此分支必须在任何资源创建、环境修改或 finally 清理之前返回。
if ($Mode -eq 'existing-backend') {
    try {
        if (-not $ConfirmExistingBackend) { throw '既有测试模式必须传入 -ConfirmExistingBackend，并显式指定与 .env.test 中 TEST_API_ORIGIN 一致的 -BaseUrl。' }
        . (Join-Path $PSScriptRoot '../lib/test-environment-runtime.ps1')
        $Origins = Read-TestOrigins $BackendPath (Get-Command node -ErrorAction Stop).Source
        $TargetOrigin = Get-LocalTestOrigin $BaseUrl '-BaseUrl'
        if ($TargetOrigin -cne $Origins.TEST_API_ORIGIN) { throw '-BaseUrl 必须与 .env.test 中 TEST_API_ORIGIN 一致。' }
        $MobilePath = (Resolve-Path -LiteralPath $MobilePath).Path
        if (-not (Test-Path -LiteralPath (Join-Path $MobilePath 'e2e/real_backend_roundtrip_test.dart'))) {
            throw "移动端缺少真实后端往返测试：$MobilePath"
        }
        $null = Get-Command flutter -ErrorAction Stop
        Set-Location -LiteralPath $MobilePath
        Invoke-Checked flutter @(
            'test', 'e2e/real_backend_roundtrip_test.dart', '--no-pub',
            '--test-randomize-ordering-seed=random',
            '--dart-define=E2E_BACKEND_MODE=existing-backend',
            '--dart-define=E2E_EXISTING_BACKEND_CONFIRMED=true',
            "--dart-define=E2E_BASE_URL=$TargetOrigin",
            "--dart-define=E2E_EXPECTED_BACKEND_URL=$($Origins.TEST_API_ORIGIN)"
        )
    } catch {
        [Console]::Error.WriteLine("既有测试后端验证失败：$($_.Exception.Message)")
        [Console]::Error.WriteLine($_.Exception.ToString())
        [Console]::Error.WriteLine($_.ScriptStackTrace)
        throw
    } finally {
        Set-Location -LiteralPath $OriginalDirectory
    }
    return
}
if ($BaseUrl -or $ConfirmExistingBackend) {
    throw 'isolated 模式不接受外部地址或既有后端确认；它只能使用本轮创建的本机后端。'
}

try {
    $MobilePath = (Resolve-Path -LiteralPath $MobilePath).Path
    if (-not (Test-Path -LiteralPath (Join-Path $MobilePath 'e2e/real_backend_roundtrip_test.dart'))) {
        throw "移动端缺少真实后端往返测试：$MobilePath"
    }
    foreach ($Command in @('docker', 'pnpm', 'node', 'flutter')) {
        $null = Get-Command $Command -ErrorAction Stop
    }
    # 手动编排只使用已准备好的工具和镜像，不下载依赖或安装软件。
    Invoke-Checked docker @('image', 'inspect', 'postgres:17-alpine', '--format', '{{.Id}}')
    $null = New-Item -ItemType Directory -Path $RunDirectory
    $RunDirectoryCreated = $true
    $ContainerId = & docker run --pull=never --detach --rm --name "sesame-roundtrip-$RunId" `
        --publish '127.0.0.1::5432' --tmpfs /var/lib/postgresql/data `
        --env POSTGRES_USER=sesame --env POSTGRES_PASSWORD=sesame --env POSTGRES_DB=roundtrip postgres:17-alpine
    if ($LASTEXITCODE -ne 0 -or $ContainerId -notmatch '^[a-f0-9]{64}$') {
        $ContainerId = $null
        throw '无法创建本轮 PostgreSQL 容器，请确认 Docker 正常运行。'
    }
    $DatabasePort = (& docker port $ContainerId 5432/tcp) -replace '^127\.0\.0\.1:', ''
    if ($LASTEXITCODE -ne 0 -or $DatabasePort -notmatch '^\d+$') {
        throw '无法读取临时数据库端口。'
    }
    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
        & docker exec $ContainerId pg_isready -U sesame -d roundtrip *> $null
        if ($LASTEXITCODE -eq 0) { $Ready = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $Ready) { throw '临时 PostgreSQL 未能在 10 秒内就绪。' }

    # 环境变量仅指向本轮新建实例，建库命令不会连接开发或生产数据库。
    $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $Listener.Start()
        $ApiPort = $Listener.LocalEndpoint.Port
    } finally {
        $Listener.Stop()
    }
    $DatabaseUrl = "postgresql://sesame:sesame@127.0.0.1:$DatabasePort/roundtrip"
    $Environment = @{
        DATABASE_URL = $DatabaseUrl
        E2E_DATABASE_URL = $DatabaseUrl
        NODE_ENV = 'test'
        JWT_SECRET = "roundtrip-only-$RunId"
        STORAGE_PATH = (Join-Path $RunDirectory 'storage')
        HOST = '127.0.0.1'
        PORT = "$ApiPort"
        SYNC_RETENTION_MIN_CURSOR = '0'
        # 隔离实例需要密集执行双设备往返，限流边界由服务端专项测试验证。
        RATE_LIMIT_MAX = '10000'
        AUTH_RATE_LIMIT_MAX = '10000'
    }
    $SavedEnvironment = & {
        . (Join-Path $PSScriptRoot '../lib/test-environment-runtime.ps1')
        # 只将本轮配置交给隔离 API，避免继承生产来源、代理及部署身份。
        Set-TestEnvironment $Environment
    }
    Set-Location -LiteralPath $BackendPath
    Invoke-Checked pnpm @('--filter', '@sesame-notes/api', 'db:generate')
    Invoke-Checked pnpm @('--filter', '@sesame-notes/api', 'db:setup')
    Invoke-Checked pnpm @('--filter', '@sesame-notes/api', 'build')
    $StartOptions = @{
        FilePath = (Get-Command node).Source
        ArgumentList = @('apps/api/dist/server.js')
        WorkingDirectory = $BackendPath
        RedirectStandardOutput = (Join-Path $RunDirectory 'api.stdout.log')
        RedirectStandardError = (Join-Path $RunDirectory 'api.stderr.log')
        PassThru = $true
    }
    if ($IsWindows) { $StartOptions.WindowStyle = 'Hidden' }
    $ApiProcess = Start-Process @StartOptions
    $BaseUrl = "http://127.0.0.1:$ApiPort"
    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
        if ($ApiProcess.HasExited) { throw "API 启动失败，退出码 $($ApiProcess.ExitCode)。" }
        try {
            $Health = Invoke-RestMethod -Uri "$BaseUrl/api/v1/health/ready" -TimeoutSec 1
            if ($Health.status -eq 'ok') { $Ready = $true; break }
        } catch {
            if ($Attempt -eq 39) { throw "API 就绪检查失败：$($_.Exception.Message)" }
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $Ready) { throw 'API 未能就绪。' }
    Set-Location -LiteralPath $MobilePath
    Invoke-Checked flutter @('test', 'e2e/real_backend_roundtrip_test.dart', '--no-pub', '--test-randomize-ordering-seed=random', "--dart-define=E2E_BASE_URL=$BaseUrl")
    Write-Host '真实后端往返验证通过。'
} catch {
    $Failed = $true
    [Console]::Error.WriteLine("真实后端验证失败：$($_.Exception.Message)")
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    foreach ($Log in @('api.stdout.log', 'api.stderr.log')) {
        $LogPath = Join-Path $RunDirectory $Log
        if (Test-Path -LiteralPath $LogPath) { Get-Content -LiteralPath $LogPath -Tail 100 }
    }
    if ($ContainerId) { & docker logs --tail 50 $ContainerId }
} finally {
    Set-Location -LiteralPath $OriginalDirectory
    & {
        . (Join-Path $PSScriptRoot '../lib/test-environment-runtime.ps1')
        foreach ($Key in $SavedEnvironment.Keys) { Set-TestEnvironmentValue $Key $SavedEnvironment[$Key] }
    }
    try {
        if ($ApiProcess -and -not $ApiProcess.HasExited) {
            $ApiProcess.Kill($true)
            $ApiProcess.WaitForExit()
        }
        if ($ApiProcess) { $ApiProcess.Dispose() }
    } catch {
        $Failed = $true
        [Console]::Error.WriteLine("API 进程清理失败：$($_.Exception.Message)")
    }
    if ($ContainerId) {
        & docker rm --force $ContainerId
        if ($LASTEXITCODE -ne 0) { $Failed = $true }
    }
    try {
        # 失败时保留完整后端日志和测试存储，便于按实际现场排查；成功后才清理本轮临时文件。
        if (-not $Failed -and $RunDirectoryCreated -and (Test-Path -LiteralPath $RunDirectory)) {
            $ResolvedRun = (Resolve-Path -LiteralPath $RunDirectory).Path
            $TempRoot = [System.IO.Path]::GetFullPath((Join-Path $BackendPath 'Temp')) + [System.IO.Path]::DirectorySeparatorChar
            if (-not $ResolvedRun.StartsWith($TempRoot, [StringComparison]::OrdinalIgnoreCase) -or
                (Split-Path $ResolvedRun -Leaf) -ne "backend-roundtrip-$RunId") {
                throw '临时路径超出本轮工作目录，拒绝清理。'
            }
            if ($IsWindows) {
                # 只把本轮根与随机身份传给子进程；删除及重解析检查全部由 PS5.1 自己执行。
                $CleanupScript = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
        throw 'Roundtrip cleanup requires Windows PowerShell 5.1.'
    }
    $workspace = [IO.Path]::GetFullPath($env:SESAME_ROUNDTRIP_ROOT)
    $identity = $env:SESAME_ROUNDTRIP_RUN
    if ($identity -cnotmatch '^[a-f0-9]{32}$' -or
        -not [IO.Path]::IsPathRooted($workspace) -or
        -not [string]::Equals($workspace, $env:SESAME_ROUNDTRIP_ROOT, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Roundtrip cleanup requires an absolute workspace and this run identity.'
    }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($workspace, 'Temp'))
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($tempRoot, 'backend-roundtrip-' + $identity))
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($target), $tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Roundtrip cleanup is outside this run.'
    }
    $ancestors = New-Object 'System.Collections.Generic.List[string]'
    for ($current = $target; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        $ancestors.Insert(0, $current)
    }
    foreach ($path in $ancestors) {
        $entry = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if (-not $entry.PSIsContainer -or
            ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not [string]::Equals($entry.FullName, $path, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Roundtrip cleanup refuses linked or unresolved ancestors.'
        }
    }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($target)
    while ($pending.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
            $child = [IO.Path]::GetFullPath($entry.FullName)
            if (-not $child.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
                ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Roundtrip cleanup refuses linked or escaped descendants.'
            }
            if ($entry.PSIsContainer) { $pending.Push($child) }
        }
    }
    Write-Output ('[roundtrip cleanup] PowerShell ' + $PSVersionTable.PSVersion + '; remove: ' + $target)
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
'@
                $CleanupStart = [System.Diagnostics.ProcessStartInfo]::new()
                $CleanupStart.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
                if (-not [IO.Path]::IsPathRooted($CleanupStart.FileName)) {
                    throw 'PowerShell 5.1 入口必须是绝对路径。'
                }
                $CleanupStart.UseShellExecute = $false
                $CleanupStart.CreateNoWindow = $true
                foreach ($Argument in @('-NoProfile', '-NonInteractive', '-Command', $CleanupScript)) {
                    $CleanupStart.ArgumentList.Add($Argument)
                }
                $CleanupStart.Environment['SESAME_ROUNDTRIP_ROOT'] = $BackendPath
                $CleanupStart.Environment['SESAME_ROUNDTRIP_RUN'] = $RunId
                $CleanupProcess = [System.Diagnostics.Process]::Start($CleanupStart)
                try {
                    $CleanupProcess.WaitForExit()
                    if ($CleanupProcess.ExitCode -ne 0) {
                        throw "PowerShell 5.1 本轮目录清理失败，退出码 $($CleanupProcess.ExitCode)。"
                    }
                } finally {
                    $CleanupProcess.Dispose()
                }
            } else {
                Remove-Item -LiteralPath $ResolvedRun -Recurse -Force
            }
        }
    } catch {
        $Failed = $true
        [Console]::Error.WriteLine("临时文件清理失败：$($_.Exception.Message)")
    }
}
if ($Failed) {
    if ($RunDirectoryCreated) { [Console]::Error.WriteLine("本轮详细日志已保留：$RunDirectory") }
    exit 1
}
