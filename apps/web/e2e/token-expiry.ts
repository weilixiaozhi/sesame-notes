import { expect, type Page, type TestInfo } from '@playwright/test';

/** 只读取真实响应令牌的到期时间用于等待，不生成或改写 JWT，也不记录令牌。 */
export function jwtExpiryMs(token: unknown): number {
  if (typeof token !== 'string' || token.split('.').length !== 3) throw new Error('签发令牌缺少 JWT 到期信息。');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new Error('签发令牌缺少有效 JWT 到期信息。');
  }
  const expiry = payload && typeof payload === 'object' && 'exp' in payload ? payload.exp : undefined;
  if (
    typeof expiry !== 'number' ||
    !Number.isSafeInteger(expiry) ||
    expiry <= 0 ||
    !Number.isSafeInteger(expiry * 1_000)
  )
    throw new Error('签发令牌缺少有效 JWT 到期时间。');
  return expiry * 1_000;
}

/** 观察登录/恢复/刷新产生的最新真实令牌；页面本身的认证与服务器 TTL 保持原样。 */
export function observeBrowserAccessToken(page: Page) {
  let expiresAt: number | null = null;
  let sequence = 0;
  let observed = 0;
  let failed = false;
  page.on('response', (response) => {
    if (
      response.request().method() !== 'POST' ||
      !response.ok() ||
      !/^\/api\/v1\/auth\/browser\/(?:login|register|refresh)$/.test(new URL(response.url()).pathname)
    )
      return;
    const current = ++sequence;
    void response
      .json()
      .then((body: unknown) => {
        const token = body && typeof body === 'object' && 'access_token' in body ? body.access_token : undefined;
        const expiry = jwtExpiryMs(token);
        if (current > observed) {
          observed = current;
          expiresAt = expiry;
        }
      })
      .catch(() => {
        failed = true;
      });
  });
  return {
    /** 短间隔检查真实墙上时钟，按实际剩余 TTL 扩展用例预算；不冻结或快进浏览器时钟。 */
    async waitUntilExpired(testInfo: TestInfo) {
      await expect.poll(() => observed === sequence && observed > 0).toBe(true);
      for (let round = 0; round < 3; round++) {
        if (failed || expiresAt === null) throw new Error('无法观察真实浏览器令牌的到期时间。');
        const target = expiresAt + 1_000;
        const remaining = Math.max(0, target - Date.now());
        testInfo.setTimeout(testInfo.timeout + remaining + 10_000);
        testInfo.annotations.push({ type: 'real-token-expiry', description: new Date(expiresAt).toISOString() });
        process.stdout.write(`等待服务器真实 Access Token 过期，剩余约 ${Math.ceil(remaining / 1_000)} 秒。\n`);
        await expect
          .poll(() => Date.now(), { timeout: remaining + 5_000, intervals: [250, 500, 1_000] })
          .toBeGreaterThan(target);
        if (!failed && observed === sequence && expiresAt + 1_000 <= Date.now()) return;
      }
      throw new Error('等待期间令牌持续刷新；本轮没有证明过期请求，不能视为通过。');
    },
  };
}
