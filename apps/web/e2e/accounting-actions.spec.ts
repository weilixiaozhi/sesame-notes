import { randomUUID } from 'node:crypto';
import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient, newAccount } from './fixtures';

test('账本清空与删除要求完整确认，并发修改拒绝旧预览且保留分类成员周期', async ({
  page,
  account,
  diagnostics,
}, testInfo) => {
  test.setTimeout(120_000);
  const owner = await peerClient(account);
  const ledger = unwrap(
    await owner.client.POST('/api/v1/ledgers', { body: { name: '清空删除验收账本', currency: 'CNY' } }),
  );
  const survivor = unwrap(
    await owner.client.POST('/api/v1/ledgers', { body: { name: '应保留的其他账本', currency: 'CNY' } }),
  );
  const category = unwrap(
    await owner.client.POST('/api/v1/ledgers/{ledger_id}/categories', {
      params: { path: { ledger_id: ledger.id } },
      body: { name: '清空后保留分类', kind: 'expense', level: 1 },
    }),
  );
  const friendAccount = newAccount();
  const friend = await peerClient(friendAccount, true);
  const invite = unwrap(
    await owner.client.POST('/api/v1/ledgers/{ledger_id}/invites', {
      params: { path: { ledger_id: ledger.id } },
      body: { expires_in_hours: 1 },
    }),
  );
  unwrap(await friend.client.POST('/api/v1/invites/{code}/accept', { params: { path: { code: invite.code } } }));
  const recurringId = randomUUID();
  await owner.push({
    entity_type: 'recurring_transaction',
    entity_id: recurringId,
    ledger_id: ledger.id,
    sync_id: ledger.sync_id,
    mutation_id: randomUUID(),
    updated_at: new Date().toISOString(),
    action: 'upsert',
    payload: {
      protocol_version: 1,
      time_zone: 'UTC',
      tx_type: 'expense',
      amount: '8.25',
      currency_code: 'CNY',
      category_id: category.id,
      note: '必须保留的暂停规则',
      frequency: 'monthly',
      interval: 1,
      day_of_month: 1,
      day_of_week: null,
      month_of_year: null,
      start_date: '2026-01-01T00:00:00.000Z',
      end_date: null,
      enabled: false,
    },
  });
  /** 仅通过隔离账号的真实生成客户端创建记录，浏览器仍走正式页面与接口。 */
  const createExpense = async (note: string) =>
    unwrap(
      await owner.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
        params: { path: { ledger_id: ledger.id } },
        body: {
          tx_type: 'expense',
          amount: '12.5',
          native_amount: '12.5',
          currency_code: 'CNY',
          category_id: category.id,
          happened_at: new Date().toISOString(),
          note,
        },
      }),
    );
  await createExpense('待清空记录一');
  await createExpense('待清空记录二');
  const snapshot = async () =>
    unwrap(
      await owner.client.GET('/api/v1/sync/full', {
        params: { query: { ledger_id: ledger.id, sync_id: ledger.sync_id } },
      }),
    );
  const before = await snapshot();
  expect(before.transactions).toHaveLength(2);
  expect(before.recurring_transactions.some((rule) => rule.id === recurringId)).toBe(true);
  const membersBefore = unwrap(
    await owner.client.GET('/api/v1/ledgers/{ledger_id}/members', {
      params: { path: { ledger_id: ledger.id } },
    }),
  );
  expect(membersBefore).toHaveLength(2);

  // 编辑成员可使用一般管理功能，清空和删除入口隐藏；直接访问写接口也由服务端拒绝。
  await login(page, friendAccount);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await expect(
    page.getByRole('group', { name: '当前账本', exact: true }).getByRole('button', { name: ledger.name, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '账本管理', exact: true }).click();
  await expect(page.getByRole('button', { name: '共享与成员', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '汇率设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '清空支出记录', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除云端账本', exact: true })).toHaveCount(0);
  const preview = unwrap(
    await owner.client.GET('/api/v1/ledgers/{ledger_id}/action-preview', {
      params: { path: { ledger_id: ledger.id } },
    }),
  );
  const denied = await friend.client.POST('/api/v1/ledgers/{ledger_id}/clear', {
    params: { path: { ledger_id: ledger.id } },
    body: { mutation_id: randomUUID(), expected_sync_id: ledger.sync_id, expected_fingerprint: preview.fingerprint },
  });
  expect(denied.response.status).toBe(403);
  expect((await snapshot()).transactions).toHaveLength(2);
  await page.goto('/settings');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await page.getByRole('button', { name: '账本管理', exact: true }).click();
  await page.getByRole('button', { name: '清空支出记录', exact: true }).click();
  const clear = page.getByRole('dialog', { name: '清空账本支出', exact: true });
  await expect(clear.getByText('2 笔支出 · 1 条周期规则 · 2 位成员', { exact: true })).toBeVisible();
  const confirmClear = clear.getByRole('button', { name: '确认清空支出', exact: true });
  await expect(confirmClear).toBeDisabled();
  await clear.getByLabel('输入完整账本名称').fill('名称错误');
  await clear.getByRole('checkbox', { name: '我已核对影响，确认要清空这些支出。', exact: true }).check();
  await expect(confirmClear).toBeDisabled();
  await clear.getByLabel('输入完整账本名称').fill(ledger.name);
  await expect(confirmClear).toBeEnabled();

  // 请求体已固定后插入另一设备的记录，保证真实接口检测到过期指纹。
  let injected = false;
  let clearWrites = 0;
  await page.route('**/api/v1/ledgers/*/clear', async (route) => {
    if (route.request().method() === 'POST') {
      clearWrites++;
      if (!injected) {
        injected = true;
        await createExpense('确认期间另一设备新增');
      }
    }
    await route.continue();
  });
  diagnostics.conflictExpected = true;
  const conflicted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/ledgers/${ledger.id}/clear`),
  );
  await confirmClear.click();
  expect((await conflicted).status()).toBe(409);
  await expect(clear.getByRole('alert')).toBeVisible();
  await expect(clear.getByText('3 笔支出 · 1 条周期规则 · 2 位成员', { exact: true })).toBeVisible();
  await expect(clear.getByLabel('输入完整账本名称')).toHaveValue('');
  await expect(clear.getByRole('checkbox')).not.toBeChecked();
  await expect(confirmClear).toBeDisabled();
  expect((await snapshot()).transactions).toHaveLength(3);
  await testInfo.attach('ledger-stale-clear-confirmation', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await clear.getByLabel('输入完整账本名称').fill(ledger.name);
  await clear.getByRole('checkbox').check();
  const cleared = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/ledgers/${ledger.id}/clear`),
  );
  await confirmClear.click({ clickCount: 2 });
  expect((await cleared).status()).toBe(200);
  await expect(clear).toHaveCount(0);
  expect(clearWrites).toBe(2);
  await page.unroute('**/api/v1/ledgers/*/clear');
  const after = await snapshot();
  expect(after.transactions).toEqual([]);
  expect(after.ledger.id).toBe(ledger.id);
  expect(after.categories.map((item) => item.id).sort()).toEqual(before.categories.map((item) => item.id).sort());
  expect(after.members.map((item) => item.id).sort()).toEqual(before.members.map((item) => item.id).sort());
  expect(after.recurring_transactions).toEqual(before.recurring_transactions);
  expect(
    unwrap(
      await owner.client.GET('/api/v1/ledgers/{ledger_id}/members', {
        params: { path: { ledger_id: ledger.id } },
      }),
    ),
  ).toEqual(membersBefore);
  await expect(page.getByRole('status').filter({ hasText: '已清空 3 笔支出' })).toBeVisible();

  await page.getByRole('button', { name: '删除云端账本', exact: true }).click();
  const remove = page.getByRole('dialog', { name: '删除云端账本', exact: true });
  const confirmDelete = remove.getByRole('button', { name: '确认删除账本', exact: true });
  await expect(confirmDelete).toBeDisabled();
  await remove.getByLabel('输入完整账本名称').fill(ledger.name);
  await expect(confirmDelete).toBeDisabled();
  await remove.getByRole('checkbox', { name: '我已核对影响，确认要删除整个云端账本。', exact: true }).check();
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' && new URL(response.url()).pathname.endsWith(`/ledgers/${ledger.id}`),
  );
  await confirmDelete.click();
  expect((await removed).status()).toBe(204);
  await expect(remove).toHaveCount(0);
  await expect(
    page
      .getByRole('group', { name: '当前账本', exact: true })
      .getByRole('button', { name: survivor.name, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(unwrap(await owner.client.GET('/api/v1/ledgers')).map((item) => item.id)).toEqual([survivor.id]);
  expect(unwrap(await friend.client.GET('/api/v1/ledgers')).some((item) => item.id === ledger.id)).toBe(false);
  const preservedCategories = unwrap(
    await owner.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: survivor.id } } }),
  );
  expect(preservedCategories.some((item) => item.id === category.id)).toBe(true);
});
