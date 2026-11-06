import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(new URL('../deploy/release-frontend.py', import.meta.url));
const python = String.raw`
import argparse,importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
try:
    spec=importlib.util.spec_from_file_location('current_frontend_release_under_test',sys.argv[1])
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    base=pathlib.Path(sys.argv[2])
    options=argparse.Namespace(component='web',repo=str(base/'repo'),releases_root=str(base/'releases'),
        release_dir=str(base/'releases'/'next'),site_link=str(base/'site'/'current'),health_url='http://127.0.0.1/version.json')
    operation=module.FrontendSwitch(options)
    # 用普通文件保存入口快照，聚焦版本预检并避免依赖系统创建符号链接的权限。
    def snapshot(path=None):
        try:
            pointer=pathlib.Path(options.site_link) if path is None else path
            return {'target':pointer.read_text(encoding='utf-8')}
        except OSError as error:
            raise RuntimeError('fixture pointer could not be read') from error
    operation.snapshot=snapshot
    try:
        result=operation.preflight_site()
        print(json.dumps({'accepted':True,'plan':result},ensure_ascii=True))
    except module.ReleaseError as error:
        print(json.dumps({'accepted':False,'error':str(error)},ensure_ascii=True))
except Exception as error:
    print(type(error).__name__+': '+str(error),file=sys.stderr)
    sys.exit(1)
`;

/** 只释放本次Temp内创建的普通夹具目录，拒绝链接或身份变化。 */
function removeFixture(fixture) {
  try {
    if (
      dirname(fixture) !== realpathSync(join(root, 'Temp')) ||
      !basename(fixture).startsWith('frontend-marker-test-') ||
      lstatSync(fixture).isSymbolicLink() ||
      realpathSync(fixture) !== fixture
    )
      throw new Error('前端预检夹具身份发生变化，停止释放');
    rmSync(fixture, { recursive: true, force: false });
  } catch (cause) {
    throw new Error('前端预检夹具释放失败', { cause });
  }
}

/** 读取真实发布模块的站点预检，逐一确认原入口、首页和版本文件均未被改写。 */
function inspectExistingSite(metadata, verify) {
  let fixture;
  let failure;
  try {
    mkdirSync(join(root, 'Temp'), { recursive: true });
    fixture = mkdtempSync(join(realpathSync(join(root, 'Temp')), 'frontend-marker-test-'));
    const repo = join(fixture, 'repo');
    const previous = join(fixture, 'releases', 'current', 'web');
    const site = join(fixture, 'site');
    mkdirSync(join(repo, 'Temp'), { recursive: true });
    mkdirSync(previous, { recursive: true });
    mkdirSync(site);
    const pointer = join(site, 'current');
    const pointerValue = previous;
    const page = '<html>current site</html>';
    writeFileSync(pointer, pointerValue);
    writeFileSync(join(previous, 'index.html'), page);
    if (metadata !== undefined) writeFileSync(join(previous, 'version.json'), metadata);
    const result = JSON.parse(
      execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', python, script, fixture], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      }),
    );
    verify(result);
    assert.equal(readFileSync(pointer, 'utf8'), pointerValue);
    assert.equal(readFileSync(join(previous, 'index.html'), 'utf8'), page);
    if (metadata !== undefined) assert.equal(readFileSync(join(previous, 'version.json'), 'utf8'), metadata);
    else assert.throws(() => lstatSync(join(previous, 'version.json')), { code: 'ENOENT' });
  } catch (cause) {
    failure = new Error('现有站点当前版本标记预检失败', { cause });
  } finally {
    if (fixture) {
      try {
        removeFixture(fixture);
      } catch (cause) {
        failure = new AggregateError(failure ? [failure, cause] : [cause], '前端预检资源释放失败');
      }
    }
  }
  if (failure) throw failure;
}

test('现有站点缺少版本标记时友好拒绝，保留入口和全部产物且不补写文件', () => {
  inspectExistingSite(undefined, (result) => {
    assert.equal(result.accepted, false);
    assert.match(result.error, /缺少 version\.json/);
  });
});

test('现有站点有合法当前组件版本标记时通过只读预检', () => {
  inspectExistingSite(JSON.stringify({ component: 'web', version: '0.1.9' }), (result) => {
    assert.equal(result.accepted, true);
    assert.equal(result.plan.component, 'web');
    assert.equal(result.plan.exclusive_site_changes_required, true);
  });
});

for (const metadata of [{ component: 'admin', version: '0.1.9' }]) {
  test(`现有站点版本标记不匹配时拒绝并保留现场：${metadata.component}/${metadata.version}`, () => {
    inspectExistingSite(JSON.stringify(metadata), (result) => {
      assert.equal(result.accepted, false);
      assert.match(result.error, /version\.json/);
    });
  });
}
