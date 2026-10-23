<# .SYNOPSIS 为新 clone 准备独立测试资源；不启动服务，不覆盖配置或已有数据。 #>
[CmdletBinding()]
param([string]$PostgresImage = 'docker.io/library/postgres:17-alpine')

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$Runtime = Join-Path $Root 'Temp/test-environment'
$PathsVerified = $false
try {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7 运行本脚本。' }
    . (Join-Path $PSScriptRoot '../lib/test-environment-runtime.ps1')
    . (Join-Path $PSScriptRoot '../lib/test-environment-bootstrap.ps1')
    Assert-TestBootstrapPaths $Root
    $PathsVerified = $true
    $null = New-Item -ItemType Directory -Path $Runtime -Force
    $Node = (Get-Command node -ErrorAction Stop).Source
    $Pnpm = (Get-Command pnpm -ErrorAction Stop).Source
    $Docker = (Get-Command docker -ErrorAction Stop).Source
    Initialize-TestEnvironment $Root $Node $Docker $Pnpm $PostgresImage
} catch {
    [Console]::Error.WriteLine("无法完成首次测试初始化：$($_.Exception.Message)")
    [Console]::Error.WriteLine('请确认 PowerShell 7、项目要求的 Node.js/pnpm、项目依赖和 Docker Desktop 已准备好。已创建的配置与资源保持原样；修复原因后重跑 pnpm dev:test:init。')
    try {
        if (-not $PathsVerified) { throw '目录边界未通过核验，不能写入日志。' }
        $null = New-Item -ItemType Directory -Path $Runtime -Force
        "[$([DateTime]::UtcNow.ToString('O'))] $($_.Exception.GetType().FullName): $($_.Exception.Message)`n$($_.ScriptStackTrace)" | Add-Content -LiteralPath (Join-Path $Runtime 'bootstrap.log')
    } catch { [Console]::Error.WriteLine('初始化日志无法写入，请检查 Temp 目录权限。') }
    exit 1
}
