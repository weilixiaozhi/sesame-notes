import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

type Environment = Record<string, string | undefined>;

type TestDatabase = {
  url: string;
  identity: string;
};

const testEnvFile = new URL('../../../.env.test', import.meta.url);
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const queryOptions = new Set(['schema', 'connection_limit', 'pool_timeout', 'application_name']);

/** 只返回配置错误原因，数据库凭据不得写入错误或 cause。 */
function reject(detail: string): never {
  throw new Error(`API test environment rejected: ${detail}`);
}

/** 只解析连接配置：允许本机主测试库与 CI 库，不发起数据库连接。 */
function database(value: string | undefined): TestDatabase {
  if (
    !value ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 32 || code === 127;
    }) ||
    value.includes('#')
  ) {
    reject('an explicit PostgreSQL test URL is required');
  }

  let url: URL;
  let name: string;
  let username: string;
  let password: string;
  try {
    url = new URL(value);
    name = decodeURIComponent(url.pathname.slice(1));
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    reject('the PostgreSQL test URL is invalid');
  }

  const host = url.hostname.toLowerCase();
  const port = url.port || '5432';
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !loopbackHosts.has(host) ||
    !username ||
    !((name === 'sesame_notes_test' && port === '55432') || (name === 'sesame_notes_test_ci' && port === '5432'))
  ) {
    reject('only the named local test or CI database endpoint is allowed');
  }

  const seen = new Set<string>();
  for (const [key, option] of url.searchParams) {
    if (seen.has(key) || !queryOptions.has(key)) reject('duplicate or unsupported connection options');
    seen.add(key);
    if (key === 'schema' && option !== 'public') reject('only the public test schema is allowed');
    if (
      (key === 'connection_limit' || key === 'pool_timeout') &&
      (!/^\d{1,5}$/.test(option) || Number(option) > 10_000 || (key === 'connection_limit' && Number(option) === 0))
    ) {
      reject('invalid connection pool options');
    }
    if (key === 'application_name' && !/^[\w.:-]{1,63}$/.test(option)) reject('invalid test application name');
  }

  return {
    url: url.toString(),
    identity: JSON.stringify([host, port, name, username, password, 'public']),
  };
}

/** 两个数据库变量必须指向同一测试身份，连接池参数可以不同。 */
function validate(environment: Environment) {
  if (environment.SESAME_ENV !== 'test') reject('SESAME_ENV must explicitly be test');
  if (environment.NODE_ENV !== undefined && !['development', 'test'].includes(environment.NODE_ENV)) {
    reject('NODE_ENV must be development or test');
  }
  const primary = database(environment.DATABASE_URL);
  const integration = environment.E2E_DATABASE_URL === undefined ? primary : database(environment.E2E_DATABASE_URL);
  if (primary.identity !== integration.identity) {
    reject('DATABASE_URL and E2E_DATABASE_URL must identify the same test target and credentials');
  }
  return {
    SESAME_ENV: 'test' as const,
    NODE_ENV: 'test' as const,
    DATABASE_URL: primary.url,
    E2E_DATABASE_URL: integration.url,
  };
}

/** 文件与进程变量分别校验，安全覆盖值不能掩盖文件中的错误目标。 */
export function resolveTestEnvironment(environment: Environment, fileEnvironment?: Environment) {
  if (fileEnvironment !== undefined) validate(fileEnvironment);
  const overrides = Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
  return validate({ ...fileEnvironment, ...overrides });
}

/** 只加载数据库与环境身份，保留测试专用 JWT 和存储目录。 */
export function initializeTestEnvironment(
  environment: Environment = process.env,
  read: (file: URL) => string = (file) => readFileSync(file, 'utf8'),
) {
  let fileEnvironment: Environment | undefined;
  try {
    fileEnvironment = parseEnv(read(testEnvFile));
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      reject('unable to read the explicit .env.test configuration');
    }
  }
  const resolved = resolveTestEnvironment(environment, fileEnvironment);
  Object.assign(environment, resolved);
  return resolved;
}

/** 每次读取连接都重新验证，阻止后续环境修改绕过目标限制。 */
export function testDatabaseUrl(environment: Environment = process.env): string {
  return resolveTestEnvironment(environment).E2E_DATABASE_URL;
}
