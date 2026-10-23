import { randomUUID } from 'node:crypto';
import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient, type Mutation } from './fixtures';
import { ensureRecordingStarted, openBookManagement } from './recording-start';

test('备忘录真实 CRUD、断网恢复、同步 push/pull 与版本冲突保护', async ({
  page,
  context,
  account,
  diagnostics,
}, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/memos');
  await ensureRecordingStarted(page, 'memos');
  await openBookManagement(page, 'memos');
  await page.getByRole('button', { name: '新建本子', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('浏览器备忘录');
  await page.getByRole('button', { name: '保存本子', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const book = unwrap(await peer.client.GET('/api/v1/sync/memo-books')).memo_books.find(
    (item) => item.name === '浏览器备忘录',
  )!;
  expect(book).toBeDefined();
  await page.getByRole('button', { name: '写一条备忘录', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('离线时保留的草稿');
  await page.getByRole('textbox', { name: '备忘录正文' }).fill('真实后端记录\n第二行内容');
  diagnostics.offlineExpected = true;
  await context.setOffline(true);
  try {
    await expect(page.locator('.offline-banner')).toBeVisible();
    await expect(page.locator('.offline-banner')).toContainText('网络已断开');
    await page.getByRole('button', { name: '保存备忘录', exact: true }).click();
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('离线时保留的草稿');
    await expect(page.getByRole('dialog').locator('button[type="submit"]')).toBeDisabled();
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开 离线时保留的草稿', exact: true })).toBeVisible();

  const entries = unwrap(
    await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', { params: { path: { memo_book_id: book.id } } }),
  ).items;
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  expect(entry.body).toEqual({ ops: [{ insert: '真实后端记录\n第二行内容\n' }] });
  const pull = unwrap(await peer.client.GET('/api/v1/sync/pull', { params: { query: { since: '0', limit: 500 } } }));
  expect(pull.changes.some((change) => change.entity_id === entry.id && change.entity_type === 'memo_entry')).toBe(
    true,
  );

  const change: Extract<Mutation, { entity_type: 'memo_entry'; action: 'upsert' }> = {
    mutation_id: randomUUID(),
    entity_type: 'memo_entry',
    entity_id: entry.id,
    ledger_id: null,
    day_book_id: null,
    memo_book_id: book.id,
    sync_id: entry.sync_id,
    base_revision: entry.revision,
    updated_at: new Date().toISOString(),
    action: 'upsert',
    payload: {
      book_type: entry.book_type,
      title: '来自另一个同步设备',
      body_format: entry.body_format,
      body: entry.body,
      order_key: entry.order_key,
      created_at: entry.created_at,
      updated_at: new Date().toISOString(),
    },
  };
  await peer.push(change);
  expect((await peer.push(change)).status).toBe('ignored');
  // 不重新加载网页：服务端变更提示必须让已打开的页面重新读取权威数据。
  await expect(page.getByRole('button', { name: '打开 来自另一个同步设备', exact: true })).toBeVisible({
    timeout: 25_000,
  });

  await testInfo.attach('memos-data', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.getByRole('button', { name: '打开 来自另一个同步设备', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('网页编辑后的备忘录');
  await page.getByRole('button', { name: '保存备忘录', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const fresh = unwrap(
    await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', { params: { path: { memo_book_id: book.id } } }),
  ).items[0]!;
  expect(fresh.title).toBe('网页编辑后的备忘录');

  await page.getByRole('button', { name: '打开 网页编辑后的备忘录', exact: true }).click();
  const concurrentTime = new Date().toISOString();
  await peer.push({
    ...change,
    mutation_id: randomUUID(),
    base_revision: fresh.revision,
    updated_at: concurrentTime,
    payload: { ...change.payload, title: '并发设备最新内容', updated_at: concurrentTime },
  });
  await page.getByLabel('标题', { exact: true }).fill('过期表单不应覆盖');
  diagnostics.conflictExpected = true;
  diagnostics.expectedConsoleErrors.push({
    message: '保存记录失败',
    context: { bookId: book.id, entryId: fresh.id, errorType: 'ApiError' },
  });
  const conflictResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/sync/push'),
  );
  await page.getByRole('button', { name: '保存备忘录', exact: true }).click();
  const rejected = await conflictResponse;
  expect(rejected.status()).toBe(200);
  expect((await rejected.json()).outcomes).toEqual(
    expect.arrayContaining([expect.objectContaining({ entity_id: fresh.id, status: 'conflict' })]),
  );
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  expect(
    unwrap(
      await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', {
        params: { path: { memo_book_id: book.id } },
      }),
    ).items[0]?.title,
  ).toBe('并发设备最新内容');
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '删除 并发设备最新内容', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    unwrap(
      await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', {
        params: { path: { memo_book_id: book.id } },
      }),
    ).items,
  ).toEqual([]);
});

test('账号卡片字段与摘要保持一致，头部关闭后不产生草稿记录', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/credentials');
  await ensureRecordingStarted(page, 'credentials');
  await openBookManagement(page, 'credentials');
  await page.getByRole('button', { name: '新建本子', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('隔离账号卡片');
  await page.getByRole('button', { name: '保存本子', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '新建账号卡片', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('不保存的草稿');
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '新建账号卡片', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('测试服务账号');
  await page.getByLabel('字段 1 值', { exact: true }).fill('e2e-account');
  await page.getByLabel('字段 2 值', { exact: true }).fill('private-test-value');
  await expect(page.getByLabel('字段 2 值', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: '保存账号卡片', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开 测试服务账号', exact: true })).toContainText(
    '密码：private-test-value',
  );
  const book = unwrap(await peer.client.GET('/api/v1/sync/memo-books')).memo_books.find(
    (item) => item.name === '隔离账号卡片',
  )!;
  const entries = unwrap(
    await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', { params: { path: { memo_book_id: book.id } } }),
  ).items;
  expect(entries).toHaveLength(1);
  expect(entries[0]?.title).toBe('测试服务账号');
  await expect(page.getByText('测试服务账号', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /加载|读取|连接/ })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);

  await testInfo.attach('credentials-summary', {
    body: await page.screenshot({
      fullPage: true,
      mask: [page.getByRole('button', { name: '打开 测试服务账号', exact: true }).locator('.memo-preview')],
    }),
    contentType: 'image/png',
  });
});

test('账号卡片名称排序后拖动保存同步顺序，刷新与其他设备读取一致', async ({ page, account }) => {
  const peer = await peerClient(account);
  const bookId = randomUUID();
  const now = new Date().toISOString();
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'memo_book',
    entity_id: bookId,
    memo_book_id: bookId,
    ledger_id: null,
    day_book_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: { name: '卡片排序验收', type: 'credentials', created_at: now, updated_at: now },
  });
  const book = unwrap(await peer.client.GET('/api/v1/sync/memo-books')).memo_books.find((item) => item.id === bookId)!;
  const titles = ['账号10', '账号2', '微信'];
  for (const [index, title] of titles.entries()) {
    await peer.push({
      mutation_id: randomUUID(),
      entity_type: 'memo_entry',
      entity_id: randomUUID(),
      memo_book_id: bookId,
      ledger_id: null,
      day_book_id: null,
      sync_id: book.sync_id,
      base_revision: 0,
      action: 'upsert',
      updated_at: now,
      payload: {
        book_type: 'credentials',
        title,
        body_format: 'fields_v1',
        body: { fields: [{ label: '账号', value: `合成测试${index}` }] },
        order_key: String(index),
        created_at: now,
        updated_at: now,
      },
    });
  }
  await login(page, account);
  await page.goto(`/credentials?book=${bookId}`);
  const names = page.locator('.memo-credential-card h3');
  await expect(names).toHaveText(titles);
  await page.getByLabel('排序方式', { exact: true }).selectOption('title');
  await expect(names).toHaveText(['微信', '账号2', '账号10']);
  await page
    .getByRole('button', { name: '拖动 微信', exact: true })
    .dragTo(
      page
        .locator('.memo-credential-card')
        .filter({ has: page.getByRole('button', { name: '打开 账号10', exact: true }) }),
    );
  await expect(page.getByRole('status').filter({ hasText: '卡片顺序已保存' })).toBeVisible();
  await expect(names).toHaveText(['账号2', '账号10', '微信']);
  const entries = unwrap(
    await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', { params: { path: { memo_book_id: bookId } } }),
  ).items;
  expect(
    entries.sort((left, right) => Number(left.order_key) - Number(right.order_key)).map((entry) => entry.title),
  ).toEqual(['账号2', '账号10', '微信']);
  for (const entry of entries) {
    expect(entry.body).toEqual({ fields: [{ label: '账号', value: `合成测试${titles.indexOf(entry.title)}` }] });
  }
  await page.reload();
  await expect(names).toHaveText(['账号2', '账号10', '微信']);
});

test('账号卡片在超大顺序键和设备时间回拨时仍追加到末尾', async ({ page, account }) => {
  const peer = await peerClient(account);
  const bookId = randomUUID();
  const now = new Date().toISOString();
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'memo_book',
    entity_id: bookId,
    memo_book_id: bookId,
    ledger_id: null,
    day_book_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: { name: '卡片追加顺序验收', type: 'credentials', created_at: now, updated_at: now },
  });
  const book = unwrap(await peer.client.GET('/api/v1/sync/memo-books')).memo_books.find((item) => item.id === bookId)!;
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'memo_entry',
    entity_id: randomUUID(),
    memo_book_id: bookId,
    ledger_id: null,
    day_book_id: null,
    sync_id: book.sync_id,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: {
      book_type: 'credentials',
      title: '已有大整数卡片',
      body_format: 'fields_v1',
      body: { fields: [] },
      order_key: '9007199254740993',
      created_at: now,
      updated_at: now,
    },
  });
  await login(page, account);
  await page.goto(`/credentials?book=${bookId}`);
  await page.clock.setFixedTime(new Date(Date.now() - 60 * 60_000));
  await page.getByRole('button', { name: '新建账号卡片', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('追加的新卡片');
  await page.getByRole('button', { name: '保存账号卡片', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.memo-credential-card h3')).toHaveText(['已有大整数卡片', '追加的新卡片']);
  const snapshot = unwrap(
    await peer.client.GET('/api/v1/sync/memo-books/full', {
      params: { query: { memo_book_id: bookId, sync_id: book.sync_id } },
    }),
  );
  expect(snapshot.memo_entries.map((entry) => entry.order_key)).toEqual(['9007199254740993', '9007199254740994']);
});

test('日子本和纪念日创建、修改、删除并保留日期协议', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/days');
  await ensureRecordingStarted(page, 'days');
  await openBookManagement(page, 'days');
  await page.getByRole('button', { name: '新建日子本', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('浏览器重要日期');
  await page.getByRole('button', { name: '保存本子', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '添加日子', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('开始记录的日子');
  await page.getByLabel('日期', { exact: true }).fill('2024-02-29');
  await page.getByRole('button', { name: '保存日子', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑 开始记录的日子', exact: true })).toBeVisible();
  const book = unwrap(await peer.client.GET('/api/v1/sync/day-books')).day_books.find(
    (item) => item.name === '浏览器重要日期',
  )!;
  let events = unwrap(
    await peer.client.GET('/api/v1/day-books/{day_book_id}/events', { params: { path: { day_book_id: book.id } } }),
  ).items;
  expect(events).toHaveLength(1);
  expect(events[0]?.event).toMatchObject({ calendar_type: 'solar', solar_date: '2024-02-29' });
  await page.getByRole('button', { name: '编辑 开始记录的日子', exact: true }).click();
  await page.getByRole('dialog').getByLabel('名称', { exact: true }).fill('值得记住的开始');
  await page.getByRole('button', { name: '保存日子', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑 值得记住的开始', exact: true })).toBeVisible();

  await testInfo.attach('days-data', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  events = unwrap(
    await peer.client.GET('/api/v1/day-books/{day_book_id}/events', { params: { path: { day_book_id: book.id } } }),
  ).items;
  expect(events[0]?.name).toBe('值得记住的开始');
  await page.getByRole('button', { name: '删除 值得记住的开始', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    unwrap(
      await peer.client.GET('/api/v1/day-books/{day_book_id}/events', { params: { path: { day_book_id: book.id } } }),
    ).items,
  ).toEqual([]);
});
