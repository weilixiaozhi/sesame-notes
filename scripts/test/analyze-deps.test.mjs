import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '../..');
const TEMP = join(ROOT, 'Temp');

const ownedFixtures = new Set();

/** 受控 CLI 的测试初始化辅助属于测试支持，不能仅凭相似文件名豁免业务代码。 */
test('测试初始化辅助按精确入口分类，业务同名文件仍进入生产图', () => {
  const fixture = createFixture('test-initialization-fixture');
  const output = join(fixture, 'analysis.json');
  try {
    const sources = {
      'apps/api/src/admin-test-initialization.ts': 'export const initialize = () => undefined;',
      'apps/api/src/admin-test-bootstrap.ts':
        "import { initialize } from './admin-test-initialization.js'; initialize();",
      'apps/api/src/modules/a/admin-test-initialization.ts': 'export const value = 1;',
      'apps/api/src/server.ts': "import { value } from './modules/a/admin-test-initialization.js'; void value;",
    };
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), source);
    }
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts/check/analyze-deps.mjs'), '--out', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.ok(result.testFiles.includes('apps/api/src/admin-test-initialization.ts'));
    assert.ok(result.testFiles.includes('apps/api/src/admin-test-bootstrap.ts'));
    assert.ok(!result.productionFiles.includes('apps/api/src/admin-test-initialization.ts'));
    assert.ok(result.productionFiles.includes('apps/api/src/modules/a/admin-test-initialization.ts'));
    assert.ok(result.productionFiles.includes('apps/api/src/server.ts'));
  } catch (cause) {
    throw new Error('测试初始化辅助的生产图分类回归失败', { cause });
  } finally {
    removeFixture(fixture);
  }
});

test('生产图与测试消费分离，require 和 import type 保留真实依赖及硬门禁', () => {
  const fixture = createFixture('source-scopes-fixture');
  const output = join(fixture, 'analysis.json');
  const files = {
    'apps/api/src/modules/a/value.ts': 'export interface Entity { id: string }; export const value = 1;',
    'apps/api/src/modules/a/index.ts': "export { type Entity, value } from './value.js';",
    'apps/api/src/modules/a/testing.ts': "export { value } from './value.js';",
    'apps/api/src/modules/b/use.ts':
      "type Row = import('../a/index.js').Entity; const data = require('../a/index.js'); export const use = (row: Row) => [row, data];",
    'apps/api/src/modules/a/value.test.ts': "import { use } from '../b/use.js'; void use;",
    'scripts/check.cjs': "const { value } = require('../apps/api/src/modules/a/index.js'); void value;",
  };
  /** 运行真实入口并读取输出，保留非零状态用于验证缺失依赖。 */
  function analyze() {
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts/check/analyze-deps.mjs'), '--out', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.ifError(run.error);
    return { ...run, result: JSON.parse(readFileSync(output, 'utf8')) };
  }
  try {
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), source);
    }
    const valid = analyze();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.result.scopes.serverProduction.files.length, 3);
    assert.equal(valid.result.scopes.serverProduction.edgeCount, 3);
    assert.equal(valid.result.scopes.serverProduction.typeOnlyEdgeCount, 1);
    assert.deepEqual(valid.result.scopes.serverProduction.dirSccs, []);
    assert.equal(valid.result.dirSccs.length, 1, '测试反向消费仍存在于全仓聚合图');
    assert.equal(valid.result.testFiles.length, 2);
    const testOnlyExport = valid.result.fileAnalysis
      .find((file) => file.file.endsWith('/b/use.ts'))
      .symbols.find((symbol) => symbol.sym === 'use');
    assert.deepEqual(testOnlyExport.consumedBy, ['test'], '测试消费不可冒充生产调用');
    assert.ok(valid.result.consumerEdges.some((edge) => edge.consumerRole === 'test' && edge.to.endsWith('/b/use.ts')));
    assert.ok(valid.result.edges.some((edge) => edge.kind === 'import-type' && edge.symbols.includes('Entity')));
    assert.ok(valid.result.edges.some((edge) => edge.kind === 'require' && edge.from.endsWith('check.cjs')));
    writeFileSync(join(fixture, 'scripts/check.cjs'), "require('./missing.cjs');");
    const missing = analyze();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /未解析相对导入/);
    writeFileSync(join(fixture, 'scripts/check.cjs'), 'require(process.env.MODULE);');
    assert.equal(analyze().result.opaqueImports[0].kind, 'require');
    writeFileSync(join(fixture, 'apps/api/src/modules/a/value.ts'), "export type Loop = import('../b/use.js').use;");
    const cycle = analyze();
    assert.equal(cycle.status, 1, '纯类型文件环仍受现有全仓硬门禁保护');
    assert.match(cycle.stderr, /文件级循环依赖/);
  } catch (cause) {
    throw new Error('生产范围与扩展导入语法回归失败', { cause });
  } finally {
    removeFixture(fixture);
  }
});

