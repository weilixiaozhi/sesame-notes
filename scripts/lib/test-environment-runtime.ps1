<# .SYNOPSIS 共用测试环境的配置、进程身份与日志操作；加载本文件不会启动服务。 #>

<# .SYNOPSIS 验证显式本地测试来源，只允许 HTTP、固定端口和回环或 RFC1918 地址，拒绝公网及带凭据的目标。 #>
function Get-LocalTestOrigin {
    param([string]$Value, [string]$Label, [switch]$LoopbackOnly)
    try {
        $Address = $null
        if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$Address) -or
            $Address.Scheme -cne 'http' -or $Address.UserInfo -ne '' -or
            $Address.AbsolutePath -ne '/' -or $Address.Query -ne '' -or $Address.Fragment -ne '' -or
            $Value -cnotmatch '^http://[^/:]+:[1-9][0-9]{0,4}/?$' -or
            $Address.Port -lt 1 -or $Address.Port -gt 65535) {
            throw "$Label 必须是明确带端口的 HTTP Origin，不能包含凭据、路径或查询参数。"
        }
        $Loopback = $Address.Host -cin @('localhost', '127.0.0.1')
        $Private = $false
        if ($Address.Host -cmatch '^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$') {
            $Octets = @($Address.Host.Split('.') | ForEach-Object { [int]$_ })
            $Private = $Octets[0] -eq 10 -or
                ($Octets[0] -eq 172 -and $Octets[1] -ge 16 -and $Octets[1] -le 31) -or
                ($Octets[0] -eq 192 -and $Octets[1] -eq 168)
        }
        $Origin = $Address.GetLeftPart([UriPartial]::Authority)
        if ((-not $Loopback -and ($LoopbackOnly -or -not $Private)) -or
            $Value -cnotin @($Origin, "$Origin/")) {
            throw "$Label 只允许明确配置的回环或私有 IPv4 测试地址；Web 必须使用 localhost 或 127.0.0.1。"
        }
        return $Origin
    } catch { throw [InvalidOperationException]::new("测试地址校验失败：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 仅提取本地配置中的测试来源，不把数据库凭据传入既有服务验收流程。 #>
function Read-TestOrigins {
    param([string]$Root, [string]$Node)
    try {
        $Path = Join-Path $Root '.env.test'
        if (-not (Test-Path -LiteralPath $Path)) { throw '缺少 .env.test，请先按 .env.test.example 配置测试地址。' }
        $Json = & $Node -e 'const fs=require("node:fs");const {parseEnv}=require("node:util");const e=parseEnv(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({TEST_API_ORIGIN:e.TEST_API_ORIGIN,TEST_WEB_ORIGIN:e.TEST_WEB_ORIGIN}));' $Path
        if ($LASTEXITCODE -ne 0) { throw '.env.test 测试地址解析失败，请检查文件格式。' }
        $Values = $Json | ConvertFrom-Json -AsHashtable
        return @{
            TEST_API_ORIGIN = Get-LocalTestOrigin $Values.TEST_API_ORIGIN 'TEST_API_ORIGIN'
            TEST_WEB_ORIGIN = Get-LocalTestOrigin $Values.TEST_WEB_ORIGIN 'TEST_WEB_ORIGIN' -LoopbackOnly
        }
    } catch { throw [InvalidOperationException]::new("无法读取本地测试地址：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 使用 Node 的标准 dotenv 解析器读取测试配置，拒绝连接生产或专用验收数据库。 #>
function Read-TestEnvironment {
    param([string]$Root, [string]$Node)
    $Path = Join-Path $Root '.env.test'
    if (-not (Test-Path -LiteralPath $Path)) { throw '缺少 .env.test，新 clone 请先运行 pnpm dev:test:init 准备独立测试环境。' }
    $Json = & $Node -e 'const fs=require("node:fs");const {parseEnv}=require("node:util");process.stdout.write(JSON.stringify(parseEnv(fs.readFileSync(process.argv[1],"utf8"))));' $Path
    if ($LASTEXITCODE -ne 0) { throw '.env.test 解析失败，请检查文件格式。' }
    $Values = $Json | ConvertFrom-Json -AsHashtable
    foreach ($Key in $Values.Keys) {
        # Compose 会自行读取 --env-file 中的控制变量，仅清理进程环境不能隔离这些字段。
        if ($Key -imatch '^(COMPOSE|DOCKER)_') {
            throw ".env.test 不允许设置 $Key；Docker 和 Compose 控制参数由启动入口固定，请移除该字段后重试。"
        }
    }
    foreach ($Key in @('SESAME_ENV', 'NODE_ENV', 'HOST', 'PORT', 'DATABASE_URL', 'JWT_SECRET', 'STORAGE_PATH', 'CORS_ORIGINS')) {
        if ([string]::IsNullOrWhiteSpace($Values[$Key])) { throw ".env.test 缺少 $Key。" }
    }
    $Database = [Uri]$Values.DATABASE_URL
    if ($Values.SESAME_ENV -cne 'test' -or $Values.NODE_ENV -cne 'development' -or
        $Values.HOST -cne '0.0.0.0' -or $Values.PORT -cne '8080' -or
        $Database.Scheme -cne 'postgresql' -or $Database.Host -cnotin @('127.0.0.1', 'localhost') -or
        $Database.Port -ne 55432 -or $Database.AbsolutePath -cne '/sesame_notes_test' -or
        $Database.UserInfo -cne 'sesame:sesame') {
        throw '.env.test 必须使用 test、development、0.0.0.0:8080 及共用 localhost:55432/sesame_notes_test（sesame 用户和测试密码）。'
    }
    if ([Text.Encoding]::UTF8.GetByteCount($Values.JWT_SECRET) -lt 32) { throw '.env.test 的 JWT_SECRET 至少需要 32 字节。' }
    $Values.TEST_API_ORIGIN = Get-LocalTestOrigin $Values.TEST_API_ORIGIN 'TEST_API_ORIGIN'
    $Values.TEST_WEB_ORIGIN = Get-LocalTestOrigin $Values.TEST_WEB_ORIGIN 'TEST_WEB_ORIGIN' -LoopbackOnly
    if (([Uri]$Values.TEST_API_ORIGIN).Port -ne [int]$Values.PORT) {
        throw '.env.test 的 TEST_API_ORIGIN 端口必须与共用测试 API 的 PORT 一致。'
    }
    if ($Values.TEST_WEB_ORIGIN -cnotin @($Values.CORS_ORIGINS.Split(',').Trim())) {
        throw '.env.test 的 CORS_ORIGINS 必须包含 TEST_WEB_ORIGIN，浏览器才能使用认证 Cookie。'
    }
    $Values.STORAGE_PATH = [IO.Path]::GetFullPath($Values.STORAGE_PATH, $Root)
    return @{ values = $Values; fingerprint = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
}

<# .SYNOPSIS 显式固定共用测试项目、环境文件和编排文件，不允许 dotenv 或终端覆盖项目身份。 #>
function Get-TestComposeArguments {
    param([string]$Root)
    try {
        return @('compose', '--project-name', 'sesame-notes-test', '--env-file', (Join-Path $Root '.env.test'),
            '-f', (Join-Path $Root 'deploy/docker-compose.test.yml'))
    } catch { throw [InvalidOperationException]::new('无法定位共用测试编排文件。', $_.Exception) }
}

<# .SYNOPSIS 核验 Compose 最终展开的项目、镜像、外部卷、网络和数据库连接边界，不输出配置值。 #>
function Assert-TestComposeModel {
    param([System.Collections.IDictionary]$Model, [hashtable]$Values)
    try {
        if ($Model.name -cne 'sesame-notes-test' -or $Model.services.Count -ne 2 -or
            -not $Model.services.Contains('postgres') -or -not $Model.services.Contains('api')) {
            throw '最终 Compose 项目必须是 sesame-notes-test，且只包含 postgres 和 api。'
        }
        $Revision = $Values.POSTGRES_IMAGE_REVISION
        $ApiTag = if ([string]::IsNullOrEmpty($Values.TEST_IMAGE_TAG)) { 'local' } else { $Values.TEST_IMAGE_TAG }
        if ($Revision -cnotmatch '^[a-f0-9]{64}$' -or $ApiTag -cnotmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') {
            throw '测试镜像身份或标签无效，请核对 .env.test。'
        }
        $Postgres = $Model.services.postgres
        $Api = $Model.services.api
        if ($Postgres.image -cne "sesame-notes-test-postgres:test-17-$Revision" -or
            $Api.image -cne "sesame-notes-test-api:test-$ApiTag" -or
            $Postgres.pull_policy -cne 'never' -or $Api.pull_policy -cne 'never') {
            throw '最终 Compose 镜像必须匹配已配置的测试身份，并保留 pull_policy: never。'
        }
        if ($Model.volumes.Count -ne 2) { throw '最终 Compose 必须只声明两个固定的测试外部卷。' }
        foreach ($Volume in @('pg_data', 'api_data')) {
            $Definition = $Model.volumes[$Volume]
            if (-not $Definition -or $Definition.external -ne $true -or
                $Definition.name -cne "sesame-notes-test_$Volume" -or
                @($Definition.Keys | Where-Object { $_ -cnotin @('name', 'external') }).Count) {
                throw '最终 Compose 外部卷名称或归属设置不符合共用测试环境。'
            }
        }
        $DatabaseMounts = @($Postgres.volumes)
        $ApiDataMounts = @($Api.volumes | Where-Object { $_.type -ceq 'volume' -or $_.target -ceq '/data' })
        foreach ($MountCheck in @(
            @{ mounts = $DatabaseMounts; source = 'pg_data'; target = '/var/lib/postgresql/data' },
            @{ mounts = $ApiDataMounts; source = 'api_data'; target = '/data' }
        )) {
            $Mounts = $MountCheck.mounts
            if ($Mounts.Count -ne 1 -or $Mounts[0].type -cne 'volume' -or
                $Mounts[0].source -cne $MountCheck.source -or $Mounts[0].target -cne $MountCheck.target -or
                $Mounts[0].read_only) { throw '最终 Compose 数据挂载必须使用对应的可写测试外部卷。' }
        }
        if ($Model.networks.Count -ne 1 -or $Model.networks.default.name -cne 'sesame-notes-test_default' -or
            $Model.networks.default.external -or $Postgres.networks.Count -ne 1 -or $Api.networks.Count -ne 1 -or
            -not $Postgres.networks.Contains('default') -or -not $Api.networks.Contains('default')) {
            throw '最终 Compose 必须使用固定的共用测试网络。'
        }
        $Ports = @($Postgres.ports)
        if ($Ports.Count -ne 1 -or $Ports[0].host_ip -cne '127.0.0.1' -or
            [string]$Ports[0].published -cne '55432' -or $Ports[0].target -ne 5432 -or $Ports[0].protocol -cne 'tcp' -or
            $Postgres.environment.POSTGRES_DB -cne 'sesame_notes_test' -or
            $Postgres.environment.POSTGRES_USER -cne 'sesame' -or $Postgres.environment.POSTGRES_PASSWORD -cne 'sesame') {
            throw '最终 Compose PostgreSQL 必须使用固定测试库、测试账号及 127.0.0.1:55432。'
        }
    } catch { throw [InvalidOperationException]::new("测试编排身份核验失败：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 只读解析将要执行的同一组 Compose 参数，失败即停止，避免把完整配置及凭据写入日志。 #>
function Assert-TestComposeConfiguration {
    param([string]$Docker, [string[]]$Compose, [hashtable]$Values)
    try {
        try { $Output = @(& $Docker @Compose config --format json 2>&1) }
        catch { throw "Compose 配置命令无法执行（$($_.Exception.GetType().Name)），请检查 Docker CLI；尚未启动服务。" }
        $Code = $LASTEXITCODE
        if ($Code -ne 0) { throw "Compose 配置解析失败（退出码 $Code），请核对编排文件和 .env.test；尚未启动服务。" }
        try { $Model = ($Output -join "`n") | ConvertFrom-Json -AsHashtable -NoEnumerate }
        catch {
            # JSON 解析器的原始异常可能包含配置片段；仅保留错误类型用于排障。
            throw "Compose 未返回有效 JSON（$($_.Exception.GetType().Name)），请核对 Docker Compose 版本；尚未启动服务。"
        }
        if ($Model -isnot [System.Collections.IDictionary]) { throw 'Compose 配置必须是对象结构；尚未启动服务。' }
        Assert-TestComposeModel $Model $Values
    } catch { throw [InvalidOperationException]::new("无法确认共用测试配置：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 精确区分未设置与空字符串；未设置的变量从进程环境移除，使应用可以使用默认配置。 #>
function Set-TestEnvironmentValue {
    param([string]$Key, [AllowNull()][object]$Value)
    if ($null -eq $Value) {
        [Environment]::SetEnvironmentVariable($Key, [NullString]::Value, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable($Key, [string]$Value, 'Process')
    }
}

<# .SYNOPSIS 覆盖 API 配置并保存原值，避免当前终端中残留的生产配置进入测试进程。 #>
function Set-TestEnvironment {
    param([hashtable]$Values)
    $Saved = @{}
    $Keys = @('SESAME_ENV', 'NODE_ENV', 'HOST', 'PORT', 'DATABASE_URL', 'JWT_SECRET', 'STORAGE_PATH', 'CORS_ORIGINS',
        'ACCESS_TOKEN_TTL', 'REFRESH_TOKEN_TTL', 'EXCHANGE_RATE_UPSTREAM', 'EXCHANGE_RATE_CACHE_TTL',
        'RATE_LIMIT_MAX', 'AUTH_RATE_LIMIT_MAX', 'SYNC_RETENTION_MIN_CURSOR', 'GITHUB_RELEASE_TOKEN', 'GITHUB_RELEASE_REPOSITORY',
        'TRUST_PROXY_CIDRS', 'E2E_DATABASE_URL', 'WEB_API_TARGET', 'ADMIN_API_TARGET',
        'ADMIN_ORIGINS', 'ADMIN_SESSION_TTL', 'ADMIN_SESSION_IDLE_TTL') + @($Values.Keys) | Select-Object -Unique
    foreach ($Key in $Keys) {
        $Saved[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process')
        Set-TestEnvironmentValue $Key $Values[$Key]
    }
    return $Saved
}

<# .SYNOPSIS 保存外部命令的详细输出；命令参数不进入日志，避免泄露凭据。 #>
function Invoke-TestCommand {
    param([string]$Command, [string[]]$Arguments, [string]$Label)
    $Log = Join-Path $Runtime 'startup-commands.log'
    "[$([DateTime]::UtcNow.ToString('O'))] $Label" | Add-Content -LiteralPath $Log
    & $Command @Arguments 2>&1 | Tee-Object -FilePath $Log -Append | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "$Label 失败，退出码 $LASTEXITCODE。详细输出：$Log。" }
}

<# .SYNOPSIS 解析可执行文件的实际路径，统一处理命令别名与符号链接，不使用可修改的进程显示名称。 #>
function Resolve-TestExecutablePath {
    param([string]$Path)
    try {
        if ([string]::IsNullOrWhiteSpace($Path)) { throw '可执行文件路径为空。' }
        $Executable = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($Executable.PSIsContainer) { throw '可执行文件路径不能指向目录。' }
        return $(if ($Executable.LinkType) { $Executable.ResolveLinkTarget($true).FullName } else { $Executable.FullName })
    } catch { throw [InvalidOperationException]::new("无法核验进程可执行文件：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 按平台的文件路径语义比较真实可执行文件，避免符号链接或大小写造成身份误判。 #>
function Test-SameExecutablePath {
    param([string]$Actual, [string]$Expected)
    try {
        $ActualPath = Resolve-TestExecutablePath $Actual
        $ExpectedPath = Resolve-TestExecutablePath $Expected
        return $(if ($IsWindows) { $ActualPath -ieq $ExpectedPath } else { $ActualPath -ceq $ExpectedPath })
    } catch { throw }
}

<# .SYNOPSIS 判断进程是否已终止；Unix 僵尸仍可枚举 PID，但已不能执行或持有监听。 #>
function Test-TestProcessExited {
    param($Process)
    try {
        if (-not $Process -or $Process.HasExited) { return $true }
        if ($IsLinux) {
            $StatusPath = "/proc/$($Process.Id)/stat"
            if (-not (Test-Path -LiteralPath $StatusPath)) { return $true }
            try { $Status = [IO.File]::ReadAllText($StatusPath) }
            catch [IO.FileNotFoundException] { return $true }
            catch [IO.DirectoryNotFoundException] { return $true }
            # comm 字段可以包含空格与括号，状态位必须从最后一个右括号之后读取。
            $NameEnd = $Status.LastIndexOf(')')
            if ($NameEnd -lt 0 -or $Status.Length -le $NameEnd + 2) { throw '系统进程状态格式无效。' }
            return $Status[$NameEnd + 2] -cin @('Z', 'X')
        }
        return $false
    } catch { throw [InvalidOperationException]::new("无法确认进程退出状态：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 只返回 PID、启动时间、可执行文件与工作区均匹配的已登记 Node 进程。 #>
function Get-TestProcess {
    param([string]$Path, [string]$Role)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $State = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($State.root -cne $Root -or $State.role -cne $Role) { throw "服务登记不属于当前工作区或角色：$Path。" }
    if (-not $State.id) { return $null }
    $Process = Get-Process -Id $State.id -ErrorAction SilentlyContinue
    if (Test-TestProcessExited $Process) { return $null }
    # ConvertFrom-Json 可能返回 DateTime；直接转字符串会丢失小数秒，必须保留完整 ticks。
    $StartedTicks = if ($State.started -is [DateTimeOffset]) { $State.started.UtcTicks }
        elseif ($State.started -is [DateTime]) { $State.started.ToUniversalTime().Ticks }
        else { [DateTimeOffset]::Parse([string]$State.started, [Globalization.CultureInfo]::InvariantCulture).UtcTicks }
    # Unix 进程显示名称可由运行时或应用修改；身份使用启动时间和真实可执行文件确定。
    if ($Process.StartTime.ToUniversalTime().Ticks -ne $StartedTicks -or
        -not (Test-SameExecutablePath $Process.Path $State.executable)) {
        throw "PID $($State.id) 身份与服务登记不符，已保留登记并停止操作。"
    }
    return @{ process = $Process; state = $State }
}

<# .SYNOPSIS 创建进程后立即登记身份，以便就绪检查失败时仍能安全定位和清理。 #>
function Start-TestProcess {
    param([string]$Role, [string[]]$Arguments, [string]$Directory, [string]$Path, [string]$Fingerprint)
    $Process = $null
    try {
        $OutputPath = Join-Path $Runtime "$Role.stdout.log"
        $ErrorPath = Join-Path $Runtime "$Role.stderr.log"
        # JSON 经标准输入传递，不借助 shell 解释参数；所有平台的子服务日志都直接连接文件。
        # 独立 helper 在 Windows 隐藏窗口，在 Unix 创建独立会话，服务不持有启动终端的管道。
        $Request = @{ arguments = @($Arguments); directory = $Directory; stdout = $OutputPath; stderr = $ErrorPath } | ConvertTo-Json -Compress
        $Helper = Join-Path $PSScriptRoot 'start-detached-test-process.mjs'
        $StartedAfter = [DateTime]::UtcNow.AddSeconds(-1)
        $Result = $Request | & $Node $Helper
        if ($LASTEXITCODE -ne 0) { throw '独立进程启动失败，请检查上方错误和运行日志。' }
        $Receipt = $Result | ConvertFrom-Json -ErrorAction Stop
        if (($Receipt.id -isnot [long] -and $Receipt.id -isnot [int]) -or $Receipt.id -le 0) {
            throw '独立进程未返回有效 PID。'
        }
        $Candidate = Get-Process -Id $Receipt.id -ErrorAction Stop
        $SameExecutable = Test-SameExecutablePath $Candidate.Path $Node
        if ((Test-TestProcessExited $Candidate) -or -not $SameExecutable -or
            $Candidate.StartTime.ToUniversalTime() -lt $StartedAfter) {
            throw "独立进程身份无法确认，未接管或终止该 PID（PID=$($Receipt.id)，显示名称=$($Candidate.ProcessName)，可执行文件匹配=$SameExecutable）。"
        }
        $Process = $Candidate
        @{ root = $Root; role = $Role; id = $Process.Id; started = $Process.StartTime.ToUniversalTime().ToString('O');
            executable = Resolve-TestExecutablePath $Process.Path; fingerprint = $Fingerprint } | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding utf8 -ErrorAction Stop
        return $Process
    } catch {
        $Failure = $_
        if ($Process -and -not $Process.HasExited) {
            try {
                $Process.Kill($true)
                if (-not $Process.WaitForExit(10000)) { throw '本次创建的子进程未在限定时间内退出。' }
            }
            catch { [Console]::Error.WriteLine("清理已创建的 $Role 进程失败：$($_.Exception.Message)") }
        }
        throw [InvalidOperationException]::new("无法启动 $Role：$($Failure.Exception.Message)", $Failure.Exception)
    }
}

<# .SYNOPSIS 仅停止传入的已核验进程，等待退出后写入空登记，不操作其他服务。 #>
function Stop-TestProcess {
    param($Managed, [string]$Path, [string]$Role)
    if ($Managed -and -not $Managed.process.HasExited) {
        $Managed.process.Kill($true)
        if (-not $Managed.process.WaitForExit(10000)) { throw "$Role 进程未能退出，登记仍保留。" }
    }
    @{ root = $Root; role = $Role; id = $null } | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding utf8
}

<# .SYNOPSIS 识别 PowerShell 所在系统；不支持的系统必须停止，不能跳过监听身份检查。 #>
function Get-TestRuntimePlatform {
    try {
        if ($IsWindows) { return 'Windows' }
        if ($IsLinux) { return 'Linux' }
        if ($IsMacOS) { return 'macOS' }
        throw '统一测试启动入口仅支持 Windows、Linux 和 macOS。'
    } catch { throw [PlatformNotSupportedException]::new($_.Exception.Message, $_.Exception) }
}

<# .SYNOPSIS 有限等待系统监听查询，分离标准输出与诊断信息并通过 ArgumentList 保留参数边界。 #>
function Invoke-TestListenerCommand {
    param([string]$Command, [string[]]$Arguments)
    $Query = $null
    try {
        # PATH 中可以同时存在同一工具的多个入口，只选命令解析顺序中的第一个应用。
        $Executable = (Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $Info = [Diagnostics.ProcessStartInfo]::new($Executable)
        $Info.UseShellExecute = $false
        $Info.RedirectStandardOutput = $true
        $Info.RedirectStandardError = $true
        foreach ($Argument in $Arguments) { $Info.ArgumentList.Add($Argument) }
        # 固定文本语言，解析依赖协议字段而非当前终端的区域设置。
        $Info.Environment['LC_ALL'] = 'C'
        $Query = [Diagnostics.Process]::Start($Info)
        $OutputTask = $Query.StandardOutput.ReadToEndAsync()
        $ErrorTask = $Query.StandardError.ReadToEndAsync()
        if (-not $Query.WaitForExit(10000)) {
            $Query.Kill($true)
            $null = $Query.WaitForExit(10000)
            throw "$Command 监听查询超时；未执行服务启动或停止操作。"
        }
        return @{ ExitCode = $Query.ExitCode; Output = $OutputTask.GetAwaiter().GetResult(); ErrorOutput = $ErrorTask.GetAwaiter().GetResult() }
    } catch {
        throw [InvalidOperationException]::new("无法执行 $Command 监听查询，请确认系统提供该工具并允许读取进程信息：$($_.Exception.Message)", $_.Exception)
    } finally { if ($Query) { $Query.Dispose() } }
}

<# .SYNOPSIS 解析数值 TCP 端点，保留 IPv4、IPv6 和通配监听地址，拒绝错误端口或不明地址格式。 #>
function ConvertFrom-TestListenerEndpoint {
    param([string]$Endpoint, [int]$Port)
    try {
        if ($Endpoint -cnotmatch '^(?:\[(?<bracket>[^\]]+)\]|(?<plain>.+)):(?<port>[0-9]+)$' -or
            [int]$Matches.port -ne $Port) { throw '监听端点与请求端口不一致或格式无效。' }
        $Address = if ($Matches.bracket) { $Matches.bracket } else { $Matches.plain }
        $ParsedAddress = $null
        if ($Address -cne '*' -and -not [Net.IPAddress]::TryParse($Address, [ref]$ParsedAddress)) {
            throw '监听地址不是数值 IP 或通配地址。'
        }
        return $Address
    } catch { throw [InvalidOperationException]::new('无法解析系统返回的 TCP 监听端点。', $_.Exception) }
}

<# .SYNOPSIS 解析 ss 的无表头 TCP 监听结果；每条监听必须有可见的正整数 PID。 #>
function ConvertFrom-TestSsListeners {
    param([AllowEmptyString()][string]$Output, [int]$Port)
    try {
        foreach ($Line in @($Output -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
            if ($Line -cnotmatch '^LISTEN\s+[0-9]+\s+[0-9]+\s+(?<local>\S+)\s+\S+\s*(?<owners>.*)$') {
                throw 'ss 返回了无法识别的监听记录。'
            }
            $Endpoint = $Matches.local
            $OwnerText = $Matches.owners.Trim()
            $Address = ConvertFrom-TestListenerEndpoint $Endpoint $Port
            if ($OwnerText -cnotmatch '^users:\(\("[^"]*",pid=[1-9][0-9]*,fd=[0-9]+\)(?:,\("[^"]*",pid=[1-9][0-9]*,fd=[0-9]+\))*\)$') {
                throw 'ss 检测到监听，但进程 PID 不可见或身份字段格式无效；请核对系统权限后重试。'
            }
            $Owners = [regex]::Matches($OwnerText, ',pid=(?<id>[1-9][0-9]*),fd=')
            foreach ($Owner in $Owners) {
                [pscustomobject]@{ LocalAddress = $Address; LocalPort = $Port; OwningProcess = [int]$Owner.Groups['id'].Value }
            }
        }
    } catch { throw [InvalidOperationException]::new("无法确认 Linux 端口 $Port 的监听身份：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 解析 lsof 的 p/f/t/n 机器字段输出，确保每个端点都有明确的 PID、文件和地址族。 #>
function ConvertFrom-TestLsofListeners {
    param([AllowEmptyString()][string]$Output, [int]$Port)
    try {
        $Owner = $null
        $FileDescriptor = $null
        $Family = $null
        $HasEndpoint = $false
        foreach ($Line in @($Output -split '\r?\n' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
            if ($Line -cmatch '^p([1-9][0-9]*)$') {
                if ($null -ne $Owner -and -not $HasEndpoint) { throw 'lsof 进程记录缺少监听端点。' }
                $Owner = [int]$Matches[1]
                $FileDescriptor = $null
                $Family = $null
                $HasEndpoint = $false
            } elseif ($Line -cmatch '^f([0-9]+)$') {
                if ($null -eq $Owner -or ($null -ne $FileDescriptor -and -not $HasEndpoint)) {
                    throw 'lsof 文件记录缺少进程或监听端点。'
                }
                $FileDescriptor = $Matches[1]
                $Family = $null
                $HasEndpoint = $false
            } elseif ($Line -cmatch '^t(IPv[46])$') {
                if ($null -eq $FileDescriptor -or $null -ne $Family) { throw 'lsof 地址族字段不属于有效文件。' }
                $Family = $Matches[1]
            } elseif ($Line.StartsWith('n', [StringComparison]::Ordinal)) {
                if ($null -eq $Owner -or $null -eq $FileDescriptor -or $null -eq $Family -or $HasEndpoint) {
                    throw 'lsof 检测到监听，但进程 PID、文件或地址族不可确认。'
                }
                $Address = ConvertFrom-TestListenerEndpoint $Line.Substring(1) $Port
                # lsof 用同一个星号表示 IPv4/IPv6 的通配绑定，借助文件类型还原真实监听地址。
                if ($Address -ceq '*') { $Address = if ($Family -ceq 'IPv4') { '0.0.0.0' } else { '::' } }
                $HasEndpoint = $true
                [pscustomobject]@{ LocalAddress = $Address; LocalPort = $Port; OwningProcess = $Owner }
            } else { throw 'lsof 返回了无法识别的监听字段。' }
        }
        if ($null -ne $Owner -and -not $HasEndpoint) { throw 'lsof 进程记录缺少监听端点。' }
    } catch { throw [InvalidOperationException]::new("无法确认 macOS 端口 $Port 的监听身份：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 使用系统原生工具读取同一格式的监听身份；任何查询或解析错误均不能当作端口空闲。 #>
function Get-TestRuntimePortListeners {
    param([ValidateRange(1, 65535)][int]$Port)
    try {
        switch (Get-TestRuntimePlatform) {
            'Windows' {
                # 不按端口向 CIM 发起筛选，避免“无匹配实例”与查询失败共用错误路径。
                $Connections = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq $Port })
                foreach ($Connection in $Connections) {
                    if ([long]$Connection.OwningProcess -le 0 -or [string]::IsNullOrWhiteSpace($Connection.LocalAddress)) {
                        throw '系统返回的监听记录缺少有效 PID 或地址。'
                    }
                    [pscustomobject]@{ LocalAddress = $Connection.LocalAddress; LocalPort = $Port; OwningProcess = [int]$Connection.OwningProcess }
                }
            }
            'Linux' {
                $Result = Invoke-TestListenerCommand 'ss' @('-H', '-ltnp', "sport = :$Port")
                if ($Result.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($Result.ErrorOutput)) {
                    throw "ss 查询未成功（退出码 $($Result.ExitCode)）：$($Result.ErrorOutput)"
                }
                ConvertFrom-TestSsListeners $Result.Output $Port
            }
            'macOS' {
                $Result = Invoke-TestListenerCommand 'lsof' @('-nP', '-a', "-iTCP:$Port", '-sTCP:LISTEN', '-Fpftn')
                # lsof 仅在无匹配项且完全没有输出时以 1 返回；其他非零状态都不能解释为端口空闲。
                if ($Result.ExitCode -eq 1 -and [string]::IsNullOrWhiteSpace($Result.Output) -and
                    [string]::IsNullOrWhiteSpace($Result.ErrorOutput)) { return }
                if ($Result.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($Result.ErrorOutput)) {
                    throw "lsof 查询未成功（退出码 $($Result.ExitCode)）：$($Result.ErrorOutput)"
                }
                ConvertFrom-TestLsofListeners $Result.Output $Port
            }
        }
    } catch { throw [InvalidOperationException]::new("无法安全检查端口 $Port：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 拒绝接管未知监听进程，避免验收启动误停其他应用。 #>
function Assert-TestPort {
    param([int]$Port, [int[]]$AllowedIds = @())
    try {
        $Listeners = @(Get-TestRuntimePortListeners $Port)
        if (@($Listeners | Where-Object { $_.OwningProcess -notin $AllowedIds }).Count) {
            throw "端口 $Port 已由未登记的进程占用，脚本不会终止该进程。"
        }
    } catch { throw [InvalidOperationException]::new("端口使用检查失败：$($_.Exception.Message)", $_.Exception) }
}

<# .SYNOPSIS 有限轮询服务与数据库就绪状态，失败时指向保留的运行日志。 #>
function Wait-TestReady {
    param([string]$Url, [System.Diagnostics.Process]$Process)
    for ($Attempt = 0; $Attempt -lt 80; $Attempt++) {
        if ($Process -and $Process.HasExited) { throw "服务进程已退出，请检查 $Runtime 下的 stdout/stderr 日志。" }
        try {
            $Response = Invoke-WebRequest -Uri $Url -TimeoutSec 1 -SkipHttpErrorCheck
            if ($Response.StatusCode -eq 200 -and ($Response.Content | ConvertFrom-Json).status -eq 'ok') { return }
        } catch { if ($Attempt -eq 79) { throw "就绪检查失败：$($_.Exception.Message)" } }
        Start-Sleep -Milliseconds 250
    }
    throw "服务未在限定时间内就绪：$Url。请检查 $Runtime 下的日志。"
}

<# .SYNOPSIS 验证共用测试 PostgreSQL 的 Compose 身份、物理卷和固定回环端口。 #>
function Assert-TestDatabaseContainer {
    param($Container)
    $Mounts = @($Container.Mounts | Where-Object { $_.Destination -eq '/var/lib/postgresql/data' })
    $Bindings = @($Container.HostConfig.PortBindings.'5432/tcp')
    if ($Container.Config.Labels.'com.docker.compose.project' -cne 'sesame-notes-test' -or
        $Container.Config.Labels.'com.docker.compose.service' -cne 'postgres' -or
        $Mounts.Count -ne 1 -or $Mounts[0].Name -cne 'sesame-notes-test_pg_data' -or
        $Mounts[0].Type -cne 'volume' -or -not $Mounts[0].RW -or
        $Bindings.Count -ne 1 -or $Bindings[0].HostIp -cne '127.0.0.1' -or $Bindings[0].HostPort -cne '55432' -or
        'POSTGRES_DB=sesame_notes_test' -cnotin $Container.Config.Env) {
        throw 'PostgreSQL 容器必须使用共用 test Compose 项目、sesame-notes-test_pg_data 卷及 127.0.0.1:55432。'
    }
}

<# .SYNOPSIS 复用经过验证的本机 Node API 或共用 test Compose API，不能把任意健康服务当作测试服务。 #>
function Get-SharedTestApi {
    param([string]$Fingerprint)
    $Path = Join-Path $Root 'Temp/test-environment/api-process.json'
    $Managed = Get-TestProcess $Path 'api'
    if ($Managed) {
        if ($Managed.state.fingerprint -cne $Fingerprint) { throw '.env.test 已变更，请运行 pnpm dev:test -Rebuild 更新共用 API。' }
        Assert-TestPort 8080 @($Managed.process.Id)
        $Listeners = @(Get-TestRuntimePortListeners 8080)
        if (-not @($Listeners | Where-Object { $_.OwningProcess -eq $Managed.process.Id -and $_.LocalAddress -eq '0.0.0.0' }).Count) {
            throw '已登记的共用 API 未监听 0.0.0.0:8080，手机端无法连接。'
        }
        return @{ kind = 'node'; process = $Managed.process }
    }
    $Docker = (Get-Command docker -ErrorAction Stop).Source
    $Ids = @(& $Docker ps --filter 'label=com.docker.compose.project=sesame-notes-test' --filter 'label=com.docker.compose.service=api' --format '{{.ID}}')
    if ($LASTEXITCODE -ne 0) { throw '无法核验共用 API 容器，请确认 Docker Desktop 已运行。' }
    if (-not $Ids.Count) { return $null }
    if ($Ids.Count -ne 1) { throw '发现多个共用 test API 容器，请先核对环境。' }
    $Api = (& $Docker inspect $Ids[0] | ConvertFrom-Json)[0]
    if ($LASTEXITCODE -ne 0) { throw '无法读取共用 API 容器身份。' }
    $Bindings = @($Api.HostConfig.PortBindings.'8080/tcp')
    $DatabaseUrl = @($Api.Config.Env | Where-Object { $_ -clike 'DATABASE_URL=*' })
    if ('SESAME_ENV=test' -cnotin $Api.Config.Env -or $Bindings.Count -ne 1 -or
        $Bindings[0].HostIp -cne '0.0.0.0' -or $Bindings[0].HostPort -cne '8080' -or $DatabaseUrl.Count -ne 1) {
        throw '现有 Docker API 未声明 test 或未监听 0.0.0.0:8080。'
    }
    $Database = [Uri]$DatabaseUrl[0].Substring('DATABASE_URL='.Length)
    if ($Database.Scheme -cne 'postgresql' -or $Database.Host -cne 'postgres' -or
        $Database.Port -ne 5432 -or $Database.AbsolutePath -cne '/sesame_notes_test') { throw 'Docker API 未连接共用测试数据库。' }
    $DatabaseIds = @(& $Docker ps --filter 'label=com.docker.compose.project=sesame-notes-test' --filter 'label=com.docker.compose.service=postgres' --format '{{.ID}}')
    if ($LASTEXITCODE -ne 0 -or $DatabaseIds.Count -ne 1) { throw '共用测试 PostgreSQL 容器未运行。' }
    $Postgres = (& $Docker inspect $DatabaseIds[0] | ConvertFrom-Json)[0]
    if ($LASTEXITCODE -ne 0) { throw '无法读取共用数据库容器。' }
    Assert-TestDatabaseContainer $Postgres
    $Network = 'sesame-notes-test_default'
    if (-not $Api.NetworkSettings.Networks.$Network -or -not $Postgres.NetworkSettings.Networks.$Network) {
        throw 'Docker API 与 PostgreSQL 未加入共用 test 网络。'
    }
    return @{ kind = 'docker'; process = $null }
}

<# .SYNOPSIS 记录完整异常与调用栈，同时给使用者显示简短可操作的错误信息。 #>
function Write-TestFailure {
    param($Failure, [string]$Label)
    $Message = $Failure.Exception.Message
    try {
        $Diagnostic = "[$([DateTime]::UtcNow.ToString('O'))]`n$($Failure | Out-String)`n$($Failure.Exception.ToString())`n$($Failure.ScriptStackTrace)"
        if (Get-Command Protect-TestBootstrapDiagnostic -ErrorAction SilentlyContinue) {
            # 初始化资源核验的异常链也须脱敏，不能只处理最外层消息。
            $Diagnostic = Protect-TestBootstrapDiagnostic $Diagnostic
            $Message = Protect-TestBootstrapDiagnostic $Message
        }
        $Diagnostic | Add-Content -LiteralPath (Join-Path $Runtime 'startup-error.log')
    } catch { [Console]::Error.WriteLine("错误日志写入失败：$($_.Exception.Message)") }
    [Console]::Error.WriteLine("${Label}失败：$Message。详细日志：$Runtime")
}
