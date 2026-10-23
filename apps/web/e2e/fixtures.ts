import { randomInt, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';
import { ApiClient, unwrap, type paths } from '@sesame-notes/api-client';
import { testEnvironment } from './environment';
import { auditBrowserMutation } from './identity-audit';

export { expect } from '@playwright/test';
export type Account = { phone: string; password: string };
type ApiSession = paths['/api/v1/auth/login']['post']['responses'][200]['content']['application/json'];
type BrowserSession = paths['/api/v1/auth/browser/login']['post']['responses'][200]['content']['application/json'];
export type Mutation =
  paths['/api/v1/sync/push']['post']['requestBody']['content']['application/json']['changes'][number];
const environment = testEnvironment();
let nextRequestAt = 0;
let nextAuthAt = 0;
let authQueue = Promise.resolve();
let requestQueue = Promise.resolve();

/** 共享测试服务沿用实际限流；测试侧按请求发起节奏排队，不拦截或替换业务响应。 */
async function paceRequest(url: string) {
  if (environment.mode !== 'existing-backend') return;
  const delay = async (until: number) => {
    const remaining = until - Date.now();
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  };
  const requestSlot = async () => {
    const slot = requestQueue.then(async () => {
      await delay(nextRequestAt);
      nextRequestAt = Date.now() + 220;
    });
    requestQueue = slot;
    await slot;
  };
  if (new URL(url).pathname.startsWith('/api/v1/auth/')) {
    const slot = authQueue.then(async () => {
      await delay(nextAuthAt);
      await requestSlot();
      nextAuthAt = Date.now() + 6_500;
    });
    authQueue = slot;
    await slot;
  } else await requestSlot();
}

const ownedAccounts = new WeakMap<Account, { registered: boolean }>();

/** 只记录本轮创建账号及请求涉及的 UUID；不保存密码、Token 或业务文本，不自动清理共享库。 */
function recordTestIdentities(source: string, method: string, path: string, value: unknown) {
  const identities = new Map<string, { field: string; id: string }>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const [field, child] of Object.entries(item)) {
      if (
        (field === 'id' || field.endsWith('_id')) &&
        typeof child === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(child)
      )
        identities.set(`${field}:${child}`, { field, id: child });
      else if (typeof child === 'object') visit(child);
    }
  };
  visit(value);
  appendFileSync(
    join(environment.artifactDirectory, 'test-data-identities.jsonl'),
    `${JSON.stringify({
      run_id: environment.runId,
      test: base.info().titlePath,
      source,
      method,
      path,
      recorded_at: new Date().toISOString(),
      identities: [...identities.values()],
    })}\n`,
    'utf8',
  );
}

/** 禁止把固定或已有账号交给辅助客户端/浏览器登录；只能使用本轮生成并成功注册的身份。 */
function assertOwnedAccount(account: Account, register: boolean) {
  const owned = ownedAccounts.get(account);
  if (!owned || owned.registered === register)
    throw new Error('E2E 仅允许本轮新建身份：注册不能复用已有账号，登录必须已有本轮成功注册记录。');
}

/** 为每个用例生成独立的测试身份，不读取现有账号或固定密码配置。 */
export function newAccount(): Account {
  const account = {
    phone: `139${randomInt(100_000_000).toString().padStart(8, '0')}`,
    password: `Web-e2e-${randomUUID()}`,
  };
  ownedAccounts.set(account, { registered: false });
  return account;
}

/** 使用生成客户端建立第二设备会话，验证真实跨设备 API 与 Web 的一致性。 */
export async function peerClient(account: Account, register = false) {
  assertOwnedAccount(account, register);
  const publicClient = new ApiClient({ baseUrl: environment.apiOrigin, getAccessToken: async () => null }).client;
  publicClient.use({
    async onRequest({ request }) {
      await paceRequest(request.url);
    },
  });
  const body: paths['/api/v1/auth/login']['post']['requestBody']['content']['application/json'] = {
    country_code: '+86',
    ...account,
    device: { installation_id: randomUUID(), name: 'Web E2E peer', platform: 'test' },
  };
  let session: ApiSession = register
    ? unwrap(await publicClient.POST('/api/v1/auth/register', { body }))
    : unwrap(await publicClient.POST('/api/v1/auth/login', { body }));
  if (register) ownedAccounts.set(account, { registered: true });
  recordTestIdentities(
    register ? 'peer-registration' : 'peer-session',
    'POST',
    `/api/v1/auth/${register ? 'register' : 'login'}`,
    session,
  );
  const client = new ApiClient({
    baseUrl: environment.apiOrigin,
    getAccessToken: async () => session.access_token,
    refreshAccessToken: async () => {
      session = unwrap(
        await publicClient.POST('/api/v1/auth/refresh', { body: { refresh_token: session.refresh_token } }),
      );
      return session.access_token;
    },
  }).client;
  client.use({
    async onRequest({ request }) {
      await paceRequest(request.url);
    },
    /** 成功操作只追加非敏感身份信息，保留准确范围供后续人工核查。 */
    async onResponse({ request, response }) {
      if (
        response.ok &&
        response.status !== 204 &&
        response.status !== 205 &&
        request.method !== 'GET' &&
        response.headers.get('content-type')?.includes('json')
      )
        recordTestIdentities('peer', request.method, new URL(request.url).pathname, await response.clone().json());
    },
  });
  return {
    client,
    /** 同步写入默认必须得到 accepted 或 ignored；冲突用例显式声明并核对 conflict，HTTP 200 不等于业务成功。 */
    async push(change: Mutation, expectedStatus?: 'conflict') {
      const result = unwrap(
        await client.POST('/api/v1/sync/push', { body: { device_id: session.device_id, changes: [change] } }),
      );
      const outcome = result.outcomes.find((item) => item.mutation_id === change.mutation_id);
      if (expectedStatus) expect(outcome?.status, outcome?.message).toBe(expectedStatus);
      else expect(outcome?.status, outcome?.message).toMatch(/^(accepted|ignored)$/);
      recordTestIdentities('peer-sync', 'POST', '/api/v1/sync/push', { change, outcome });
      return outcome!;
    },
  };
}