/** 仅创建本次唯一目录；既有同名目录、符号链接及祖先 junction 均不得复用。 */
function createFixture(prefix) {
  assert.match(prefix, /^[a-z-]+$/);
  const ancestors = [];
  for (let current = TEMP; ; current = dirname(current)) {
    ancestors.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const ancestor of ancestors) {
    if (!existsSync(ancestor)) continue;
    const entry = lstatSync(ancestor);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'fixture 祖先必须是普通目录');
  }
  mkdirSync(TEMP, { recursive: true });
  const fixture = join(TEMP, `${prefix}-${process.pid}-${randomUUID()}`);
  // 不使用 recursive：即使随机身份碰撞也必须失败，不能把旧目录认成本次所有。
  mkdirSync(fixture);
  ownedFixtures.add(fixture);
  return fixture;
}

/** Windows 删除及全部删除前路径核验只在固定的 PowerShell 5.1 进程内执行。 */
function removeFixture(fixture) {
  assert.ok(ownedFixtures.has(fixture), '只允许清理本次成功创建的 fixture');
  assert.equal(resolve(fixture), fixture);
  assert.equal(relative(TEMP, fixture), basename(fixture));
  if (process.platform !== 'win32') {
    rmSync(fixture, { recursive: true, force: true });
    ownedFixtures.delete(fixture);
    return;
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Fixture cleanup requires Windows PowerShell 5.1.'
  }
  $workspace = [IO.Path]::GetFullPath($env:SESAME_DEP_FIXTURE_ROOT)
  $target = [IO.Path]::GetFullPath($env:SESAME_DEP_FIXTURE_PATH)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($workspace, 'Temp'))
  if (-not [IO.Path]::IsPathRooted($workspace) -or -not [IO.Path]::IsPathRooted($target) -or
      -not [string]::Equals($workspace, $env:SESAME_DEP_FIXTURE_ROOT, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($target, $env:SESAME_DEP_FIXTURE_PATH, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([IO.Path]::GetDirectoryName($target), $tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($target) -cnotmatch '^[a-z-]+-fixture-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
    throw 'Fixture cleanup path is outside the exact owned directory.'
  }
  # 先从盘符根逐级核验祖先，遇到链接就停止，不能穿过 junction 后再检查子目录。
  $ancestors = New-Object 'System.Collections.Generic.List[string]'
  for ($current = $target; $current; $current = [IO.Path]::GetDirectoryName($current)) {
    $ancestors.Insert(0, $current)
  }
  foreach ($path in $ancestors) {
    $entry = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $entry.PSIsContainer -or
        ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        -not [string]::Equals($entry.FullName, $path, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Fixture cleanup refuses linked or unresolved ancestors.'
    }
  }
  # 只枚举本次目标的子树；不读取同级旧 Temp 内容，也不删除 Temp 父目录。
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($target)
  while ($pending.Count -gt 0) {
    foreach ($entry in Get-ChildItem -LiteralPath $pending.Pop() -Force -ErrorAction Stop) {
      $child = [IO.Path]::GetFullPath($entry.FullName)
      if (-not $child.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
          ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Fixture cleanup refuses links or paths outside its subtree.'
      }
      if ($entry.PSIsContainer) { $pending.Push($child) }
    }
  }
  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SESAME_DEP_FIXTURE_ROOT: ROOT, SESAME_DEP_FIXTURE_PATH: fixture },
    encoding: 'utf8',
  });
  ownedFixtures.delete(fixture);
}

