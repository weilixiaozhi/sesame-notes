import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { generateApiClientTypes } from '../../packages/api-client/scripts/generate.mjs';

const root = resolve(import.meta.dirname, '../..');
const tempRoot = resolve(root, 'Temp');
const fixtureSpec = {
  openapi: '3.0.3',
  info: { title: '生成一致性夹具', version: '1.0.0' },
  paths: {
    '/items': {
      get: {
        operationId: 'getItems',
        responses: { 200: { description: '成功', content: { 'application/json': { schema: { type: 'string' } } } } },
      },
    },
  },
};

/** 生成输入和输出全部置于仓库 Temp 的本轮独占目录，结束时只清理该目录。 */
async function withFixture(operation) {
  let directory;
  try {
    await mkdir(tempRoot, { recursive: true });
    directory = await mkdtemp(resolve(tempRoot, 'contract-fix-generation-'));
    const inputPath = resolve(directory, 'openapi.json');
    await writeFile(inputPath, JSON.stringify(fixtureSpec));
    await operation({ directory, input: pathToFileURL(inputPath), output: resolve(directory, 'api.ts') });
  } finally {
    if (directory) {
      const actual = await realpath(directory);
      assert.equal(dirname(actual), await realpath(tempRoot));
      assert.ok(actual.includes('contract-fix-generation-'));
      await rm(actual, { recursive: true });
    }
  }
}

test('检查匹配类型时保留生成文件正文和修改时间', async () => {
  await withFixture(async (options) => {
    await generateApiClientTypes(options);
    const before = await readFile(options.output, 'utf8');
    const fixedTime = new Date('2000-01-01T00:00:00.000Z');
    await utimes(options.output, fixedTime, fixedTime);
    const timestamp = (await stat(options.output)).mtimeMs;
    const result = await generateApiClientTypes({ ...options, check: true });
    assert.equal(result.checked, true);
    assert.equal(result.characters, before.length);
    assert.equal(await readFile(options.output, 'utf8'), before);
    assert.equal((await stat(options.output)).mtimeMs, timestamp);
  });
});

test('检查发现漂移时失败且不覆盖现有生成文件', async () => {
  await withFixture(async (options) => {
    const sentinel = '// 待人工审阅的生成差异\n';
    await writeFile(options.output, sentinel);
    await assert.rejects(generateApiClientTypes({ ...options, check: true }), (error) => {
      assert.match(error.message, /不一致/);
      return true;
    });
    assert.equal(await readFile(options.output, 'utf8'), sentinel);
  });
});

test('检查缺失输出时失败且不创建输出目录', async () => {
  await withFixture(async (options) => {
    const output = resolve(options.directory, 'missing', 'api.ts');
    await assert.rejects(generateApiClientTypes({ ...options, output, check: true }), (error) => {
      assert.equal(error.code, 'ENOENT');
      return true;
    });
    await assert.rejects(access(dirname(output)), { code: 'ENOENT' });
  });
});

test('命令行拒绝未知参数并返回非零状态和友好诊断', async () => {
  await withFixture(async ({ directory }) => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'packages/api-client/scripts/generate.mjs'), '--unknown'],
      {
        cwd: directory,
        encoding: 'utf8',
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 1);
    assert.match(result.stderr, /API Client 类型处理未完成/);
    assert.match(result.stderr, /用法：node scripts\/generate.mjs \[--check\]/);
  });
});
