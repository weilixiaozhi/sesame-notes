<# .SYNOPSIS 统一管理共用测试 API、Web 验收页与 Admin 页面，各组件只操作自身登记的进程。 #>
[CmdletBinding()]
param(
    [ValidateSet('api', 'web', 'admin')][string]$Component = 'api',
    [switch]$Rebuild,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$Runtime = Join-Path $Root $(if ($Component -eq 'web') { 'Temp/web-preview' } else { 'Temp/test-environment' })
$StatePath = Join-Path $Runtime "$Component-process.json"
$Label = @{ api = '共用测试 API'; web = 'Web 验收页面'; admin = 'Admin 页面' }[$Component]
$SavedEnvironment = @{}
$SavedDockerEnvironment = @{}
$Started = $null

try {
    . (Join-Path $PSScriptRoot '../lib/test-environment-runtime.ps1')
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 运行本脚本。' }
    $null = New-Item -ItemType Directory -Path $Runtime -Force
    $Managed = Get-TestProcess $StatePath $Component
    if ($Stop) {
        Stop-TestProcess $Managed $StatePath $Component
        Write-Host "$Label 已停止；其他组件及共用数据库继续由各自入口管理。"
        return
    }
    $Node = (Get-Command node -ErrorAction Stop).Source
    $Pnpm = (Get-Command pnpm -ErrorAction Stop).Source
    $Config = Read-TestEnvironment $Root $Node
    if ($Component -eq 'api') {
        $Docker = (Get-Command docker -ErrorAction Stop).Source
        if ($Config.values.TEST_BOOTSTRAP_ID -or (Test-Path -LiteralPath (Join-Path $Root '.env.test.bootstrap.json'))) {
            . (Join-Path $PSScriptRoot '../lib/test-environment-bootstrap.ps1')
            $SavedDockerEnvironment = Set-TestDockerEnvironment
            Assert-TestBootstrapReady $Root $Docker $Config.values
        }
        if (-not ($Managed -and $Rebuild)) {
            $Api = Get-SharedTestApi $Config.fingerprint
            if ($Api) {
                if ($Rebuild) { throw '现有共用 API 由 Docker Compose 管理，请通过 Compose 更新该 API。' }
                Wait-TestReady 'http://127.0.0.1:8080/api/v1/health/ready' $Api.process
                Write-Host "共用测试 API 已运行：$($Config.values.TEST_API_ORIGIN)/。"
                return
            }
        }
        Assert-TestPort 8080 @($Managed.process.Id)
        $SavedEnvironment = Set-TestEnvironment $Config.values
        if ($SavedDockerEnvironment.Count) {
            # 配置加载后再次隔离 Docker/Compose 覆盖，保证与初始化使用同一引擎和项目。
            $null = Set-TestDockerEnvironment
        }
        $Compose = Get-TestComposeArguments $Root
        Assert-TestComposeConfiguration $Docker $Compose $Config.values
        # external 卷和本地镜像必须已准备好，启动入口不能创建另一套空库或拉取新镜像。
        Invoke-TestCommand $Docker @('volume', 'inspect', 'sesame-notes-test_pg_data', '--format', '{{.Name}}') '核验共用测试数据库卷'
        if ($Config.values.POSTGRES_IMAGE_REVISION -cnotmatch '^[a-f0-9]{64}$') { throw '.env.test 缺少有效的 POSTGRES_IMAGE_REVISION 本地镜像身份。' }
        Invoke-TestCommand $Docker @('image', 'inspect', "sesame-notes-test-postgres:test-17-$($Config.values.POSTGRES_IMAGE_REVISION)", '--format', '{{.Id}}') '核验已准备的 PostgreSQL 镜像'
        $ExistingIds = @(& $Docker @Compose ps --all --quiet postgres)
        if ($LASTEXITCODE -ne 0) { throw '无法检查共用 PostgreSQL 容器。' }
        foreach ($Id in $ExistingIds) {
            $Details = (& $Docker inspect $Id | ConvertFrom-Json)[0]
            if ($LASTEXITCODE -ne 0) { throw '无法读取共用 PostgreSQL 容器配置。' }
            Assert-TestDatabaseContainer $Details
        }
        Invoke-TestCommand $Docker ($Compose + @('up', '--detach', '--no-deps', '--no-build', '--pull', 'never', '--wait', 'postgres')) '启动共用测试 PostgreSQL'
        Stop-TestProcess $Managed $StatePath 'api'
        Assert-TestPort 8080
        Push-Location -LiteralPath $Root
        try {
            if ($Rebuild -or -not (Test-Path -LiteralPath (Join-Path $Root 'apps/api/dist/server.js'))) {
                Invoke-TestCommand $Pnpm @('--filter', '@sesame-notes/api', 'db:generate') '生成 Prisma 客户端'
                Invoke-TestCommand $Pnpm @('--filter', '@sesame-notes/api', 'build') '构建共用测试 API'
            }
            Invoke-TestCommand $Node @('apps/api/prisma/setup.mjs', '--test-admin') '迁移测试数据库并初始化测试超管'
        } finally { Pop-Location }
        $Started = Start-TestProcess 'api' @('apps/api/dist/server.js') $Root $StatePath $Config.fingerprint
        Wait-TestReady 'http://127.0.0.1:8080/api/v1/health/ready' $Started
        $null = Get-SharedTestApi $Config.fingerprint
        Write-Host "共用测试环境已就绪：API $($Config.values.TEST_API_ORIGIN)/；数据库 localhost:55432/sesame_notes_test。"
    } else {
        $Origin = if ($Component -eq 'web') { $Config.values.TEST_WEB_ORIGIN } else { 'http://localhost:55174' }
        if ($Component -eq 'admin' -and $Origin -cnotin @(([string]$Config.values.ADMIN_ORIGINS).Split(',').Trim())) {
            throw '.env.test 的 ADMIN_ORIGINS 必须包含 http://localhost:55174。'
        }
        $Address = [Uri]$Origin
        $ListenHost = if ($Component -eq 'web') { $Address.Host } else { '127.0.0.1' }
        $HealthOrigin = if ($Component -eq 'web') { $Origin } else { 'http://127.0.0.1:55174' }
        $Api = Get-SharedTestApi $Config.fingerprint
        if (-not $Api) { throw '共用测试 API 尚未启动，请先运行 pnpm dev:test。' }
        Wait-TestReady 'http://127.0.0.1:8080/api/v1/health/ready' $Api.process
        if ($Managed -and -not $Rebuild) {
            if ($Managed.state.fingerprint -cne $Config.fingerprint) { throw ".env.test 已变更，请使用 -Rebuild 重启 $Label。" }
            Assert-TestPort $Address.Port @($Managed.process.Id)
            Wait-TestReady "$HealthOrigin/api/v1/health/ready" $Managed.process
            Write-Host "$Label 已运行：$Origin/。"
            return
        }
        Assert-TestPort $Address.Port @($Managed.process.Id)
        if (-not (Test-Path -LiteralPath (Join-Path $Root "apps/$Component/node_modules/vite/bin/vite.js"))) {
            throw "缺少已安装的 $Component 依赖，请先核对依赖准备情况。"
        }
        Stop-TestProcess $Managed $StatePath $Component
        Assert-TestPort $Address.Port
        # 页面共享进程管理，但 Web 构建产物验收与 Admin 开发服务采用各自的运行模式。
        if ($Component -eq 'web') {
            $SavedEnvironment = Set-TestEnvironment $Config.values
            $env:WEB_API_TARGET = 'http://127.0.0.1:8080'
        } else {
            foreach ($Key in @('ADMIN_API_TARGET', 'NODE_ENV')) {
                $SavedEnvironment[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process')
            }
            $env:ADMIN_API_TARGET = 'http://127.0.0.1:8080'
            $env:NODE_ENV = 'development'
        }
        $BuildTarget = if ($Component -eq 'web') { 'apps/web/dist/index.html' } else { 'packages/api-client/dist/index.js' }
        if ($Rebuild -or -not (Test-Path -LiteralPath (Join-Path $Root $BuildTarget))) {
            Push-Location -LiteralPath $Root
            try {
                if ($Component -eq 'web') { $env:NODE_ENV = 'production' }
                Invoke-TestCommand $Pnpm @('--filter', '@sesame-notes/api-client', 'build') '构建共享 API 客户端'
                if ($Component -eq 'web') { Invoke-TestCommand $Pnpm @('--filter', '@sesame-notes/web', 'build') '构建 Web' }
            } finally { Pop-Location }
        }
        $Arguments = @('node_modules/vite/bin/vite.js')
        if ($Component -eq 'web') { $Arguments += 'preview' }
        $Arguments += @('--host', $ListenHost, '--port', "$($Address.Port)", '--strictPort')
        $Started = Start-TestProcess $Component $Arguments (Join-Path $Root "apps/$Component") $StatePath $Config.fingerprint
        Wait-TestReady "$HealthOrigin/api/v1/health/ready" $Started
        Write-Host "$Label 已就绪：$Origin/；共用测试 API：$($Config.values.TEST_API_ORIGIN)/。"
    }
} catch {
    $Failure = $_
    if ($Started) {
        try { Stop-TestProcess (Get-TestProcess $StatePath $Component) $StatePath $Component }
        catch { [Console]::Error.WriteLine("清理失败的 $Label 进程失败：$($_.Exception.Message)") }
    }
    Write-TestFailure $Failure "$Label 启动"
    exit 1
} finally {
    foreach ($Key in $SavedEnvironment.Keys) { Set-TestEnvironmentValue $Key $SavedEnvironment[$Key] }
    foreach ($Key in $SavedDockerEnvironment.Keys) { Set-TestEnvironmentValue $Key $SavedDockerEnvironment[$Key] }
}