test('named re-export 链无最终消费者时符号判为未使用（反向传播可达性）', () => {
  // fixture：aa 定义两个符号 → barrel bb re-export → barrel cc 再 re-export；
  // scripts 消费者只导入其中一个。未被最终消费者使用的符号必须报 unused。
  const fixture = createFixture('reexport-fixture');
  const output = join(fixture, 'analysis.json');
  const files = {
    'apps/api/src/modules/aa/mod.ts':
      'export const orphanThroughBarrels = 1;\nexport const consumedThroughBarrels = 2;\n',
    'apps/api/src/modules/aa/index.ts': "export { orphanThroughBarrels, consumedThroughBarrels } from './mod.js';\n",
    'apps/api/src/modules/bb/index.ts':
      "export { orphanThroughBarrels, consumedThroughBarrels } from '../aa/index.js';\n",
    'apps/api/src/modules/cc/index.ts':
      "export { orphanThroughBarrels, consumedThroughBarrels } from '../bb/index.js';\n",
    'scripts/fixture-consumer.ts':
      "import { consumedThroughBarrels } from '../apps/api/src/modules/cc/index.js';\nconsole.log(consumedThroughBarrels);\n",
  };
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(fixture, rel, '..'), { recursive: true });
      writeFileSync(join(fixture, rel), content, 'utf8');
    }
    execFileSync(process.execPath, [join(ROOT, 'scripts/check/analyze-deps.mjs'), '--out', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    const result = JSON.parse(readFileSync(output, 'utf8'));
    const mod = result.fileAnalysis.find((entry) => entry.file === 'apps/api/src/modules/aa/mod.ts');
    assert.ok(mod, 'fixture 定义文件必须出现在分析结果中');
    const bySym = Object.fromEntries(mod.symbols.map((s) => [s.sym, s.used]));
    assert.equal(bySym.consumedThroughBarrels, true, '有最终消费者的符号必须报 used');
    assert.equal(bySym.orphanThroughBarrels, false, '无最终消费者的 named re-export 链必须报 unused');
  } finally {
    removeFixture(fixture);
  }
});

