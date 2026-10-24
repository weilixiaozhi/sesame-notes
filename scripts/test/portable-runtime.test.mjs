import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '../..');
const runtime = path.join(root, 'scripts/lib/test-environment-runtime.ps1');
const detachedHelper = path.join(root, 'scripts/lib/start-detached-test-process.mjs');
const tempRoot = path.join(root, 'Temp');
const unusualArguments = ['value with spaces', 'embedded"quote', 'trailing slash \\', '', "single'quote"];
const runtimeTest =
  spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']).status === 0 ? test : test.skip;

const workerSource = `
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
try {
  const [ready, host, nonce, ...args] = process.argv.slice(2);
  // 运行时和应用可以改变显示名称，进程身份仍应由可执行文件与启动时间确定。
  process.title = 'sesame-fixture-worker';
  const server = createServer((socket) => {
    socket.on('error', (error) => console.error('fixture socket:', error.message));
    socket.end('fixture');
  });
  server.on('error', (error) => { console.error(error.stack); process.exit(1); });
  server.listen(0, host, () => {
    try {
      writeFileSync(ready, JSON.stringify({ id: process.pid, port: server.address().port, host, nonce, args, cwd: process.cwd() }));
      console.log('fixture stdout');
      console.error('fixture stderr');
    } catch (error) { console.error(error.stack); server.close(); process.exitCode = 1; }
  });
  // 即使测试进程异常中断，临时监听也会自动退出，避免遗留长期后台服务。
  setTimeout(() => { server.close(); process.exit(); }, 45000).unref();
} catch (error) { console.error(error.stack); process.exitCode = 1; }
`;

/** 将测试值转换为 PowerShell 字面量，保留空格、引号和反斜杠。 */
function quote(value) {
  try {
    return `'${String(value).replaceAll("'", "''")}'`;
  } catch (error) {
    throw new Error('无法编码测试参数。', { cause: error });
  }
}

/** 在单独的 PowerShell 启动器中执行真实运行函数，完成后启动器立即退出。 */
function runPowerShell(fixture, body) {
  const descriptors = [];
  try {
    const output = path.join(fixture.directory, `launcher-${randomUUID()}.stdout.log`);
    const errors = path.join(fixture.directory, `launcher-${randomUUID()}.stderr.log`);
    descriptors.push(openSync(output, 'w'));
    descriptors.push(openSync(errors, 'w'));
    // 直接使用文件日志，判断启动器自己的退出；不会把后代继承的管道 EOF 当作启动器生命期。
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
try {
    . ${quote(runtime)}
    $Root = ${quote(fixture.directory)}
    $Runtime = ${quote(fixture.logs)}
    $Node = ${quote(process.execPath)}
    ${body}
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`,
      ],
      { cwd: root, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', ...descriptors] },
    );
    const stdout = readFileSync(output, 'utf8');
    const stderr = readFileSync(errors, 'utf8');
    if (result.error) throw new Error(`PowerShell 未完成：${stdout}\n${stderr}`, { cause: result.error });
    assert.equal(result.status, 0, stderr || stdout);
    return stdout;
  } catch (error) {
    throw new Error(`PowerShell 夹具执行失败；诊断目录：${fixture.directory}`, { cause: error });
  } finally {
    for (const descriptor of descriptors) {
      try {
        closeSync(descriptor);
      } catch (error) {
        console.error('关闭启动器诊断日志失败：', error);
      }
    }
  }
}

/** 核验 Temp 的精确子目录及非链接属性，然后使用 PowerShell 原生命令清理。 */
function removeFixture(fixture) {
  try {
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
try {
    $Target = [IO.Path]::GetFullPath(${quote(fixture.directory)})
    $Parent = [IO.Path]::GetFullPath(${quote(tempRoot)})
    if ([IO.Path]::GetDirectoryName($Target) -cne $Parent -or [IO.Path]::GetFileName($Target) -cnotlike 'portable runtime-*') { throw 'INVALID_CLEANUP_TARGET' }
    if ((Get-Item -LiteralPath $Target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'LINKED_CLEANUP_TARGET' }
    Remove-Item -LiteralPath $Target -Recurse -Force
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`,
      ],
      { cwd: root, encoding: 'utf8', timeout: 20_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.error?.stack);
  } catch (error) {
    throw new Error(`临时测试目录清理失败：${fixture.directory}`, { cause: error });
  }
}

