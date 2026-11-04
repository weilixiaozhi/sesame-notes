import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(new URL('../clean-deployment-temp.py', import.meta.url));
const completedName = `release-api-${'a'.repeat(24)}`;
const incompleteName = `frontend-build-${'b'.repeat(24)}`;
const corruptName = `frontend-switch-${'c'.repeat(24)}`;
const python = String.raw`
import importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
try:
    spec=importlib.util.spec_from_file_location('deployment_cleanup_under_test',sys.argv[1])
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    repo=pathlib.Path(sys.argv[2])
    mounts={repo/'Temp'/sys.argv[3]} if len(sys.argv)>3 else set()
    operation=module.Cleanup(repo,detector=lambda _temp:[],mount_reader=lambda:mounts)
    print(json.dumps(operation.plan()[0],ensure_ascii=True))
except Exception as error:
    print(type(error).__name__+': '+str(error),file=sys.stderr)
    sys.exit(1)
`;

/** 只释放本次在仓库Temp内创建且身份未变化的普通夹具目录。 */
function removeFixture(fixture) {
  try {
    const temporary = realpathSync(join(root, 'Temp'));
    if (
      dirname(fixture) !== temporary ||
      !basename(fixture).startsWith('deployment-cleanup-test-') ||
      lstatSync(fixture).isSymbolicLink() ||
      realpathSync(fixture) !== fixture
    )
      throw new Error('清理验收夹具身份发生变化，停止释放');
    rmSync(fixture, { recursive: true, force: false });
  } catch (cause) {
    throw new Error('部署清理验收夹具释放失败', { cause });
  }
}

/** 在仓库 Temp 内创建独立目录，只运行只读计划并在结束时清理本次拥有的夹具。 */
function withPlan(files, verify, mountCandidate) {
  let fixture;
  let failure;
  try {
    mkdirSync(join(root, 'Temp'), { recursive: true });
    const temporary = realpathSync(join(root, 'Temp'));
    fixture = mkdtempSync(join(temporary, 'deployment-cleanup-test-'));
    mkdirSync(join(fixture, 'Temp'));
    for (const [name, content] of Object.entries(files)) {
      const target = resolve(fixture, name);
      if (!target.startsWith(fixture + sep)) throw new Error('清理验收夹具路径越界');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const args = ['-c', python, script, fixture, ...(mountCandidate ? [mountCandidate] : [])];
    const result = JSON.parse(
      execFileSync(process.platform === 'win32' ? 'python' : 'python3', args, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      }),
    );
    verify(result);
    // 只读计划不能删除候选、日志或未知条目，逐一确认内容原样保留。
    for (const [name, content] of Object.entries(files))
      assert.equal(readFileSync(join(fixture, name), 'utf8'), content);
  } catch (cause) {
    failure = new Error('部署临时文件只读计划验收失败', { cause });
  } finally {
    if (fixture) {
      try {
        removeFixture(fixture);
      } catch (cause) {
        // 资源释放失败与原验收失败一起保留，不能用finally异常覆盖最初的根因。
        failure = new AggregateError(failure ? [failure, cause] : [cause], '部署清理验收夹具释放失败');
      }
    }
  }
  if (failure) throw failure;
}

test('当前 JSONL 完成任务和关联锁进入候选，预览保持所有文件原样', () => {
  withPlan(
    {
      [`Temp/${completedName}/release.jsonl`]: '{"event":"release_started"}\n{"event":"release_completed"}\n',
      'Temp/release-api.lock': `${'a'.repeat(24)}\n`,
    },
    (result) => {
      assert.deepEqual(result.candidates, [completedName]);
      assert.deepEqual(result.removable_locks, ['release-api.lock']);
      assert.equal(result.applied, false);
    },
  );
});

test('当前未完成任务及损坏 JSONL 均保留', () => {
  withPlan(
    {
      [`Temp/${incompleteName}/build.jsonl`]: '{"event":"build_started"}\n',
      [`Temp/${corruptName}/release.jsonl`]: 'invalid JSON\n',
    },
    (result) => {
      assert.deepEqual(result.candidates, []);
      assert.equal(Object.hasOwn(result.retained, incompleteName), true);
      assert.equal(Object.hasOwn(result.retained, corruptName), true);
    },
  );
});

test('未登记的文本日志、目录和未知 JSONL 均按未知条目保留', () => {
  withPlan(
    {
      'Temp/prod-update.Ab12c3.log': 'release completed\n',
      'Temp/prod-build.Ab12c3/build.log': 'build completed\n',
      'Temp/unrelated.jsonl': '{"event":"release_completed"}\n',
    },
    (result) => {
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(Object.keys(result.retained).sort(), [
        'prod-build.Ab12c3',
        'prod-update.Ab12c3.log',
        'unrelated.jsonl',
      ]);
    },
  );
});

test('识别未占用的独立运维日志，保留同名目录、未知目录和相似名称', () => {
  withPlan(
    {
      'Temp/prod-pull.PKHuTI.log': 'fatal: 无法快进\n',
      'Temp/prod-check.7dtOeO.log': '健康检查通过\n',
      'Temp/node-upgrade.QnXFln.log': '软件版本检查失败\n',
      'Temp/update-source.WTTQ0v.log': '代码已更新\n',
      'Temp/prod-check.Ab12c3.log/backup.conf': '恢复所需配置\n',
      'Temp/prod-pull.PKHuTI.log.bak': '额外副本\n',
      'Temp/nginx-upgrade.riiimf/nginx.conf': '代理配置备份\n',
      'Temp/finish-api-web-admin-i39t7n5w/release.jsonl': '{"event":"release_started"}\n',
    },
    (result) => {
      assert.deepEqual(result.candidates, ['prod-check.7dtOeO.log', 'prod-pull.PKHuTI.log']);
      assert.deepEqual(Object.keys(result.retained).sort(), [
        'finish-api-web-admin-i39t7n5w',
        'nginx-upgrade.riiimf',
        'node-upgrade.QnXFln.log',
        'prod-check.Ab12c3.log',
        'prod-pull.PKHuTI.log.bak',
        'update-source.WTTQ0v.log',
      ]);
    },
  );
});

test('独立日志位于挂载点时保留', () => {
  withPlan(
    { 'Temp/prod-check.7dtOeO.log': '健康检查通过\n' },
    (result) => {
      assert.deepEqual(result.candidates, []);
      assert.equal(Object.hasOwn(result.retained, 'prod-check.7dtOeO.log'), true);
    },
    'prod-check.7dtOeO.log',
  );
});

test('候选仅限 Temp 直接子项，不认领嵌套目录或 Temp 外同名完成任务', () => {
  withPlan(
    {
      [`Temp/nested/${completedName}/release.jsonl`]: '{"event":"release_completed"}\n',
      [`${completedName}/release.jsonl`]: '{"event":"release_completed"}\n',
    },
    (result) => {
      assert.deepEqual(result.candidates, []);
      assert.deepEqual(Object.keys(result.retained), ['nested']);
    },
  );
});

test('当前任务路径类型不符时保留文件', () => {
  withPlan({ [`Temp/${completedName}`]: '{"event":"release_completed"}\n' }, (result) => {
    assert.deepEqual(result.candidates, []);
    assert.equal(Object.hasOwn(result.retained, completedName), true);
  });
});

test('完成任务位于挂载边界时不进入候选', () => {
  withPlan(
    { [`Temp/${completedName}/release.jsonl`]: '{"event":"release_completed"}\n' },
    (result) => {
      assert.deepEqual(result.candidates, []);
      assert.equal(Object.hasOwn(result.retained, completedName), true);
    },
    completedName,
  );
});
