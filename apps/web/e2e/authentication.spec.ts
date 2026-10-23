import { observeBrowserAccessToken } from './token-expiry';
import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, newAccount, peerClient } from './fixtures';

test('注册、Cookie 恢复、真实过期刷新与跨标签页退出', async ({ page, context }, testInfo) => {
  const browserToken = observeBrowserAccessToken(page);
  const account = newAccount();
  // 短手机号与单字符密码沿用客户端规则，身份仍由本轮生成的同一个对象追踪。
  account.phone = account.phone.slice(-5);
  account.password = '1';
  const session = await login(page, account, true);
  const firstCookie = (await context.cookies()).find((cookie) => cookie.httpOnly);
  expect(firstCookie, '浏览器刷新凭据必须是 HttpOnly Cookie').toBeDefined();
  expect(firstCookie?.domain).toBe(new URL(page.url()).hostname);
  const otherCookieHost = new URL(page.url()).hostname === '127.0.0.1' ? '127.0.0.2' : '127.0.0.1';
  expect(
    (await context.cookies(`http://${otherCookieHost}:4173`)).some((cookie) => cookie.name === firstCookie?.name),
    '浏览器刷新 Cookie 不能被另一个主机读取',
  ).toBe(false);
  expect(['Lax', 'Strict']).toContain(firstCookie?.sameSite);
  const stored = await page.evaluate(() => ({ ...localStorage, ...sessionStorage }));
  expect(JSON.stringify(stored).includes(session.access_token), '浏览器持久化存储不能包含 Access Token').toBe(false);
  // 单字符密码按完整存储值核对，避免把安装 UUID 中偶然出现的数字误判为密码泄露。
  expect(Object.values(stored), '浏览器持久化存储不能保存账号密码').not.toContain(account.password);
  expect(JSON.stringify(stored), '浏览器持久化存储不能包含密码字段').not.toMatch(/password/i);

  const restored = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/auth/browser/refresh') && response.status() === 200,
  );
  await page.reload();
  await restored;
  await expect(page.getByRole('heading', { name: '我的生活' })).toBeVisible();
  const rotatedCookie = (await context.cookies()).find((cookie) => cookie.httpOnly);
  expect(
    Boolean(rotatedCookie && rotatedCookie.value !== firstCookie?.value),
    '恢复会话后必须轮换 HttpOnly 刷新凭据',
  ).toBe(true);

  // 等待服务器签发的短期 Token 真正过期，再触发受保护查询与刷新重试。
  await browserToken.waitUntilExpired(testInfo);
  const refreshed = page.waitForResponse(
    (response) => response.url().endsWith('/api/v1/auth/browser/refresh') && response.status() === 200,
  );
  await page.getByRole('link', { name: /^账号与设置，/ }).click();
  await refreshed;
  await expect(page.getByRole('heading', { name: '账号与设置' })).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto('/accounting');
  await expect(otherTab.getByRole('heading', { name: '记账', exact: true })).toBeVisible();

  await testInfo.attach('account-settings', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  await expect(otherTab.getByRole('heading', { name: '登录' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  await otherTab.close();
});

test('同浏览器切换账号不会保留另一账号数据或访问权限', async ({ page, account }) => {
  const first = await peerClient(account);
  const ledger = unwrap(
    await first.client.POST('/api/v1/ledgers', { body: { name: '账号甲专属账本', currency: 'CNY' } }),
  );
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await expect(
    page.getByRole('group', { name: '当前账本', exact: true }).getByRole('button', { name: ledger.name, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/settings');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();

  const secondAccount = newAccount();
  const second = await peerClient(secondAccount, true);
  await login(page, secondAccount);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await expect(page.getByText('账号甲专属账本')).toHaveCount(0);
  const forbidden = await second.client.GET('/api/v1/ledgers/{ledger_id}/transactions', {
    params: { path: { ledger_id: ledger.id } },
  });
  expect([403, 404]).toContain(forbidden.response.status);
  expect(unwrap(await second.client.GET('/api/v1/ledgers'))).toEqual([]);
  await page.goBack();
  await expect(page.getByText('账号甲专属账本')).toHaveCount(0);
});

test('修改密码支持单字符和 128 字符，保存后新密码可在其他设备登录', async ({ page, account }) => {
  await login(page, account);
  await page.goto('/settings');
  for (const next of ['1', 'a'.repeat(128)]) {
    await page.getByLabel('当前密码', { exact: true }).fill(account.password);
    await page.getByLabel('新密码', { exact: true }).fill(next);
    await page.getByLabel('确认新密码', { exact: true }).fill(next);
    const saved = page.waitForResponse(
      (response) => response.url().endsWith('/api/v1/auth/password') && response.status() === 204,
    );
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await saved;
    await expect(page.getByRole('status')).toContainText('密码已更新');
    account.password = next;
    const peer = await peerClient(account);
    expect(unwrap(await peer.client.GET('/api/v1/profile/me')).phone).toBe(`+86${account.phone}`);
    await page.getByRole('button', { name: '再次修改密码', exact: true }).click();
  }
});

test('空状态、浏览器导航与桌面手机布局', async ({ page, account }, testInfo) => {
  await login(page, account);
  for (const route of ['/accounting', '/memos', '/credentials', '/days', '/fitness', '/settings']) {
    await page.goto(route);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('.loading-state')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);

    await testInfo.attach(`empty-${route.slice(1)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
  await page.goto('/memos');
  await page.goto('/days');
  await page.goBack();
  await expect(page).toHaveURL(/\/memos$/);
  await expect(page.getByRole('heading', { name: '备忘录', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/days$/);
  await expect(page.getByRole('heading', { name: '日子', exact: true })).toBeVisible();
});
