import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { licenseAssetsPlugin } from '../../apps/build-tools/license-assets.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const TEMP = join(ROOT, 'Temp');
const webRequire = createRequire(pathToFileURL(join(ROOT, 'apps/web/package.json')));
const { build } = await import(pathToFileURL(webRequire.resolve('vite')).href);
const EXPECTED_FILES = [
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
  'third_party/exercises-dataset/LICENSE',
  'third_party/exercises-dataset/NOTICE.md',
  'third_party/libphonenumber/LICENSE',
];

/** 在仓库 Temp 内创建独立源码夹具，不修改正式许可或现有 dist。 */
async function fixture(t, { missing, empty } = {}) {
  try {
    await mkdir(TEMP, { recursive: true });
    const root = await mkdtemp(join(TEMP, 'license-assets-test-'));
    t.after(async () => {
      try {
        const suffix = relative(TEMP, root);
        assert.ok(suffix.startsWith('license-assets-test-') && !suffix.includes('..'));
        await rm(root, { recursive: true });
      } catch (cause) {
        throw new Error('许可测试夹具清理失败，请检查仓库 Temp 目录。', { cause });
      }
    });
    for (const fileName of EXPECTED_FILES) {
      if (fileName === missing) continue;
      const target = join(root, fileName);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, fileName === empty ? ' \r\n\t' : await readFile(join(ROOT, fileName)));
    }
    await writeFile(join(root, 'index.html'), '<!doctype html><html><body>许可打包测试</body></html>');
    return root;
  } catch (cause) {
    throw new Error('许可测试夹具准备失败，请检查源文件及 Temp 目录权限。', { cause });
  }
}

/** 使用真实 Vite 构建最小网页，验证 Rollup 资源实际落盘行为。 */
async function buildFixture(root) {
  return build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [licenseAssetsPlugin(pathToFileURL(`${root}/`))],
    build: { outDir: join(root, 'dist') },
  });
}

test('真实 Vite 构建按原路径完整保留全部许可字节', async (t) => {
  const root = await fixture(t);
  await buildFixture(root);
  for (const fileName of EXPECTED_FILES) {
    assert.deepEqual(await readFile(join(root, 'dist', fileName)), await readFile(join(ROOT, fileName)), fileName);
  }
  const notice = await readFile(join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const fileName of EXPECTED_FILES.filter((name) => name.startsWith('third_party/'))) {
    assert.ok(notice.includes(fileName), `声明继续指向可访问的产物路径：${fileName}`);
  }
});

for (const fileName of EXPECTED_FILES) {
  test(`缺少 ${fileName} 时真实 Vite 构建失败并定位文件`, async (t) => {
    const root = await fixture(t, { missing: fileName });
    await assert.rejects(buildFixture(root), (error) => {
      assert.ok(error.message.includes(`发布许可读取失败：${fileName}`));
      assert.equal(error.cause?.code, 'ENOENT');
      return true;
    });
  });
}

test('空许可文件不能生成看似完整的发布包', async (t) => {
  const root = await fixture(t, { empty: 'THIRD_PARTY_NOTICES.txt' });
  await assert.rejects(buildFixture(root), (error) => {
    assert.match(error.message, /发布许可读取失败：THIRD_PARTY_NOTICES\.txt/);
    assert.equal(error.cause?.message, 'LICENSE_FILE_EMPTY');
    return true;
  });
});
