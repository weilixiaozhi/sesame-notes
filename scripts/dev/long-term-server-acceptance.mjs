/**
 * 在仓库根目录运行 node scripts/dev/long-term-server-acceptance.mjs。
 * 前提：已有 Node.js、项目依赖、可用 Docker 和本机 postgres:17-alpine 镜像；本脚本不安装或拉取任何工具。
 * 每次只使用新建的回环端口容器、合成账号及数据库，结束后关闭本任务容器，证据保留在根目录 Temp。
 * --probe-only 仅跳过现有契约测试，仍完整运行规模测量、数据库备份还原及恢复重连核对。
 * --image-only 仅执行单张有效 PNG 的真实同步、数据库备份还原和解码补验。
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const runId = randomUUID().replaceAll('-', '');
const output = path.join(root, 'Temp', `long-term-server-${runId}`);
const results = [];
const imageOnly = process.argv.includes('--image-only');
let container;
let containerRemoved = false;

/** 运行已有工具，完整日志仅落本仓 Temp；失败时保留阶段及退出状态。 */
function run(label, command, args, options = {}) {
  const file = path.join(output, `${label}.log`);
  const fd = openSync(file, 'w');
  const started = performance.now();
  try {
    const result = spawnSync(command, args, {
      windowsHide: true,
      cwd: root,
      stdio: ['ignore', fd, fd],
      timeout: 1_800_000,
      ...options,
    });
    const state = {
      label,
      code: result.status,
      error: result.error?.message,
      elapsed_ms: Math.round(performance.now() - started),
      file,
    };
    results.push(state);
    writeFileSync(path.join(output, 'stages.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(state));
    if (result.status !== 0) throw new Error(`验收阶段失败：${label}，请查看 ${file}`);
  } catch (cause) {
    throw new Error(`无法完成 ${label}`, { cause });
  } finally {
    closeSync(fd);
  }
}

/** 读取短小的工具响应，不启动 shell，不继承任何已有数据库连接。 */
function command(args) {
  try {
    const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (result.status !== 0) throw new Error(result.stderr || `Docker 退出 ${result.status}`);
    return result.stdout.trim();
  } catch (cause) {
    throw new Error('隔离容器操作失败', { cause });
  }
}

try {
  mkdirSync(output, { recursive: true });
  console.log(`OUTPUT=${output}`);
  // 禁止拉取或安装镜像，数据库只驻留本次创建的容器内存卷。
  container = command([
    'run',
    '--pull=never',
    '--detach',
    '--rm',
    '--name',
    `sesame-long-term-${runId}`,
    '--publish',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql/data',
    '--env',
    'POSTGRES_USER=sesame',
    '--env',
    'POSTGRES_PASSWORD=synthetic-only',
    '--env',
    'POSTGRES_DB=sesame_test_long_term',
    'postgres:17-alpine',
  ]);
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('容器身份无效');
  const binding = command(['port', container, '5432/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('隔离端口必须只绑定回环地址');
  const port = binding.split(':')[1];
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      command(['exec', container, 'pg_isready', '-U', 'sesame']);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!ready) throw new Error('隔离数据库未就绪');
  const url = `postgresql://sesame:synthetic-only@127.0.0.1:${port}/sesame_test_long_term`;
  const env = {
    ...process.env,
    DATABASE_URL: url,
    E2E_DATABASE_URL: url,
    SESAME_ENV: 'test',
    NODE_ENV: 'test',
    STORAGE_PATH: path.join(output, 'storage'),
    LONG_TERM_OUTPUT: output,
  };
  for (const key of Object.keys(env)) if (key.startsWith('E2E_') && key !== 'E2E_DATABASE_URL') delete env[key];
  writeFileSync(
    path.join(output, 'environment.json'),
    JSON.stringify(
      {
        runId,
        container,
        port,
        node: process.version,
        platform: process.platform,
        image: 'postgres:17-alpine',
        mode: 'Fastify inject + PostgreSQL; no phone/UI/network timing',
      },
      null,
      2,
    ),
  );
  run('setup', process.execPath, ['apps/api/prisma/setup.mjs'], { env });
  const cwd = path.join(root, 'apps/api');
  const tsx = path.join(cwd, 'node_modules/tsx/dist/cli.mjs');
  if (!process.argv.includes('--probe-only') && !imageOnly)
    run(
      'contracts',
      process.execPath,
      [
        path.join(cwd, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        'vitest.config.ts',
        'test/sync-id.e2e.test.ts',
        'test/sync-cursor.e2e.test.ts',
        'test/memos-sync.e2e.test.ts',
        'test/fitness-sync.e2e.test.ts',
        'src/server-recover.test.ts',
      ],
      { cwd, env },
    );
  const probe = path.join(cwd, 'scripts/long-term-server-probe.ts');
  run(imageOnly ? 'attachment' : 'scale', process.execPath, [tsx, probe, imageOnly ? 'attachment-seed' : 'seed'], {
    env,
  });
  // pg_dump/pg_restore 使用镜像自带工具；只导出本次创建的合成数据库。
  run('dump', 'docker', [
    'exec',
    container,
    'pg_dump',
    '-U',
    'sesame',
    '-Fc',
    '-f',
    '/tmp/acceptance.dump',
    'sesame_test_long_term',
  ]);
  run('save-dump', 'docker', ['cp', `${container}:/tmp/acceptance.dump`, path.join(output, 'acceptance.dump')]);
  command(['exec', container, 'createdb', '-U', 'sesame', 'sesame_test_long_term_restored']);
  run('restore', 'docker', [
    'exec',
    container,
    'pg_restore',
    '-U',
    'sesame',
    '-d',
    'sesame_test_long_term_restored',
    '--exit-on-error',
    '/tmp/acceptance.dump',
  ]);
  const restored = url.replace('/sesame_test_long_term', '/sesame_test_long_term_restored');
  const recoveredEnv = {
    ...env,
    DATABASE_URL: restored,
    E2E_DATABASE_URL: restored,
    SERVER_RECOVERY_CONFIRM: `127.0.0.1:${port}/sesame_test_long_term_restored`,
    SERVER_RECOVERY_MAINTENANCE: 'API_STOPPED',
    SERVER_RECOVERY_OPERATOR: '隔离验收',
    SERVER_RECOVERY_REASON: '合成数据备份还原',
    SERVER_RECOVERY_BACKUP_REFERENCE: runId,
  };
  run('prepare-recovered-server', process.execPath, [tsx, path.join(cwd, 'src/server-recover.ts'), '--apply'], {
    env: recoveredEnv,
  });
  run('verify-recovery', process.execPath, [tsx, probe, imageOnly ? 'attachment-verify' : 'verify'], {
    env: recoveredEnv,
  });
} catch (error) {
  console.error('长期验收未完成，请按阶段日志诊断。', error);
  process.exitCode = 1;
} finally {
  if (container && /^[a-f0-9]{64}$/.test(container)) {
    try {
      command(['stop', '--time', '5', container]);
      containerRemoved = true;
      console.log('OWNED_CONTAINER_REMOVED=true');
    } catch (error) {
      console.error('本任务容器清理失败', error);
      process.exitCode = 1;
    }
  }
  try {
    writeFileSync(
      path.join(output, 'summary.json'),
      JSON.stringify(
        {
          passed: !process.exitCode,
          containerRemoved,
          contractsSkipped: process.argv.includes('--probe-only') || imageOnly,
          imageOnly,
          stages: results,
          scaleReport: imageOnly ? 'attachment-results.json' : 'scale-results.json',
          recoveryReport: imageOnly ? 'attachment-recovery-results.json' : 'recovery-results.json',
          sampling: imageOnly
            ? { attachmentBeforeRestore: 1, attachmentAfterRestore: 1 }
            : { initialUpload: 1, singleIncrementalWrite: 1, eachRead: 3 },
          boundary: '本机 Fastify inject 与独立 PostgreSQL；不等同手机/UI/公网体验；重放模拟提交后回执丢失。',
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error('验收汇总写入失败', error);
    process.exitCode = 1;
  }
}