test('手写依赖图允许目录聚合环，但拒绝真实文件环和缺失导入', () => {
  const fixture = createFixture('handwritten-fixture');
  const output = join(fixture, 'analysis.json');
  const consumers = [
    'eslint.config.js',
    'vitest.config.mts',
    'apps/api/vitest.config.ts',
    'apps/api/scripts/check.cts',
    'apps/api/prisma/seed.ts',
    'apps/api/test/boundary.test.ts',
    'packages/api-client/scripts/generate.mjs',
    'packages/api-client/test/boundary.test.ts',
    'scripts/check.cjs',
    'eslint-rules/check.js',
  ].sort();
  const target = 'apps/api/src/modules/aa';
  const files = {
    [`${target}/index.ts`]: "export { value } from './internal.js';\n",
    [`${target}/internal.ts`]:
      "import { generated } from '../../../../../packages/api-client/src/generated/api.js';\nexport const value = generated;\n",
    'packages/api-client/src/generated/api.ts': 'export const generated = 1;\n',
    'apps/api/dist/excluded.js': "import './missing.js';\n",
    'apps/api/coverage/excluded.js': "import './missing.js';\n",
    'apps/api/build/excluded.js': "import './missing.js';\n",
    'scripts/Temp/excluded.ts': "import './missing.js';\n",
    'packages/api-client/scripts/generated/excluded.ts': "import './missing.js';\n",
    'apps/api/test/types.d.ts': "import './missing.js';\n",
    'apps/api/test/types.d.mts': "import './missing.js';\n",
    'scripts/.cache/excluded.ts': "import './missing.js';\n",
    'node_modules/excluded.ts': "import './missing.js';\n",
    'Temp/excluded.ts': "import './missing.js';\n",
  };
  /** 通过真实相对路径构造各消费方导入，只改变目标是否为公共出口。 */
  function writeConsumer(file, entry) {
    const specifier = relative(dirname(file), `${target}/${entry}.js`).replaceAll('\\', '/');
    writeFileSync(
      join(fixture, file),
      `import { value } from '${specifier.startsWith('.') ? specifier : `./${specifier}`}';\nvoid value;\n`,
    );
  }
  /** 运行完整 CLI，读取退出码与诊断文件，保留源码清单和分层口径。 */
  function analyze() {
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts/check/analyze-deps.mjs'), '--out', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.ifError(run.error);
    return { ...run, result: JSON.parse(readFileSync(output, 'utf8')) };
  }
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), content);
    }
    for (const file of consumers) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeConsumer(file, 'index');
    }
    const valid = analyze();
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(valid.result.coreFiles, [`${target}/index.ts`, `${target}/internal.ts`]);
    assert.deepEqual(valid.result.consumerFiles, consumers);
    assert.equal(valid.result.files.consumer, consumers.length);
    assert.equal(valid.result.files.rawCore, 3);
    assert.equal(valid.result.files.generatedCore, 1);
    assert.equal(valid.result.files.core, valid.result.files.handwrittenCore);
    assert.equal(valid.result.files.rawCore, valid.result.files.handwrittenCore + valid.result.files.generatedCore);
    assert.equal(valid.result.files.generatedCore, valid.result.generatedFiles.length);
    assert.ok(valid.result.coreFiles.every((file) => !file.includes('/generated/')));
    assert.ok(
      valid.result.edges.every((edge) => !edge.from.includes('/generated/') && !edge.to.includes('/generated/')),
    );
    assert.ok(valid.result.inDegree.every(([file]) => !file.includes('/generated/')));
    // 两条独立文件边聚合到目录后成环，不应阻止合法依赖。
    const aggregateEdges = {
      'apps/api/src/modules/aa/use.ts': "import '../bb/value.js';\n",
      'apps/api/src/modules/bb/use.ts': "import '../aa/internal.js';\n",
      'apps/api/src/modules/bb/value.ts': 'export const value = 1;\n',
    };
    for (const [file, source] of Object.entries(aggregateEdges)) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), source);
    }
    assert.equal(analyze().status, 0, '只有目录聚合环时应通过，深导入由 ESLint 单独检查');

    writeFileSync(join(fixture, `${target}/internal.ts`), "import './index.js';\nexport const value = 1;\n");
    const cycle = analyze();
    assert.equal(cycle.status, 1);
    assert.match(cycle.stderr, /文件级循环依赖/);

    writeFileSync(join(fixture, `${target}/internal.ts`), "import './missing.js';\nexport const value = 1;\n");
    const missing = analyze();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /未解析相对导入/);
  } catch (error) {
    console.error('手写源码依赖图验证失败', { fixture, error });
    throw error;
  } finally {
    removeFixture(fixture);
  }
});

