/** 校验当前契约、生成结果与固定契约快照的一致性。 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findContractBreakingChanges } from '../lib/contract-compatibility.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const MANIFEST = 'packages/api-contract/compatibility-baseline.json';

/** 只读取仓库内的普通文件，拒绝目录链接，确保快照随源码完整携带。 */
function readRepositoryFile(root, relativePath) {
  try {
    let target = resolve(root);
    const segments = relativePath.split('/');
    for (const [index, segment] of segments.entries()) {
      target = join(target, segment);
      const entry = lstatSync(target);
      if (entry.isSymbolicLink()) throw new Error('契约文件及其仓库内父目录不能是符号链接');
      if (index === segments.length - 1 ? !entry.isFile() : !entry.isDirectory()) {
        throw new Error('契约路径必须指向普通目录中的文件');
      }
    }
    return readFileSync(target, 'utf8');
  } catch (cause) {
    throw new Error(`无法读取随源码分发的契约文件：${relativePath}`, { cause });
  }
}

/** 校验非空支持清单、独立快照路径与审阅信息，防止将当前生成物误作基准。 */
function validateManifest(manifest) {
  try {
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.snapshots) || !manifest.snapshots.length) {
      throw new Error('支持快照清单必须为非空的 schemaVersion 2');
    }
    const ids = new Set();
    const paths = new Set();
    for (const entry of manifest.snapshots) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('快照条目必须是对象');
      if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9.-]+$/.test(entry.id) || ids.has(entry.id))
        throw new Error('快照身份无效或重复');
      if (!/^\d+\.\d+\.\d+$/.test(entry.version ?? '')) {
        throw new Error(`快照 ${entry.id} 必须声明契约版本`);
      }
      if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error(`快照 ${entry.id} 的 SHA-256 摘要无效`);
      if (
        !/^packages\/api-contract\/(?:compatibility-baseline|releases\/[a-z0-9][a-z0-9.-]*)\.openapi\.json$/.test(
          entry.path ?? '',
        ) ||
        paths.has(entry.path)
      ) {
        throw new Error('本地快照路径无效或被多个条目复用');
      }
      if (
        !['supported', 'released'].includes(entry.status) ||
        typeof entry.review !== 'string' ||
        !entry.review.trim()
      ) {
        throw new Error('必须明确快照支持状态与审阅说明；不能将支持快照冒称已发布');
      }
      ids.add(entry.id);
      paths.add(entry.path);
    }
    return manifest.snapshots;
  } catch (cause) {
    throw new Error('契约支持快照清单无效', { cause });
  }
}

/** 读取全部独立支持快照，校验实际文件摘要和契约结构；不依赖 Git 或网络。 */
export function readContractBaselines(root) {
  try {
    const manifest = JSON.parse(readRepositoryFile(root, MANIFEST));
    const current = validateManifest(manifest);
    return current.map((entry) => {
      try {
        // 摘要取自随仓库分发的快照，只规范 CRLF/LF，其他文件字节都参与校验。
        const content = readRepositoryFile(root, entry.path).replaceAll('\r\n', '\n');
        if (createHash('sha256').update(content).digest('hex') !== entry.sha256) {
          throw new Error('快照摘要与清单不一致，请核对受审文件；检查器不会自动重设基线');
        }
        const document = JSON.parse(content);
        if (
          !/^3\.\d+\.\d+$/.test(document?.openapi ?? '') ||
          !document.paths ||
          typeof document.paths !== 'object' ||
          Array.isArray(document.paths) ||
          !Object.keys(document.paths).length
        ) {
          throw new Error('快照必须是包含接口路径的 OpenAPI 3.x 文档');
        }
        if (document.info?.version !== entry.version) throw new Error('快照的契约版本与清单不一致');
        return { entry, document };
      } catch (cause) {
        throw new Error(`支持快照 ${entry.id} 校验失败：${entry.path}`, { cause });
      }
    });
  } catch (cause) {
    throw new Error('无法验证支持快照；请检查随源码分发的清单、快照文件、版本与摘要', { cause });
  }
}

/** 包版本和生成一致性任一不满足都拒绝通过。 */
export function checkCurrentContract(artifact, generated, packageVersion) {
  try {
    if (!packageVersion || JSON.parse(generated).info?.version !== packageVersion) {
      throw new Error('契约与包版本不一致');
    }
    if (artifact !== generated) throw new Error('OpenAPI 与当前生成结果不一致，请重新生成并提交');
  } catch (cause) {
    throw new Error(`当前接口契约校验失败：${cause.message}`, { cause });
  }
}

/** 每一份清单中的支持快照都必须兼容，追加新快照不能免除旧约定。 */
export function checkContractCompatibility(baseline, candidate) {
  try {
    const changes = findContractBreakingChanges(baseline, candidate);
    if (changes.length) throw new Error(`固定基线之外存在破坏性契约变更:\n${changes.join('\n')}`);
  } catch (cause) {
    throw new Error(`接口兼容性校验失败：${cause.message}`, { cause });
  }
}

/** 直接运行已安装的 TS 入口并读取 stdout，避免包管理器进度污染 JSON 或覆盖工作树。 */
export function runOpenApiGenerator(root = ROOT) {
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'apps/api/node_modules/tsx/dist/cli.mjs'),
        join(root, 'apps/api/scripts/generate-openapi.ts'),
        '--stdout',
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`OpenAPI 生成失败：${String(result.status)}\n${result.stderr}`);
    return result.stdout;
  } catch (cause) {
    throw new Error('无法生成接口契约，请查看生成日志', { cause });
  }
}

/** 校验流程只读取仓库与生成器 stdout，失败时保留全部原始产物。 */
export function checkRepositoryContract(root = ROOT, generate = runOpenApiGenerator) {
  try {
    const artifact = readFileSync(join(root, 'packages/api-contract/openapi.json'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(root, 'packages/api-contract/package.json'), 'utf8'));
    const baselines = readContractBaselines(root);
    checkCurrentContract(artifact, generate(root), pkg.version);
    for (const { entry, document } of baselines) {
      try {
        checkContractCompatibility(document, JSON.parse(artifact));
      } catch (cause) {
        throw new Error(`受支持快照 ${entry.id} 兼容性检查失败`, { cause });
      }
    }
    return baselines.map(({ entry }) => entry.id);
  } catch (cause) {
    throw new Error('契约检查失败；工作树中的契约与生成物未被检查器改写', { cause });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const snapshots = checkRepositoryContract();
    console.log('OpenAPI 版本及生成一致性检查通过。');
    console.log(`固定支持快照兼容性检查通过：${snapshots.join(', ')}。`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