/** 创建包含空格路径的隔离监听夹具，测试结束后仅停止其身份登记匹配的进程。 */
function createFixture(t) {
  try {
    mkdirSync(tempRoot, { recursive: true });
    const directory = mkdtempSync(path.join(tempRoot, 'portable runtime-'));
    const fixture = {
      directory,
      logs: path.join(directory, 'logs with spaces'),
      worker: path.join(directory, 'worker with spaces.mjs'),
      ready: path.join(directory, 'managed ready.json'),
      state: path.join(directory, 'managed process.json'),
      nonce: randomUUID(),
      children: [],
    };
    mkdirSync(fixture.logs);
    writeFileSync(fixture.worker, workerSource);
    t.after(async () => {
      const failures = [];
      // 先清理持有 ChildProcess 句柄的夹具，后续登记或目录清理失败也不能跳过它们。
      for (const child of fixture.children) {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            const closed = new Promise((resolve) => child.once('close', resolve));
            child.kill();
            await Promise.race([closed, delay(2000)]);
            assert.ok(child.exitCode !== null || child.signalCode !== null, '夹具进程停止后必须确认退出。');
          }
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        if (existsSync(fixture.state)) {
          runPowerShell(
            fixture,
            `Stop-TestProcess (Get-TestProcess ${quote(fixture.state)} 'fixture') ${quote(fixture.state)} 'fixture'`,
          );
        }
      } catch (error) {
        failures.push(error);
      }
      if (!failures.length) {
        try {
          removeFixture(fixture);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        const error = new AggregateError(failures, `测试资源清理失败，保留诊断：${fixture.directory}`);
        console.error(error);
        throw error;
      }
    });
    return fixture;
  } catch (error) {
    throw new Error('无法创建本地隔离进程测试夹具。', { cause: error });
  }
}

/** 有界等待真实监听写出身份文件，失败时包含子进程日志以便区分实现错误。 */
async function waitReady(fixture, ready = fixture.ready) {
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (existsSync(ready)) {
        const result = JSON.parse(readFileSync(ready, 'utf8'));
        assert.equal(result.nonce, fixture.nonce);
        return result;
      }
      await delay(50);
    }
    const diagnostic = ['fixture.stdout.log', 'fixture.stderr.log']
      .map((name) => path.join(fixture.logs, name))
      .filter(existsSync)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    throw new Error(`临时 TCP 监听未就绪。${diagnostic}`);
  } catch (error) {
    throw new Error(`真实监听夹具失败：${ready}`, { cause: error });
  }
}