test('NodeNext 脚本后缀能解析，手写脚本引用生成代码仍不纳入图', () => {
  const fixture = createFixture('script-suffix-fixture');
  const output = join(fixture, 'analysis.json');
  const files = {
    'scripts/esm.mts': "import { value } from './value.mjs';\nvoid value;\n",
    'scripts/value.mts': 'export const value = 1;\n',
    'scripts/cjs.cts': "import { value } from './value.cjs';\nvoid value;\n",
    'scripts/value.cts': 'export const value = 2;\n',
    'scripts/generate.mjs': "import { generated } from './generated/value.js';\nvoid generated;\n",
    'scripts/generated/value.js': 'export const generated = 3;\n',
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), content);
    }
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts/check/analyze-deps.mjs'), '--out', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `合法脚本导入必须通过：${run.stderr}`);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(
      result.consumerFiles,
      Object.keys(files)
        .filter((file) => !file.includes('/generated/'))
        .sort(),
    );
    assert.deepEqual(result.edges.map(({ from, to }) => [from, to]).sort(), [
      ['scripts/cjs.cts', 'scripts/value.cts'],
      ['scripts/esm.mts', 'scripts/value.mts'],
    ]);
  } catch (error) {
    console.error('脚本后缀与生成依赖范围验证失败', { fixture, error });
    throw error;
  } finally {
    removeFixture(fixture);
  }
});

test('DAG 维度：目录级单边符号负载按边统计去重符号', () => {
  // fixture：两个消费方目录分别从不同文件导入 cc 出口的符号，
  // 单边符号负载 = 该目录边上不同符号名去重计数（不按导入次数重复计）。
  const fixture = createFixture('edge-symbols-fixture');
  const output = join(fixture, 'analysis.json');
  const files = {
    'apps/api/src/modules/cc/index.ts': 'export const s1 = 1;\nexport const s2 = 2;\nexport const s3 = 3;\n',
    'scripts/load.ts': "import { s1, s2 } from '../apps/api/src/modules/cc/index.js';\nconsole.log(s1, s2);\n",
    'apps/api/test/load.test.ts':
      "import { s2, s3 } from '../src/modules/cc/index.js';\nimport { s1 } from '../src/modules/cc/index.js';\nconsole.log(s1, s2, s3);\n",
  };
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(fixture, rel, '..'), { recursive: true });
      writeFileSync(join(fixture, rel), content, 'utf8');
    }
    execFileSync(process.execPath, [join(ROOT, 'scripts/check/analyze-deps.mjs'), '--out', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    const result = JSON.parse(readFileSync(output, 'utf8'));

    const byEdge = Object.fromEntries(result.dirEdgeSymbols.map((e) => [`${e.from}->${e.to}`, e]));
    const scriptsEdge = byEdge['scripts->apps/api/src/modules/cc'];
    assert.ok(scriptsEdge, 'scripts 到 cc 的目录边必须存在');
    assert.equal(scriptsEdge.symbols, 2, 'scripts 单边符号负载为 2');
    assert.deepEqual(scriptsEdge.names, ['s1', 's2']);
    assert.equal(scriptsEdge.edges, 1);

    const testEdge = byEdge['apps/api/test->apps/api/src/modules/cc'];
    assert.ok(testEdge, 'test 到 cc 的目录边必须存在');
    assert.equal(testEdge.symbols, 3, '同一消费方多条导入边的符号并集去重');
    assert.deepEqual(testEdge.names, ['s1', 's2', 's3']);
    assert.equal(testEdge.edges, 2);
  } finally {
    removeFixture(fixture);
  }
});

test('目录级聚合精确：test 与 prisma 消费方归入自身目录节点而非文件路径', () => {
  // fixture：apps/api/test 与 apps/api/prisma 下的文件分别导入模块出口，
  // dirEdgeCount 的目录边应从消费方目录（而非文件路径本身）出发。
  const fixture = createFixture('dir-agg-fixture');
  const output = join(fixture, 'analysis.json');
  const files = {
    'apps/api/src/modules/aa/index.ts': 'export const a = 1;\n',
    'apps/api/test/load.test.ts': "import { a } from '../src/modules/aa/index.js';\nconsole.log(a);\n",
    'apps/api/prisma/seed.ts': "import { a } from '../src/modules/aa/index.js';\nconsole.log(a);\n",
  };
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(fixture, rel, '..'), { recursive: true });
      writeFileSync(join(fixture, rel), content, 'utf8');
    }
    execFileSync(process.execPath, [join(ROOT, 'scripts/check/analyze-deps.mjs'), '--out', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    const result = JSON.parse(readFileSync(output, 'utf8'));
    const counts = Object.fromEntries(result.dirEdgeCount);
    assert.equal(counts['apps/api/test->apps/api/src/modules/aa'], 1, 'test 目录边聚合为一条');
    assert.equal(counts['apps/api/prisma->apps/api/src/modules/aa'], 1, 'prisma 目录边聚合为一条');
    assert.ok(
      Object.keys(counts).every((key) => !key.includes('apps/api/test/') && !key.includes('apps/api/prisma/')),
      '不得出现以消费方文件路径为目录节点的边',
    );
  } finally {
    removeFixture(fixture);
  }
});

