import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';
import { ensureRecordingStarted } from './recording-start';

test('账本、分类、支出编辑删除，重复提交与取消', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/accounting');
  await ensureRecordingStarted(page, 'accounting');
  await page.getByRole('button', { name: '账本管理', exact: true }).click();
  await page.getByRole('button', { name: '新建账本', exact: true }).click();
  await page.getByLabel('账本名称').fill('浏览器验收账本');
  await page.getByRole('button', { name: '保存账本', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const ledger = unwrap(await peer.client.GET('/api/v1/ledgers')).find((item) => item.name === '浏览器验收账本')!;
  expect(ledger).toBeDefined();
  await expect(
    page.getByRole('group', { name: '当前账本', exact: true }).getByRole('button', { name: ledger.name, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: '添加分类', exact: true }).click();
  await page.getByLabel('分类名称').fill('验收餐饮');
  await page.getByRole('button', { name: '保存分类', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑分类验收餐饮', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '编辑分类验收餐饮', exact: true }).click();
  await page.getByLabel('分类名称').fill('验收日常餐饮');
  await page.getByRole('button', { name: '保存分类', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑分类验收日常餐饮', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: '支出分类', exact: true }).getByRole('button', { name: '关闭弹窗' }).click();

  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('记账金额').fill('25.30');
  await page.getByRole('button', { name: '选择分类 验收日常餐饮', exact: true }).click();
  await page.getByLabel('备注', { exact: true }).fill('双击只保存一笔');
  const cursor = unwrap(
    await peer.client.GET('/api/v1/sync/pull', { params: { query: { since: '0', limit: 500 } } }),
  ).server_cursor;
  let submitted = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/ledgers/*/transactions', async (route) => {
    if (route.request().method() === 'POST') {
      submitted += 1;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '完成', exact: true }).click({ clickCount: 2 });
    await expect.poll(() => submitted).toBe(1);
    await expect(page.getByRole('dialog').locator('button[type="submit"]')).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.unroute('**/api/v1/ledgers/*/transactions');
  let transactions = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', { params: { path: { ledger_id: ledger.id } } }),
  ).items;
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ amount: '25.3', note: '双击只保存一笔' });
  const transaction = transactions[0]!;
  const pulled = unwrap(
    await peer.client.GET('/api/v1/sync/pull', { params: { query: { since: cursor, limit: 500 } } }),
  );
  expect(pulled.changes.some((change) => change.entity_id === transaction.id && change.action === 'upsert')).toBe(true);

  await page.getByRole('button', { name: /^查看双击只保存一笔 / }).click();
  const detail = page.getByRole('dialog', { name: '验收日常餐饮', exact: true });
  await expect(detail.getByLabel('记账金额 CNY 25.3', { exact: true })).toBeVisible();
  await expect(detail.getByText('双击只保存一笔', { exact: true })).toBeVisible();
  await expect(detail.locator('input, textarea')).toHaveCount(0);
  await detail.getByRole('button', { name: '编辑记账', exact: true }).click();
  await page.getByLabel('记账金额').fill('32.50');
  await page.getByLabel('备注', { exact: true }).fill('编辑后的真实支出');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('编辑后的真实支出', { exact: true })).toBeVisible();

  await testInfo.attach('accounting-data', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: '记一笔', exact: true }).click();
  await page.getByLabel('记账金额').fill('99');
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('记账金额')).toHaveValue('99');
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  transactions = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', { params: { path: { ledger_id: ledger.id } } }),
  ).items;
  expect(transactions).toHaveLength(1);
  expect(transactions[0]).toMatchObject({ amount: '32.5', note: '编辑后的真实支出' });
  await page.getByRole('button', { name: /^查看编辑后的真实支出 / }).click();
  await page
    .getByRole('dialog', { name: '验收日常餐饮', exact: true })
    .getByRole('button', { name: '删除', exact: true })
    .click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    unwrap(
      await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', { params: { path: { ledger_id: ledger.id } } }),
    ).items,
  ).toEqual([]);

  await page.getByRole('button', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: '删除分类验收日常餐饮', exact: true }).click();
  const deletedCategory = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/categories/remove'),
  );
  await page.getByLabel('输入完整分类名称确认').fill('验收日常餐饮');
  await page.getByRole('button', { name: '确认处理分类', exact: true }).click();
  expect((await deletedCategory).status()).toBe(200);
  await expect(page.getByRole('dialog', { name: '处理所选分类', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除分类验收日常餐饮', exact: true })).toHaveCount(0);
  const categories = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(categories.some((category) => category.name === '验收日常餐饮')).toBe(false);
});

test('手机可查看归档支出详情，保留金额分类备注且不提供编辑删除', async ({ page, account }) => {
  try {
    const peer = await peerClient(account);
    const ledger = unwrap(
      await peer.client.POST('/api/v1/ledgers', { body: { name: '归档详情验收账本', currency: 'CNY' } }),
    );
    const category = unwrap(
      await peer.client.POST('/api/v1/ledgers/{ledger_id}/categories', {
        params: { path: { ledger_id: ledger.id } },
        body: { name: '归档详情分类', kind: 'expense', level: 1 },
      }),
    );
    unwrap(
      await peer.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
        params: { path: { ledger_id: ledger.id } },
        body: {
          tx_type: 'expense',
          amount: '18.5',
          native_amount: '18.5',
          currency_code: 'CNY',
          category_id: category.id,
          happened_at: new Date().toISOString(),
          note: '归档后仍可回顾',
        },
      }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, account);
    await page.goto(`/accounting?ledger=${ledger.id}`);
    await expect(page.getByRole('button', { name: /^删除归档后仍可回顾 / })).toBeHidden();
    await page.getByRole('button', { name: '账本管理', exact: true }).click();
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await page.getByRole('button', { name: '确认归档', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const record = page.getByRole('button', { name: /^查看归档后仍可回顾 / });
    await expect(record).toBeEnabled();
    await record.click();
    const detail = page.getByRole('dialog', { name: category.name, exact: true });
    await expect(detail.getByLabel('记账金额 CNY 18.5', { exact: true })).toBeVisible();
    await expect(detail.getByText('归档后仍可回顾', { exact: true })).toBeVisible();
    await expect(detail.getByText('支出统计', { exact: true })).toHaveCount(0);
    await expect(detail.getByText(/不计支出|不计入统计|计入支出/)).toHaveCount(0);
    await expect(detail.getByRole('button', { name: '编辑记账', exact: true })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
    await expect(detail.locator('input, textarea')).toHaveCount(0);
    await detail.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } catch (error) {
    console.error('归档支出详情验收失败', { error });
    throw error;
  }
});