/** 发起一次纯本机 TCP 连接，以确认启动器退出后监听仍存在或已被停止。 */
async function canConnect(port) {
  try {
    return await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(1000);
      socket.once('data', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  } catch (error) {
    throw new Error('临时 TCP 连接检查失败。', { cause: error });
  }
}

/** 直接创建未登记的随机端口进程，并确保测试失败时也只清理自身创建的进程。 */
async function startUnknown(fixture) {
  try {
    const ready = path.join(fixture.directory, 'unknown ready.json');
    const child = spawn(process.execPath, [fixture.worker, ready, '127.0.0.1', fixture.nonce], {
      cwd: fixture.directory,
      windowsHide: true,
      stdio: 'ignore',
    });
    fixture.children.push(child);
    return await waitReady(fixture, ready);
  } catch (error) {
    throw new Error('无法准备未登记进程夹具。', { cause: error });
  }
}

runtimeTest('真实端口检查拒绝未知进程，复用已登记 PID 并只停止登记进程', async (t) => {
  const fixture = createFixture(t);
  try {
    const unknown = await startUnknown(fixture);
    const argumentsList = [fixture.worker, fixture.ready, '0.0.0.0', fixture.nonce, ...unusualArguments];
    runPowerShell(
      fixture,
      `
    $Rejected = $false
    try { Assert-TestPort ${unknown.port} } catch {
        if ($_.Exception.Message -notmatch '未登记') { throw }
        $Rejected = $true
    }
    if (-not $Rejected) { throw 'UNKNOWN_PROCESS_ACCEPTED' }
    $null = Start-TestProcess 'fixture' @(${argumentsList.map(quote).join(',')}) $Root ${quote(fixture.state)} 'fixture-fingerprint'
    `,
    );
    const managed = await waitReady(fixture);
    assert.deepEqual(managed.args, unusualArguments);
    assert.equal(managed.cwd, fixture.directory);
    assert.equal(await canConnect(unknown.port), true, '未知监听不得因端口检查被停止。');
    assert.equal(await canConnect(managed.port), true, '启动 PowerShell 退出后，已登记监听必须继续存活。');
    runPowerShell(
      fixture,
      `
    $Managed = Get-TestProcess ${quote(fixture.state)} 'fixture'
    if ($Managed.process.Id -ne ${managed.id}) {
        $State = Get-Content -LiteralPath ${quote(fixture.state)} -Raw
        $Diagnostic = Get-Content -LiteralPath (Join-Path $Runtime 'fixture.stderr.log') -Raw
        throw "REGISTERED_PROCESS_NOT_REUSED: expected=${managed.id}; actual=$($Managed.process.Id); state=$State; stderr=$Diagnostic"
    }
    Assert-TestPort ${managed.port} @($Managed.process.Id)
    $Listeners = @(Get-TestRuntimePortListeners ${managed.port})
    if (-not @($Listeners | Where-Object { $_.OwningProcess -eq ${managed.id} -and $_.LocalAddress -ceq '0.0.0.0' }).Count) { throw 'BIND_ADDRESS_LOST' }
    $UnknownListeners = @(Get-TestRuntimePortListeners ${unknown.port})
    if (-not @($UnknownListeners | Where-Object { $_.OwningProcess -eq ${unknown.id} -and $_.LocalAddress -ceq '127.0.0.1' }).Count) { throw 'LOOPBACK_ADDRESS_LOST' }
    Stop-TestProcess $Managed ${quote(fixture.state)} 'fixture'
    if (Get-TestProcess ${quote(fixture.state)} 'fixture') { throw 'STOPPED_PROCESS_STILL_REGISTERED' }
    `,
    );
    assert.equal(await canConnect(managed.port), false);
    assert.equal(await canConnect(unknown.port), true, '停止登记进程不得影响另一个未知监听。');
  } catch (error) {
    console.error(error.stack);
    throw error;
  }
});

runtimeTest('Node 独立启动器退出后子进程仍存活，并保留完整参数和文件日志', async (t) => {
  const fixture = createFixture(t);
  try {
    const args = [fixture.worker, fixture.ready, '127.0.0.1', fixture.nonce, ...unusualArguments];
    const result = spawnSync(process.execPath, [detachedHelper], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      input: JSON.stringify({
        arguments: args,
        directory: fixture.directory,
        stdout: path.join(fixture.logs, 'fixture.stdout.log'),
        stderr: path.join(fixture.logs, 'fixture.stderr.log'),
      }),
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.error?.stack);
    const { id } = JSON.parse(result.stdout);
    assert.ok(Number.isInteger(id) && id > 0);
    // 在单独的系统查询中登记实际启动时间，清理时不会误杀后来复用此 PID 的进程。
    runPowerShell(
      fixture,
      `
    $Process = Get-Process -Id ${id} -ErrorAction Stop
    $Executable = Get-Item -LiteralPath $Process.Path -ErrorAction Stop
    $ActualPath = if ($Executable.LinkType) { $Executable.ResolveLinkTarget($true).FullName } else { $Executable.FullName }
    $ExpectedPath = ${quote(realpathSync(process.execPath))}
    $Matched = if ($IsWindows) { $ActualPath -ieq $ExpectedPath } else { $ActualPath -ceq $ExpectedPath }
    if (-not $Matched) { throw "UNEXPECTED_PROCESS_IDENTITY: name=$($Process.ProcessName); actual=$ActualPath; expected=$ExpectedPath" }
    @{ root = $Root; role = 'fixture'; id = $Process.Id; started = $Process.StartTime.ToUniversalTime().ToString('O');
        processIdentity = Get-TestProcessIdentity $Process; executable = $ActualPath } |
        ConvertTo-Json | Set-Content -LiteralPath ${quote(fixture.state)} -Encoding utf8
    `,
    );
    const managed = await waitReady(fixture);
    assert.equal(managed.id, id);
    assert.deepEqual(managed.args, unusualArguments);
    assert.equal(managed.cwd, fixture.directory);
    assert.equal(await canConnect(managed.port), true);
    assert.match(readFileSync(path.join(fixture.logs, 'fixture.stdout.log'), 'utf8'), /fixture stdout/);
    assert.match(readFileSync(path.join(fixture.logs, 'fixture.stderr.log'), 'utf8'), /fixture stderr/);
  } catch (error) {
    console.error(error.stack);
    throw error;
  }
});

runtimeTest('启动后登记失败会清理自己的真实进程并保留其他监听', async (t) => {
  const fixture = createFixture(t);
  try {
    const unknown = await startUnknown(fixture);
    const args = [fixture.worker, fixture.ready, '127.0.0.1', fixture.nonce];
    runPowerShell(
      fixture,
      `
    $Rejected = $false
    try { $null = Start-TestProcess 'fixture' @(${args.map(quote).join(',')}) $Root $Runtime 'fixture-fingerprint' }
    catch {
        if ($_.Exception.Message -match '独立进程身份无法确认') { throw }
        [Console]::Error.WriteLine($_.Exception.ToString())
        $Rejected = $true
    }
    if (-not $Rejected) { throw 'INVALID_REGISTRATION_PATH_ACCEPTED' }
    if (Test-Path -LiteralPath ${quote(fixture.ready)}) {
        $Ready = Get-Content -LiteralPath ${quote(fixture.ready)} -Raw | ConvertFrom-Json
        $Remaining = Get-Process -Id $Ready.id -ErrorAction SilentlyContinue
        if (-not (Test-TestProcessExited $Remaining)) {
            throw "FAILED_PROCESS_NOT_CLEANED: id=$($Ready.id); name=$($Remaining.ProcessName); path=$($Remaining.Path)"
        }
    }
    `,
    );
    if (existsSync(fixture.ready)) {
      const managed = JSON.parse(readFileSync(fixture.ready, 'utf8'));
      assert.equal(await canConnect(managed.port), false, '登记失败后，本次创建的监听必须已经关闭。');
    }
    assert.equal(await canConnect(unknown.port), true);
  } catch (error) {
    console.error(error.stack);
    throw error;
  }
});

runtimeTest('监听工具在 PATH 中有多个入口时只执行首个应用并保留参数边界', (t) => {
  const fixture = createFixture(t);
  try {
    const output = runPowerShell(
      fixture,
      `
    <# .SYNOPSIS 模拟同一应用在 PATH 中的多个入口，不改变宿主 PATH。 #>
    function Get-Command {
        param([string]$Name, [string]$CommandType, [string]$ErrorAction)
        try {
            if ($Name -cne 'fixture-listener') { throw 'UNEXPECTED_COMMAND_LOOKUP' }
            return @([pscustomobject]@{ Source = $Node }, [pscustomobject]@{ Source = (Join-Path $Root 'missing second executable') })
        } catch { throw }
    }
    $Result = Invoke-TestListenerCommand 'fixture-listener' @('-e', 'process.stdout.write(process.argv[1]);process.stderr.write("diagnostic");', 'value with spaces')
    if ($Result.ExitCode -ne 0 -or $Result.Output -cne 'value with spaces' -or $Result.ErrorOutput -cne 'diagnostic') {
        throw "LISTENER_EXECUTION_INVALID: exit=$($Result.ExitCode); stdout=$($Result.Output); stderr=$($Result.ErrorOutput)"
    }
    Write-Output 'FIRST_APPLICATION_PASS'
    `,
    );
    assert.match(output, /FIRST_APPLICATION_PASS/);
  } catch (error) {
    console.error(error.stack);
    throw error;
  }
});

runtimeTest('Linux 与 macOS 监听解析保留地址和所有者，并对未知 PID 与无法查询保持关闭', (t) => {
  const fixture = createFixture(t);
  try {
    const output = runPowerShell(
      fixture,
      `
    $Ss = 'LISTEN 0 511 0.0.0.0:49152 0.0.0.0:* users:(("node",pid=4242,fd=18))'
    $Linux = @(ConvertFrom-TestSsListeners -Output $Ss -Port 49152)
    if ($Linux.Count -ne 1 -or $Linux[0].LocalAddress -cne '0.0.0.0' -or $Linux[0].LocalPort -ne 49152 -or $Linux[0].OwningProcess -ne 4242) { throw 'LINUX_LISTENER_INVALID' }
    $Lsof = "p4242\`nf18\`ntIPv4\`nn127.0.0.1:49152\`n"
    $Mac = @(ConvertFrom-TestLsofListeners -Output $Lsof -Port 49152)
    if ($Mac.Count -ne 1 -or $Mac[0].LocalAddress -cne '127.0.0.1' -or $Mac[0].OwningProcess -ne 4242) { throw 'MAC_LISTENER_INVALID' }
    $Wildcard = @(ConvertFrom-TestLsofListeners -Output "p4242\`nf18\`ntIPv4\`nn*:49152\`nf19\`ntIPv6\`nn*:49152\`n" -Port 49152)
    if ($Wildcard.Count -ne 2 -or $Wildcard[0].LocalAddress -cne '0.0.0.0' -or $Wildcard[1].LocalAddress -cne '::') { throw 'MAC_ADDRESS_FAMILY_LOST' }
    $Ipv6 = @(ConvertFrom-TestSsListeners -Output 'LISTEN 0 511 [::1]:49152 [::]:* users:(("node",pid=4242,fd=18))' -Port 49152)
    if ($Ipv6[0].LocalAddress -cne '::1') { throw 'IPV6_LISTENER_ADDRESS_LOST' }
    foreach ($BadOutput in @(
        'LISTEN 0 511 0.0.0.0:49152 0.0.0.0:*',
        'LISTEN 0 511 0.0.0.0:49152 0.0.0.0:* users:(("node",pid=4242,fd=18),("hidden",fd=19))',
        'unexpected output'
    )) {
        $Rejected = $false
        try { $null = ConvertFrom-TestSsListeners -Output $BadOutput -Port 49152 } catch { $Rejected = $true }
        if (-not $Rejected) { throw 'UNKNOWN_LINUX_OWNER_ACCEPTED' }
    }
    foreach ($BadOutput in @("n127.0.0.1:49152\`n", "p4242\`nf18\`nn*:49152\`n", 'unexpected output')) {
        $Rejected = $false
        try { $null = ConvertFrom-TestLsofListeners -Output $BadOutput -Port 49152 } catch { $Rejected = $true }
        if (-not $Rejected) { throw 'UNKNOWN_MAC_OWNER_ACCEPTED' }
    }
    function Get-TestRuntimePlatform { return 'Linux' }
    function Invoke-TestListenerCommand { throw 'FIXTURE_MISSING_SS' }
    $Rejected = $false
    try { Assert-TestPort 49152 } catch { $Rejected = $true }
    if (-not $Rejected) { throw 'UNAVAILABLE_LISTENER_QUERY_ACCEPTED' }
    function Invoke-TestListenerCommand { return @{ ExitCode = 1; Output = ''; ErrorOutput = '' } }
    $Rejected = $false
    try { Assert-TestPort 49152 } catch { $Rejected = $true }
    if (-not $Rejected) { throw 'FAILED_SS_QUERY_ACCEPTED' }
    function Get-TestRuntimePlatform { return 'macOS' }
    if (@(Get-TestRuntimePortListeners 49152).Count -ne 0) { throw 'EMPTY_LSOF_QUERY_REJECTED' }
    function Invoke-TestListenerCommand { return @{ ExitCode = 1; Output = ''; ErrorOutput = 'permission denied' } }
    $Rejected = $false
    try { Assert-TestPort 49152 } catch { $Rejected = $true }
    if (-not $Rejected) { throw 'FAILED_LSOF_QUERY_ACCEPTED' }
    Write-Output 'PARSER_BOUNDARIES_PASS'
    `,
    );
    assert.match(output, /PARSER_BOUNDARIES_PASS/);
  } catch (error) {
    console.error(error.stack);
    throw error;
  }
});