test('前端目录入口、JSX 内动态依赖和默认导出纳入完整源码分析', () => {
  const fixture = createFixture('frontend-fixture');
  const output = join(fixture, 'analysis.json');
  const files = {
    'apps/web/src/main.tsx':
      "import Screen from './screens';\nexport const view = <Screen loader={() => import('./lazy.jsx')} />;\n",
    'apps/web/src/screens/index.tsx': "export { default } from './screen';\n",
    'apps/web/src/screens/screen.tsx':
      'export default function Screen() { return <article />; }\nexport function unusedScreen() { return <p />; }\n',
    'apps/web/src/lazy.tsx': 'export default () => <aside />;\n',
    'apps/admin/src/main.tsx': "import { AuditPage } from './pages';\nvoid AuditPage;\n",
    'apps/admin/src/pages/index.tsx': "export { AuditPage } from './audit';\n",
    'apps/admin/src/pages/audit.tsx': 'export function AuditPage() { return <span />; }\n',
  };

  /** 运行真实分析入口，核对文件依赖及退出状态而不执行任何业务模块。 */
  function analyze() {
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts/check/analyze-deps.mjs'), '--out', output], {
      cwd: fixture,
      encoding: 'utf8',
    });
    assert.ifError(run.error);
    return { ...run, result: JSON.parse(readFileSync(output, 'utf8')) };
  }

  try {
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      writeFileSync(join(fixture, file), source);
    }
    const valid = analyze();
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(valid.result.coreFiles, Object.keys(files).sort());
    assert.ok(
      valid.result.edges.some(
        (edge) => edge.from === 'apps/web/src/main.tsx' && edge.to === 'apps/web/src/screens/index.tsx',
      ),
      '目录导入必须指向实际入口文件',
    );
    assert.ok(
      valid.result.edges.some((edge) => edge.kind === 'dynamic' && edge.to === 'apps/web/src/lazy.tsx'),
      'JSX 表达式中的动态依赖必须被解析',
    );
    const screen = valid.result.fileAnalysis.find((entry) => entry.file === 'apps/web/src/screens/screen.tsx');
    assert.deepEqual(
      Object.fromEntries(screen.symbols.map((symbol) => [symbol.sym, symbol.used])),
      { default: true, unusedScreen: false },
      '命名默认组件必须按 default 传播用量，未消费符号仍可被识别',
    );

    // 目录入口构成的真实文件环必须阻止分析通过。
    writeFileSync(
      join(fixture, 'apps/admin/src/pages/audit.tsx'),
      "import '../main';\nexport function AuditPage() { return <span />; }\n",
    );
    const cycle = analyze();
    assert.equal(cycle.status, 1);
    assert.match(cycle.stderr, /文件级循环依赖/);

    // 只有目录而没有源码入口不能被误判为已解析的依赖。
    writeFileSync(join(fixture, 'apps/admin/src/pages/audit.tsx'), files['apps/admin/src/pages/audit.tsx']);
    mkdirSync(join(fixture, 'apps/web/src/empty'));
    writeFileSync(join(fixture, 'apps/web/src/main.tsx'), "import './empty';\n");
    const missing = analyze();
    assert.equal(missing.status, 1);
    assert.deepEqual(missing.result.unresolved, [{ spec: './empty', files: ['apps/web/src/main.tsx'] }]);
  } finally {
    removeFixture(fixture);
  }
});
