<# .SYNOPSIS 首次测试环境的资源准备与身份核验；加载本文件不执行 Docker 操作。 #>

<# .SYNOPSIS 脱敏错误诊断中的连接地址与凭据字段，终端和日志使用同一规则。 #>
function Protect-TestBootstrapDiagnostic {
    param([string]$Message)
    try {
        return $Message -replace '(?i)([a-z][a-z0-9+.-]*://)[^\s]+', '$1[已脱敏]' `
            -replace '(?i)("[a-z0-9_]*(?:password|secret|token|authorization|database_url)"\s*:\s*)"[^"\r\n]*"', '$1"[已脱敏]"' `
            -replace '(?i)((?:password|secret|token|authorization|database_url)\s*[=:]\s*)[^\r\n]+', '$1[已脱敏]'
    } catch { return '诊断内容无法安全显示，请检查步骤标签和退出码。' }
}

<# .SYNOPSIS 拒绝链接配置与目录，避免把本地初始化写入其他工作区或已有私有文件。 #>
function Assert-TestBootstrapPaths {
    param([string]$Root)
    try {
        foreach ($Relative in @('', '.env.test', '.env.test.example', '.env.test.bootstrap.json', 'Temp', 'Temp/test-environment')) {
            $Path = if ($Relative) { Join-Path $Root $Relative } else { $Root }
            if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw '初始化配置、模板和工作目录不能是符号链接或目录联接，请使用独立工作区。'
            }
        }
    } catch { throw [InvalidOperationException]::new('初始化路径核验失败，请核对本工作区的配置及 Temp 目录。', $_.Exception) }
}

