import { isAbsolute, resolve, relative } from 'node:path';
import { isIP } from 'node:net';

/** 两种模式均必须由正式入口显式提供目标；既有服务模式不读取数据库连接。 */
export function testEnvironment(env: NodeJS.ProcessEnv = process.env) {
  try {
    const mode = env.WEB_E2E_MODE ?? 'isolated';
    if (mode !== 'isolated' && mode !== 'existing-backend') throw new Error('未知 E2E 运行模式。');
    const runId = env.WEB_E2E_RUN_ID;
    if (!runId || !/^[a-f0-9]{32}$/.test(runId)) {
      throw new Error('请从仓库根运行 pnpm test:web:backend；禁止隐式连接默认服务执行 E2E。');
    }
    const web = localOrigin(
      env.WEB_E2E_BASE_URL,
      'WEB_E2E_BASE_URL',
      mode === 'existing-backend' ? ['127.0.0.1', 'localhost'] : ['127.0.0.1', '127.0.0.2'],
    );
    const api =
      mode === 'existing-backend'
        ? privateTestOrigin(env.WEB_API_TARGET)
        : localOrigin(env.WEB_API_TARGET, 'WEB_API_TARGET');
    if (mode === 'existing-backend') {
      if (
        env.WEB_E2E_EXISTING_BACKEND_CONFIRMED !== 'true' ||
        env.WEB_API_TARGET !== api.origin ||
        env.WEB_E2E_EXISTING_API_ORIGIN !== api.origin ||
        env.WEB_E2E_EXPECTED_API_ORIGIN !== api.origin
      )
        throw new Error('既有服务模式仅允许显式确认且与本地 TEST_API_ORIGIN 配置一致的测试 API。');
      if (
        env.WEB_E2E_EXPECTED_WEB_ORIGIN !== web.origin ||
        env.WEB_E2E_EXISTING_WEB_ORIGIN !== web.origin ||
        env.WEB_E2E_BASE_URL !== web.origin
      )
        throw new Error('既有服务模式必须显式提供一致的测试 Web Origin。');
    } else {
      const database = new URL(env.E2E_DATABASE_URL ?? '');
      if (
        database.protocol !== 'postgresql:' ||
        database.hostname !== '127.0.0.1' ||
        !database.port ||
        database.pathname !== `/web_e2e_${runId}` ||
        env.DATABASE_URL !== env.E2E_DATABASE_URL
      ) {
        throw new Error('隔离 E2E 仅允许本次随机端口、独立命名的 localhost PostgreSQL 数据库。');
      }
    }
    const artifactDirectory = env.WEB_E2E_ARTIFACTS ?? '';
    const repository = resolve(import.meta.dirname, '../../..');
    const allowed = resolve(repository, 'Temp', `web-e2e-${runId}`);
    const offset = relative(allowed, artifactDirectory);
    if (!isAbsolute(artifactDirectory) || offset !== '') throw new Error('E2E 产物目录必须是本次运行的 Temp 目录。');
    return { mode, runId, webOrigin: web.origin, apiOrigin: api.origin, artifactDirectory };
  } catch (cause) {
    throw new Error('真实浏览器验收被阻塞：显式测试目标未就绪。', { cause });
  }
}

/** 既有 API 只允许本地或 RFC1918 IPv4，避免测试参数误指公网生产服务。 */
function privateTestOrigin(value: string | undefined): URL {
  try {
    const url = new URL(value ?? '');
    const octets = url.hostname.split('.').map(Number);
    const privateIp =
      isIP(url.hostname) === 4 &&
      (octets[0] === 10 ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168));
    if (!privateIp && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('既有测试 API 必须使用回环或私有 IPv4 地址。');
    }
    return localOrigin(value, 'WEB_API_TARGET', [url.hostname]);
  } catch (cause) {
    throw new Error('既有测试 API 地址校验失败。', { cause });
  }
}

/** 仅接受回环或已确认测试主机的显式 HTTP Origin，不接受任意远端、用户信息或路径。 */
function localOrigin(value: string | undefined, label: string, allowedHosts: readonly string[] = ['127.0.0.1']): URL {
  try {
    const url = new URL(value ?? '');
    if (
      url.protocol !== 'http:' ||
      !allowedHosts.includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      value !== url.origin
    ) {
      throw new Error(`${label} 必须是允许测试主机上带端口的 HTTP Origin。`);
    }
    return url;
  } catch (cause) {
    throw new Error(`${label} 测试来源格式错误。`, { cause });
  }
}
