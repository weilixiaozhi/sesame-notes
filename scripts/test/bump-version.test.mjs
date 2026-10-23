import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { bumpVersion } from '../build-tools/bump-version.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const TEMP = join(ROOT, 'Temp');
const COMPONENTS = ['api', 'web', 'admin'];
const INITIAL_VERSIONS = { api: '0.1.0', web: '1.0.0', admin: '0.1.0' };
const TRACKED_FILES = [...COMPONENTS.map((component) => `apps/${component}/package.json`), 'pnpm-lock.yaml'];

/** 为测试夹具写入文件；错误包含具体路径，便于定位文件系统失败。 */
async function writeFixtureFile(path, text) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  } catch (error) {
    throw new Error(`无法写入版本测试夹具：${path}`, { cause: error });
  }
}

/** 读取完整文本，保留缩进、换行与结尾空白以检查无关内容是否被改动。 */
async function readFixtureFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`无法读取版本测试夹具：${path}`, { cause: error });
  }
}

/** 列出夹具目录的直接子文件，用于确认锁与中间文件均被正确清理。 */
async function fixtureEntries(path) {
  try {
    return await readdir(path);
  } catch (error) {
    throw new Error(`无法列出版本测试夹具：${path}`, { cause: error });
  }
}

/** 只清理本次创建且真实位于项目 Temp 中的夹具，拒绝符号链接与越界路径。 */
async function removeFixture(directory) {
  try {
    const resolved = resolve(directory);
    const location = relative(TEMP, resolved);
    assert.ok(location && !isAbsolute(location) && !location.startsWith(`..${sep}`));
    assert.equal(dirname(resolved), TEMP);
    assert.ok(basename(resolved).startsWith('bump-version-test-'));
    assert.equal((await lstat(resolved)).isSymbolicLink(), false);
    assert.equal(await realpath(resolved), resolved);
    await rm(resolved, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`无法安全清理版本测试夹具：${directory}`, { cause: error });
  }
}

/** 创建不含 Git 历史的最小三端仓库，所有临时内容均位于项目根目录的 Temp 中。 */
async function createFixture(context) {
  let directory;
  try {
    await mkdir(TEMP, { recursive: true });
    directory = await mkdtemp(join(TEMP, 'bump-version-test-'));
    context.after(() => removeFixture(directory));
    const root = join(directory, 'repo');
    for (const component of COMPONENTS) {
      await writeFixtureFile(
        join(root, 'apps', component, 'package.json'),
        `${JSON.stringify(
          {
            name: `@sesame-notes/${component}`,
            version: INITIAL_VERSIONS[component],
            private: true,
            scripts: { build: 'echo fixture' },
          },
          null,
          2,
        )}\n`,
      );
    }
    await writeFixtureFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\nimporters: {}\n');
    return { root, directory };
  } catch (error) {
    throw new Error(`无法创建版本测试夹具：${directory ?? TEMP}`, { cause: error });
  }
}

/** 对三端清单及锁文件逐字节快照，确认版本变更只影响指定端。 */
async function snapshot(root) {
  try {
    return Object.fromEntries(
      await Promise.all(TRACKED_FILES.map(async (path) => [path, await readFixtureFile(join(root, path))])),
    );
  } catch (error) {
    throw new Error(`无法建立版本测试快照：${root}`, { cause: error });
  }
}

/** 根据测试预期只替换顶层版本文本，用完整文件对比检查其他内容保持不变。 */
function expectedSnapshot(before, component, version) {
  const file = `apps/${component}/package.json`;
  const previousVersion = JSON.parse(before[file]).version;
  return {
    ...before,
    [file]: before[file].replace(`"version": "${previousVersion}"`, `"version": "${version}"`),
  };
}