<# .SYNOPSIS 固定本机 default 上下文并隔离 Docker、Compose 环境覆盖，返回供调用方恢复的原值。 #>
function Set-TestDockerEnvironment {
    try {
        $Saved = @{}
        $Keys = @('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG') +
            @(Get-ChildItem Env: | Where-Object Name -Like 'COMPOSE_*' | ForEach-Object Name)
        foreach ($Key in ($Keys | Select-Object -Unique)) {
            $Saved[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process')
            Set-TestEnvironmentValue $Key $null
        }
        $env:DOCKER_CONTEXT = 'default'
        return $Saved
    } catch { throw [InvalidOperationException]::new('无法隔离 Docker 环境变量。', $_.Exception) }
}

<# .SYNOPSIS 执行资源命令并保留步骤、退出码和脱敏诊断；不记录成功的 inspect 内容。 #>
function Invoke-TestBootstrapCommand {
    param([string]$Command, [string[]]$Arguments, [string]$Label)
    try {
        $Log = Join-Path $Runtime 'bootstrap.log'
        "[$([DateTime]::UtcNow.ToString('O'))] $Label" | Add-Content -LiteralPath $Log
        $Output = @(& $Command @Arguments 2>&1)
        $Code = $LASTEXITCODE
        if ($Code -ne 0) {
            # 外部诊断可能包含环境变量或带凭据的地址，仅保留脱敏后的错误文本。
            $Detail = Protect-TestBootstrapDiagnostic ($Output -join "`n")
            "exit=$Code`n$Detail" | Add-Content -LiteralPath $Log
            throw "$Label 失败（退出码 $Code）。请检查 Docker Desktop、网络和磁盘权限后重试；日志：$Log。"
        }
        return ($Output -join "`n")
    } catch { throw [InvalidOperationException]::new((Protect-TestBootstrapDiagnostic "$Label 未完成：$($_.Exception.Message)"), $_.Exception) }
}

<# .SYNOPSIS 核对本地 Linux Docker 引擎，记录稳定引擎身份，拒绝远程上下文。 #>
function Get-TestDockerIdentity {
    param([string]$Docker)
    try {
        $Contexts = @(Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'context', 'inspect', 'default') '核验本机 Docker 上下文' | ConvertFrom-Json)
        if ($Contexts.Count -ne 1 -or $Contexts[0].Endpoints.docker.Host -cnotmatch '^(?:unix:///[^?#]+|npipe:/+(?:\.|localhost)/pipe/[^?#]+)$') {
            throw 'default 上下文必须指向本机 unix/npipe Docker；请在 Docker Desktop 中核对配置。'
        }
        $Info = Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'info', '--format', '{{json .}}') '核验 Docker 引擎' | ConvertFrom-Json
        if ($Info.OSType -cne 'linux' -or [string]::IsNullOrWhiteSpace($Info.ID)) { throw '需要运行中的本机 Linux Docker Engine。' }
        return [string]$Info.ID
    } catch { throw [InvalidOperationException]::new("Docker 本机身份核验失败：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 读取 PostgreSQL 17 的完整镜像 ID，并在有登记值时严格比对实际身份。 #>
function Get-TestPostgresImage {
    param([string]$Docker, [string]$Reference, [string]$Revision)
    try {
        $Images = @(Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'image', 'inspect', $Reference) '核验 PostgreSQL 镜像' | ConvertFrom-Json)
        if ($Images.Count -ne 1 -or $Images[0].Id -cnotmatch '^sha256:[a-f0-9]{64}$' -or
            'PG_MAJOR=17' -cnotin $Images[0].Config.Env -or
            ($Revision -and $Images[0].Id -cne "sha256:$Revision")) {
            throw 'PostgreSQL 镜像必须声明 PG_MAJOR=17，且完整 Image ID 必须与登记一致；不会覆盖或升级现有身份。'
        }
        return $Images[0]
    } catch { throw [InvalidOperationException]::new("镜像身份核验失败：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 核验物理卷名称、项目标签、环境归属和本地存储驱动，拒绝挂载未知数据。 #>
function Assert-TestBootstrapVolume {
    param([string]$Docker, [string]$Name, [string]$Owner)
    try {
        $Volumes = @(Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'volume', 'inspect', $Name) '核验测试卷归属' | ConvertFrom-Json)
        if ($Volumes.Count -ne 1 -or $Volumes[0].Name -cne $Name -or $Volumes[0].Driver -cne 'local' -or
            ($null -ne $Volumes[0].Options -and @($Volumes[0].Options.PSObject.Properties).Count -gt 0) -or
            $Volumes[0].Labels.'com.docker.compose.project' -cne 'sesame-notes-test' -or
            $Volumes[0].Labels.'sesame.bootstrap' -cne $Owner) {
            throw "测试卷 $Name 的归属或存储配置不符。请人工核对；脚本不会认领、清空或替换现有卷。"
        }
    } catch { throw [InvalidOperationException]::new("测试卷核验失败：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 原子持久化初始化收据；临时文件只写入仓库 Temp，不包含凭据。 #>
function Save-TestBootstrapReceipt {
    param([string]$Path, [hashtable]$Receipt)
    $Stage = Join-Path $Runtime ('receipt-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        [IO.File]::WriteAllText($Stage, ($Receipt | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($Stage, $Path, $true)
    } catch { throw [InvalidOperationException]::new('无法保存初始化收据；请保留 .env.test 与现有卷并检查目录权限。', $_.Exception) }
}

<# .SYNOPSIS 读取与当前工作区配置一致的初始化收据，丢失登记时拒绝自动创建替代数据卷。 #>
function Read-TestBootstrapReceipt {
    param([string]$Root, [hashtable]$Values)
    try {
        Assert-TestBootstrapPaths $Root
        $Path = Join-Path $Root '.env.test.bootstrap.json'
        if (-not (Test-Path -LiteralPath $Path)) { throw '缺少初始化收据，请从本环境备份恢复 .env.test.bootstrap.json；不会重新创建数据卷。' }
        $Receipt = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
        if ($Receipt.version -ne 1 -or $Receipt.root -cne $Root -or
            $Values.TEST_BOOTSTRAP_ID -cnotmatch '^[a-f0-9]{32}$' -or $Receipt.owner -cne $Values.TEST_BOOTSTRAP_ID -or
            $Values.POSTGRES_IMAGE_REVISION -cnotmatch '^[a-f0-9]{64}$' -or $Receipt.revision -cne $Values.POSTGRES_IMAGE_REVISION -or
            $Receipt.created -isnot [array] -or $Receipt.complete -isnot [bool]) {
            throw '初始化收据与当前工作区或 .env.test 的身份不符，请恢复匹配的配置与收据。'
        }
        return $Receipt
    } catch { throw [InvalidOperationException]::new("无法确认初始化登记：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 日常启动只读取首次初始化登记，缺少已登记资源时失败，不创建空库。 #>
function Assert-TestBootstrapReady {
    param([string]$Root, [string]$Docker, [hashtable]$Values)
    try {
        $Receipt = Read-TestBootstrapReceipt $Root $Values
        if (-not $Receipt.complete) { throw '首次初始化尚未完成，请先运行 pnpm dev:test:init。' }
        if ((Get-TestDockerIdentity $Docker) -cne $Receipt.engine) { throw 'Docker 引擎与初始化登记不符；请恢复原本机 Docker 引擎。' }
        foreach ($Name in @('sesame-notes-test_pg_data', 'sesame-notes-test_api_data')) {
            Assert-TestBootstrapVolume $Docker $Name $Receipt.owner
        }
        $null = Get-TestPostgresImage $Docker "sesame-notes-test-postgres:test-17-$($Receipt.revision)" $Receipt.revision
    } catch { throw [InvalidOperationException]::new("测试环境尚未就绪：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 准备独立测试配置、公开 PostgreSQL 镜像和带归属标签的外部卷；不启动容器或连接数据库。 #>
function Initialize-TestEnvironment {
    param([string]$Root, [string]$Node, [string]$Docker, [string]$Pnpm,
        [string]$PostgresImage = 'docker.io/library/postgres:17-alpine')
    $Lock = $null
    $Saved = @{}
    try {
        Assert-TestBootstrapPaths $Root
        $null = New-Item -ItemType Directory -Path $Runtime -Force
        $Lock = [IO.File]::Open((Join-Path $Runtime 'bootstrap.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $Saved = Set-TestDockerEnvironment
        if ($PostgresImage -cnotmatch '^docker\.io/library/postgres(?::17(?:\.[0-9]+)?-alpine|@sha256:[a-f0-9]{64})$') {
            throw '镜像来源仅接受公开官方 docker.io/library/postgres:17-alpine、17.x-alpine 或 sha256 摘要。'
        }
        $NodeVersion = (Invoke-TestBootstrapCommand $Node @('--version') '检查 Node.js').Trim().TrimStart('v')
        $PnpmVersion = (Invoke-TestBootstrapCommand $Pnpm @('--version') '检查 pnpm').Trim()
        if ([version]$NodeVersion -lt [version]'24.22.1' -or [version]$NodeVersion -ge [version]'25.0' -or
            [version]$PnpmVersion -lt [version]'10.0' -or [version]$PnpmVersion -ge [version]'11.0') { throw '需要 Node.js >=24.22.1 <25 与 pnpm 10；请自行准备受支持工具后重试。' }
        foreach ($Dependency in @('node_modules/.modules.yaml', 'apps/api/node_modules/prisma/package.json', 'apps/api/node_modules/typescript/package.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $Root $Dependency))) { throw '缺少项目依赖，请先由你执行 pnpm install --frozen-lockfile，再运行 pnpm dev:test:init。' }
        }
        $Engine = Get-TestDockerIdentity $Docker
        $null = Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'compose', 'version') '检查 Docker Compose'
        $EnvPath = Join-Path $Root '.env.test'
        $ReceiptPath = Join-Path $Root '.env.test.bootstrap.json'
        $Names = @('sesame-notes-test_pg_data', 'sesame-notes-test_api_data')
        # ls 的成功响应才能证明资源不存在；inspect 失败不能被解释为可创建空库。
        $Existing = (Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'volume', 'ls', '--format', '{{.Name}}') '列出已有数据卷') -split '\r?\n'
        if (Test-Path -LiteralPath $EnvPath) {
            $Config = Read-TestEnvironment $Root $Node
            if (-not $Config.values.TEST_BOOTSTRAP_ID) { throw '已有 .env.test 未登记首次初始化身份，已保留原样。已配置环境请使用 pnpm dev:test；新环境请先人工核对和备份现有配置与资源。' }
            $Receipt = Read-TestBootstrapReceipt $Root $Config.values
            if ($Receipt.engine -cne $Engine) { throw 'Docker 引擎与初始化登记不符，不能在另一引擎创建替代数据库。' }
            foreach ($Name in $Names) {
                if ($Name -cin $Existing) { Assert-TestBootstrapVolume $Docker $Name $Receipt.owner }
                elseif ($Receipt.complete -or $Name -cin $Receipt.created) { throw "已登记测试卷 $Name 缺失，请恢复原卷及数据；不会创建替代空库。" }
            }
            $Image = Get-TestPostgresImage $Docker "sha256:$($Receipt.revision)" $Receipt.revision
        } else {
            if (Test-Path -LiteralPath $ReceiptPath) { throw '发现初始化收据但缺少 .env.test，请恢复原配置，不要删除收据重新初始化。' }
            if (@($Names | Where-Object { $_ -cin $Existing }).Count) { throw '已有同名测试卷但缺少本环境配置，不能确认数据归属；请恢复原配置或由资源所有者人工处理。' }
            $Containers = Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'ps', '-a', '--filter', 'label=com.docker.compose.project=sesame-notes-test', '--format', '{{.ID}}') '检查已有测试容器'
            if ($Containers.Trim()) { throw '已有测试项目容器，首次初始化不会接管；请人工核对其配置和数据。' }
            $null = Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'pull', $PostgresImage) '准备公开 PostgreSQL 17 镜像'
            $Image = Get-TestPostgresImage $Docker $PostgresImage
            $Receipt = @{ version = 1; root = $Root; owner = [Guid]::NewGuid().ToString('N'); engine = $Engine;
                revision = $Image.Id.Substring(7); source = $PostgresImage; created = @(); complete = $false }
            # 配置仅在不存在时发布；密钥由系统随机源生成，不输出到终端或日志。
            $Content = [IO.File]::ReadAllText((Join-Path $Root '.env.test.example'))
            $Content = $Content -replace '(?m)^JWT_SECRET=.*$', ('JWT_SECRET=' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(48)).ToLowerInvariant())
            $Content = $Content -replace '(?m)^POSTGRES_IMAGE_REVISION=.*$', ('POSTGRES_IMAGE_REVISION=' + $Receipt.revision)
            $Content += "`nTEST_BOOTSTRAP_ID=$($Receipt.owner)`n"
            $Stage = Join-Path $Runtime ('config-' + $Receipt.owner)
            [IO.File]::WriteAllText($Stage, $Content, [Text.UTF8Encoding]::new($false))
            if (-not $IsWindows) { [IO.File]::SetUnixFileMode($Stage, [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite) }
            # 先验证候选配置，再登记身份；只有合法配置才可进入创建卷的阶段。
            $Candidate = Join-Path $Runtime ('candidate-' + $Receipt.owner)
            $null = New-Item -ItemType Directory -Path $Candidate
            [IO.File]::Move($Stage, (Join-Path $Candidate '.env.test'))
            $null = Read-TestEnvironment $Candidate $Node
            Save-TestBootstrapReceipt $ReceiptPath $Receipt
            [IO.File]::Move((Join-Path $Candidate '.env.test'), $EnvPath, $false)
        }
        $Alias = "sesame-notes-test-postgres:test-17-$($Receipt.revision)"
        $AliasIds = Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'image', 'ls', '--no-trunc', '--format', '{{.ID}}', '--filter', "reference=$Alias") '检查测试镜像别名'
        if ($AliasIds.Trim()) { $null = Get-TestPostgresImage $Docker $Alias $Receipt.revision }
        else {
            $null = Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'image', 'tag', $Image.Id, $Alias) '登记测试镜像别名'
            $null = Get-TestPostgresImage $Docker $Alias $Receipt.revision
        }
        foreach ($Name in $Names) {
            if ($Name -cnotin $Existing) {
                $null = Invoke-TestBootstrapCommand $Docker @('--context', 'default', 'volume', 'create', '--driver', 'local', '--label', 'com.docker.compose.project=sesame-notes-test', '--label', "sesame.bootstrap=$($Receipt.owner)", $Name) '创建本环境测试卷'
            }
            Assert-TestBootstrapVolume $Docker $Name $Receipt.owner
            if ($Name -cnotin $Receipt.created) {
                $Receipt.created += $Name
                Save-TestBootstrapReceipt $ReceiptPath $Receipt
            }
        }
        $Receipt.complete = $true
        Save-TestBootstrapReceipt $ReceiptPath $Receipt
        $Config = Read-TestEnvironment $Root $Node
        Assert-TestBootstrapReady $Root $Docker $Config.values
        Write-Host '测试环境资源已就绪；配置、镜像身份和已有数据均已保留。下一步运行 pnpm dev:test 启动数据库、迁移和测试 API。'
    } catch { throw [InvalidOperationException]::new((Protect-TestBootstrapDiagnostic "首次测试初始化失败：$($_.Exception.Message)"), $_.Exception) }
    finally {
        if ($Lock) { $Lock.Dispose() }
        foreach ($Key in $Saved.Keys) { Set-TestEnvironmentValue $Key $Saved[$Key] }
    }
}