/** 通过可见表单登录，返回的类型来自 OpenAPI；测试不注入浏览器存储或绕过登录。 */
export async function login(page: Page, account: Account, register = false): Promise<BrowserSession> {
  assertOwnedAccount(account, register);
  await page.goto('/login');
  if (register) await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByLabel('手机号', { exact: true }).fill(account.phone);
  await page.getByLabel(/^密码/).fill(account.password);
  if (register) await page.getByLabel('确认密码', { exact: true }).fill(account.password);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(register ? '/api/v1/auth/browser/register' : '/api/v1/auth/browser/login'),
  );
  await page.getByRole('button', { name: register ? '创建账号' : '登录', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(register ? 201 : 200);
  const session: BrowserSession = await response.json();
  expect(Object.hasOwn(session, 'refresh_token'), '浏览器认证响应不能把刷新凭据暴露给 JavaScript').toBe(false);
  if (register) ownedAccounts.set(account, { registered: true });
  recordTestIdentities(
    register ? 'browser-registration' : 'browser-session',
    'POST',
    `/api/v1/auth/browser/${register ? 'register' : 'login'}`,
    session,
  );
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
  return session;
}

type BrowserDiagnostics = {
  offlineExpected: boolean;
  connectionFailureExpected: boolean;
  conflictExpected: boolean;
  expectedConsoleErrors: Array<{ message: string; context: Record<string, string | number> }>;
};
export const test = base.extend<{ account: Account; diagnostics: BrowserDiagnostics }>({
  account: async ({ baseURL }, use) => {
    expect(baseURL).toBe(environment.webOrigin);
    const account = newAccount();
    await peerClient(account, true);
    await use(account);
  },
  diagnostics: [
    async ({ page, context }, use, testInfo) => {
      if (environment.mode === 'existing-backend')
        await context.route('**/api/v1/**', async (route) => {
          await paceRequest(route.request().url());
          await route.continue();
        });
      const diagnostics: BrowserDiagnostics = {
        offlineExpected: false,
        connectionFailureExpected: false,
        conflictExpected: false,
        expectedConsoleErrors: [],
      };
      const errors: string[] = [];
      const auditTasks = new Set<Promise<void>>();
      /** 为主页面和新标签页收集运行时错误。 */
      function watch(page: Page) {
        page.on('response', (response) => {
          const task = auditBrowserMutation(response, (method, path, value) =>
            recordTestIdentities('browser', method, path, value),
          ).catch((error: unknown) => {
            errors.push(error instanceof Error ? error.message : '测试数据身份记录失败，原因未知。');
          });
          auditTasks.add(task);
          void task.finally(() => auditTasks.delete(task));
        });
        page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          const text = message.text();
          // 首次会话恢复及短期 Token 过期可合法产生 401；断网场景的连接错误单独声明。
          if (/Failed to load resource: the server responded with a status of 401/.test(text)) return;
          if (diagnostics.offlineExpected && /net::ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(text)) return;
          if (diagnostics.connectionFailureExpected && /net::ERR_CONNECTION_REFUSED/.test(text)) return;
          if (
            diagnostics.conflictExpected &&
            /Failed to load resource: the server responded with a status of 409/.test(text) &&
            /\/(?:memo-books\/[^/]+\/entries(?:\/[^/?]+)?|ledgers\/[^/]+\/(?:clear|categories\/remove)|api\/v1\/category-conflicts\/[0-9a-f-]{36}\/resolve)(?:\?|$)/.test(
              message.location().url,
            )
          )
            return;
          const expectedIndex = diagnostics.expectedConsoleErrors.findIndex((entry) =>
            text.startsWith(`${entry.message} `),
          );
          if (expectedIndex >= 0) {
            // 每次声明只消费一条日志，并核对具体记录身份；其他同名错误仍视为验收失败。
            const expected = diagnostics.expectedConsoleErrors.splice(expectedIndex, 1)[0]!;
            const task = Promise.all(message.args().map((argument) => argument.jsonValue()))
              .then(([action, details]) => {
                if (
                  action !== expected.message ||
                  !details ||
                  typeof details !== 'object' ||
                  !Object.entries(expected.context).every(([key, value]) => details[key] === value)
                )
                  errors.push(`console: ${text}`);
              })
              .catch((error: unknown) => {
                errors.push(error instanceof Error ? error.message : '无法核对预期的错误日志。');
              });
            auditTasks.add(task);
            void task.finally(() => auditTasks.delete(task));
            return;
          }
          errors.push(`console: ${text}`);
        });
      }
      watch(page);
      context.on('page', watch);
      await use(diagnostics);
      context.off('page', watch);
      await Promise.all(auditTasks);
      await testInfo.attach('browser-errors', {
        body: JSON.stringify(errors, null, 2),
        contentType: 'application/json',
      });
      expect(errors, '不允许未处理异常或非预期 console.error').toEqual([]);
      expect(diagnostics.expectedConsoleErrors, '声明的错误日志必须实际出现').toEqual([]);
    },
    { auto: true },
  ],
});