/** 在没有 Git 或包管理器可执行入口的环境中，从夹具外部工作目录运行真实 CLI。 */
async function runCli(fixture, args, execArgv = []) {
  try {
    const executable = join(fixture.root, 'scripts', 'build-tools', 'bump-version.mjs');
    await writeFixtureFile(executable, await readFixtureFile(join(ROOT, 'scripts', 'build-tools', 'bump-version.mjs')));
    const cwd = join(fixture.directory, 'unrelated-cwd');
    await mkdir(cwd, { recursive: true });
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    const result = spawnSync(process.execPath, [...execArgv, executable, ...args], {
      cwd,
      env: { ...environment, PATH: '' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    return result;
  } catch (error) {
    throw new Error(`无法执行版本脚本测试：${args.join(' ')}`, { cause: error });
  }
}

/** 建立链接夹具；仅当系统不允许创建链接时跳过，其他错误保留完整原因。 */
async function createFixtureLink(context, target, path, type) {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      context.skip(`当前系统无法创建符号链接：${error.code}`);
      return false;
    }
    throw new Error(`无法创建版本测试链接：${path}`, { cause: error });
  }
}

/** 将夹具移动到同一测试目录内，避免链接安全测试接触真实仓库文件。 */
async function moveFixture(source, target) {
  try {
    await rename(source, target);
  } catch (error) {
    throw new Error(`无法移动版本测试夹具：${source} -> ${target}`, { cause: error });
  }
}

for (const component of COMPONENTS) {
  test(`${component} 默认仅递增自身 patch，其他两端和锁文件保持逐字节不变`, async (context) => {
    const { root } = await createFixture(context);
    const before = await snapshot(root);
    const previousVersion = INITIAL_VERSIONS[component];
    const version = previousVersion.replace(/0$/, '1');
    assert.deepEqual(await bumpVersion(component, undefined, { root }), {
      component,
      previousVersion,
      version,
      dryRun: false,
    });
    assert.deepEqual(await snapshot(root), expectedSnapshot(before, component, version));
  });
}

test('patch、minor、major 按正式版本规则递增；重复调用基于已保存的版本', async (context) => {
  const { root } = await createFixture(context);
  const packagePath = join(root, 'apps/web/package.json');
  await writeFixtureFile(packagePath, '{"name":"@sesame-notes/web","version":"2.9.9"}\n');
  for (const [increment, previousVersion, version] of [
    ['patch', '2.9.9', '2.9.10'],
    ['patch', '2.9.10', '2.9.11'],
    ['minor', '2.9.11', '2.10.0'],
    ['major', '2.10.0', '3.0.0'],
  ]) {
    assert.deepEqual(await bumpVersion('web', increment, { root }), {
      component: 'web',
      previousVersion,
      version,
      dryRun: false,
    });
    assert.equal(JSON.parse(await readFixtureFile(packagePath)).version, version);
  }
});

test('写入保留 CRLF、制表符缩进、字段顺序和其他字段中的 version', async (context) => {
  const { root } = await createFixture(context);
  const packagePath = join(root, 'apps/admin/package.json');
  const original = [
    '{',
    '\t"metadata": { "version": "4.5.6" },',
    '\t"name": "@sesame-notes/admin",',
    '\t"version" : "4.5.6",',
    '\t"description": "版本字段 version 原样保留",',
    '\t"private": true',
    '}',
    '',
  ].join('\r\n');
  await writeFixtureFile(packagePath, original);
  await bumpVersion('admin', 'patch', { root });
  assert.equal(await readFixtureFile(packagePath), original.replace('\t"version" : "4.5.6"', '\t"version" : "4.5.7"'));
});

test('超出浮点整数精度的版本仍准确递增，超过长度限制时拒绝写入', async (context) => {
  const { root } = await createFixture(context);
  const packagePath = join(root, 'apps/web/package.json');
  await writeFixtureFile(packagePath, '{"name":"@sesame-notes/web","version":"9007199254740993.9.9"}\n');
  const result = await bumpVersion('web', 'major', { root });
  assert.equal(result.version, '9007199254740994.0.0');
  for (const [version, increment] of [
    [`${'9'.repeat(61)}.0.0`, 'patch'],
    [`${'9'.repeat(60)}.0.0`, 'major'],
  ]) {
    await writeFixtureFile(packagePath, `${JSON.stringify({ name: '@sesame-notes/web', version })}\n`);
    const before = await snapshot(root);
    await assert.rejects(async () => bumpVersion('web', increment, { root }));
    assert.deepEqual(await snapshot(root), before);
  }
});

test('识别转义后的顶层 version 键，重复字段必须拒绝以免写错版本', async (context) => {
  const { root } = await createFixture(context);
  const packagePath = join(root, 'apps/web/package.json');
  const escaped = '{"name":"@sesame-notes/web","vers\\u0069on":"1.2.3"}\n';
  await writeFixtureFile(packagePath, escaped);
  await bumpVersion('web', 'patch', { root });
  assert.equal(await readFixtureFile(packagePath), escaped.replace('1.2.3', '1.2.4'));
  await writeFixtureFile(packagePath, '{"name":"@sesame-notes/web","version":"1.2.3","vers\\u0069on":"1.2.3"}\n');
  const before = await snapshot(root);
  await assert.rejects(async () => bumpVersion('web', 'patch', { root }));
  assert.deepEqual(await snapshot(root), before);
});

test('dry-run 返回拟发布版本但不改变三端清单或锁文件', async (context) => {
  const { root } = await createFixture(context);
  const before = await snapshot(root);
  assert.deepEqual(await bumpVersion('api', 'minor', { root, dryRun: true }), {
    component: 'api',
    previousVersion: '0.1.0',
    version: '0.2.0',
    dryRun: true,
  });
  assert.deepEqual(await snapshot(root), before);
});

test('未知端、路径输入与未知递增方式在写入前拒绝', async (context) => {
  const { root } = await createFixture(context);
  const before = await snapshot(root);
  for (const component of [undefined, '', 'backend', 'Web', '../web', 'apps/api', root, 'web ']) {
    await assert.rejects(async () => bumpVersion(component, 'patch', { root }));
    assert.deepEqual(await snapshot(root), before);
  }
  for (const increment of ['', 'prerelease', 'PATCH', '../patch']) {
    await assert.rejects(async () => bumpVersion('web', increment, { root }));
    assert.deepEqual(await snapshot(root), before);
  }
});

test('缺失、非正式、畸形或非字符串版本必须拒绝且不截断原文件', async (context) => {
  const { root } = await createFixture(context);
  const packagePath = join(root, 'apps/web/package.json');
  for (const version of [
    undefined,
    '',
    '1.0',
    'v1.2.3',
    '1.2.3-beta.1',
    '1.2.3+build.1',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '-1.2.3',
    '1.2.3 ',
    null,
    123,
    {},
  ]) {
    await writeFixtureFile(packagePath, `${JSON.stringify({ name: '@sesame-notes/web', version }, null, 2)}\n`);
    const before = await snapshot(root);
    await assert.rejects(async () => bumpVersion('web', 'patch', { root }));
    assert.deepEqual(await snapshot(root), before);
  }
  await writeFixtureFile(packagePath, '{"name":"@sesame-notes/web","version":"1.2.3",');
  const before = await snapshot(root);
  await assert.rejects(async () => bumpVersion('web', 'patch', { root }));
  assert.deepEqual(await snapshot(root), before);
});

test('包名缺失或与指定端不符时拒绝更改', async (context) => {
  const { root } = await createFixture(context);
  for (const name of [undefined, '@sesame-notes/admin', '@sesame-notes/Web', 'web']) {
    await writeFixtureFile(join(root, 'apps/web/package.json'), `${JSON.stringify({ name, version: '1.2.3' })}\n`);
    const before = await snapshot(root);
    await assert.rejects(async () => bumpVersion('web', 'patch', { root }));
    assert.deepEqual(await snapshot(root), before);
  }
});

test('同一端的独占锁阻止重复操作，但不影响另外一端准备版本', async (context) => {
  const { root } = await createFixture(context);
  const lockPath = join(root, 'Temp/bump-version-web.lock');
  await writeFixtureFile(lockPath, 'another operation owns this lock\n');
  const before = await snapshot(root);
  await assert.rejects(async () => bumpVersion('web', 'patch', { root }), /锁定/);
  assert.deepEqual(await snapshot(root), before);
  await bumpVersion('api', 'patch', { root });
  assert.deepEqual(await snapshot(root), expectedSnapshot(before, 'api', '0.1.1'));
  assert.equal(await readFixtureFile(lockPath), 'another operation owns this lock\n');
  assert.deepEqual(await fixtureEntries(join(root, 'Temp')), ['bump-version-web.lock']);
});

test('CLI 不依赖 Git 或当前工作目录，发布 Web 只更新脚本所在仓库的 Web', async (context) => {
  const fixture = await createFixture(context);
  const decoy = join(fixture.directory, 'unrelated-cwd/apps/web/package.json');
  await writeFixtureFile(decoy, '{"name":"@sesame-notes/web","version":"99.0.0"}\n');
  const before = await snapshot(fixture.root);
  const result = await runCli(fixture, ['web']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /web/i);
  assert.match(result.stdout, /1\.0\.0/);
  assert.match(result.stdout, /1\.0\.1/);
  assert.deepEqual(await snapshot(fixture.root), expectedSnapshot(before, 'web', '1.0.1'));
  assert.equal(JSON.parse(await readFixtureFile(decoy)).version, '99.0.0');
});

test('CLI 支持 major、dry-run 和帮助，预览与帮助均不更改任何版本', async (context) => {
  const fixture = await createFixture(context);
  const before = await snapshot(fixture.root);
  const preview = await runCli(fixture, ['admin', 'major', '--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /1\.0\.0/);
  assert.deepEqual(await snapshot(fixture.root), before);
  const help = await runCli(fixture, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  for (const expected of ['api', 'web', 'admin', 'patch', 'minor', 'major', '--dry-run']) {
    assert.ok(help.stdout.includes(expected), `帮助文本应包含 ${expected}`);
  }
  assert.deepEqual(await snapshot(fixture.root), before);
  const release = await runCli(fixture, ['admin', 'major']);
  assert.equal(release.status, 0, release.stderr);
  assert.deepEqual(await snapshot(fixture.root), expectedSnapshot(before, 'admin', '1.0.0'));
});

test('CLI 缺参数、未知端、路径、选项或多余参数返回失败且保留全部文件', async (context) => {
  const fixture = await createFixture(context);
  const before = await snapshot(fixture.root);
  for (const args of [
    [],
    ['desktop'],
    ['../api'],
    ['api', 'unknown'],
    ['api', '--force'],
    ['api', 'patch', 'extra'],
    ['web', 'patch', '--dry-run', 'extra'],
    ['--dry-run'],
  ]) {
    const result = await runCli(fixture, args);
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stderr}`);
    assert.ok(result.stderr.trim(), '无效输入应输出友好错误信息');
    assert.deepEqual(await snapshot(fixture.root), before);
  }
});

test('CLI 写入被系统权限拒绝时返回失败且不截断现有文件', async (context) => {
  const fixture = await createFixture(context);
  const before = await snapshot(fixture.root);
  // 子进程保留全部读取权限并禁止写入，复现实际写入失败而不修改宿主文件权限。
  const result = await runCli(fixture, ['web'], ['--permission', '--allow-fs-read=*']);
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.trim(), '写入失败应输出可诊断的错误信息');
  assert.deepEqual(await snapshot(fixture.root), before);
});

test('CLI 原子替换失败时保留源文件、清理中间产物并保存详细错误日志', async (context) => {
  const fixture = await createFixture(context);
  const temporary = join(fixture.root, 'Temp');
  await writeFixtureFile(join(temporary, '.fixture'), '保留夹具标记\n');
  const before = await snapshot(fixture.root);
  const failureHook = join(fixture.directory, 'rename-failure.mjs');
  const target = join(fixture.root, 'apps/web/package.json');
  const expected = expectedSnapshot(before, 'web', '1.0.1')['apps/web/package.json'];
  // 在独立子进程中只替换目标清单的 rename，确保真实 CLI 已经完成临时文件写入和同步。
  await writeFixtureFile(
    failureHook,
    `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';

const originalRename = fs.promises.rename;
/** 只在清单最终替换边界注入错误，其他文件操作沿用真实文件系统。 */
fs.promises.rename = async function failManifestRename(source, destination) {
  if (destination !== ${JSON.stringify(target)}) return originalRename(source, destination);
  assert.equal(dirname(source), ${JSON.stringify(temporary)});
  assert.equal(await fs.promises.readFile(source, 'utf8'), ${JSON.stringify(expected)});
  throw Object.assign(new Error('injected rename access denied'), {
    code: 'ERR_ACCESS_DENIED', syscall: 'rename', path: source, dest: destination,
  });
};
syncBuiltinESMExports();
`,
  );
  const result = await runCli(fixture, ['web'], ['--import', pathToFileURL(failureHook).href]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /详细错误日志/);
  assert.deepEqual(await snapshot(fixture.root), before);
  const entries = await fixtureEntries(temporary);
  assert.equal(entries.filter((entry) => entry.endsWith('.tmp') || entry.endsWith('.lock')).length, 0);
  const logs = entries.filter((entry) => /^bump-version-error-.*\.log$/.test(entry));
  assert.equal(logs.length, 1);
  const log = await readFixtureFile(join(temporary, logs[0]));
  assert.match(log, /ERR_ACCESS_DENIED/);
  assert.match(log, /rename/);
  assert.match(log, /bumpVersion/);
});

for (const ancestor of ['', 'apps', 'apps/web']) {
  test(`拒绝通过 ${ancestor || '仓库根目录'} 目录链接修改仓库外部文件`, async (context) => {
    const fixture = await createFixture(context);
    const linkedPath = join(fixture.root, ancestor);
    const externalPath = join(fixture.directory, 'external-files');
    await moveFixture(linkedPath, externalPath);
    if (
      !(await createFixtureLink(context, externalPath, linkedPath, process.platform === 'win32' ? 'junction' : 'dir'))
    ) {
      return;
    }
    const before = await snapshot(fixture.root);
    await assert.rejects(async () => bumpVersion('web', 'patch', { root: fixture.root }));
    assert.deepEqual(await snapshot(fixture.root), before);
  });
}

test('拒绝在链接指向的 Temp 目录中创建锁、日志或中间文件', async (context) => {
  const fixture = await createFixture(context);
  const externalPath = join(fixture.directory, 'external-temp');
  await writeFixtureFile(join(externalPath, 'sentinel.txt'), '外部目录保持不变\n');
  if (
    !(await createFixtureLink(
      context,
      externalPath,
      join(fixture.root, 'Temp'),
      process.platform === 'win32' ? 'junction' : 'dir',
    ))
  ) {
    return;
  }
  const before = await snapshot(fixture.root);
  await assert.rejects(async () => bumpVersion('web', 'patch', { root: fixture.root }));
  assert.deepEqual(await snapshot(fixture.root), before);
  assert.deepEqual(await fixtureEntries(externalPath), ['sentinel.txt']);
});

test('拒绝通过 package.json 文件链接修改外部清单', async (context) => {
  const fixture = await createFixture(context);
  const packagePath = join(fixture.root, 'apps/web/package.json');
  const externalPath = join(fixture.directory, 'external-package.json');
  await moveFixture(packagePath, externalPath);
  if (!(await createFixtureLink(context, externalPath, packagePath, 'file'))) {
    return;
  }
  const before = await snapshot(fixture.root);
  await assert.rejects(async () => bumpVersion('web', 'patch', { root: fixture.root }));
  assert.deepEqual(await snapshot(fixture.root), before);
});
