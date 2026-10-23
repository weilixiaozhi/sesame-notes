import { randomUUID } from 'node:crypto';
import { unwrap } from '@sesame-notes/api-client';
import { convertCalendar, solarDate } from '../src/features/days/day-dates';
import { newWorkout } from '../src/features/fitness/fitness-model';
import { test, expect, login, peerClient, newAccount, type Mutation } from './fixtures';

test('生活日历聚合五类内容、修改日归档、农历与深链和账号隔离', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  const today = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });
  const now = new Date().toISOString();
  const previous = new Date(Date.now() - 86_400_000).toISOString();
  const ledger = unwrap(await peer.client.POST('/api/v1/ledgers', { body: { name: '日历账本', currency: 'CNY' } }));
  unwrap(
    await peer.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
      body: {
        tx_type: 'expense',
        amount: '12.5',
        native_amount: '12.5',
        currency_code: 'CNY',
        happened_at: now,
        note: '日历当天支出',
      },
    }),
  );
  const memoId = randomUUID();
  const credentialId = randomUUID();
  for (const [id, type, name] of [
    [memoId, 'normal', '日历备忘录'],
    [credentialId, 'credentials', '日历账号卡片'],
  ] as const) {
    await peer.push({
      mutation_id: randomUUID(),
      entity_type: 'memo_book',
      day_book_id: null,
      entity_id: id,
      memo_book_id: id,
      ledger_id: null,
      base_revision: 0,
      action: 'upsert',
      updated_at: previous,
      payload: { name, type, created_at: previous, updated_at: previous },
    });
  }
  const books = unwrap(await peer.client.GET('/api/v1/sync/memo-books')).memo_books;
  const memo = books.find((item) => item.id === memoId)!;
  const credential = books.find((item) => item.id === credentialId)!;
  const memoEntry = randomUUID();
  const memoChange: Extract<Mutation, { entity_type: 'memo_entry'; action: 'upsert' }> = {
    mutation_id: randomUUID(),
    entity_type: 'memo_entry',
    day_book_id: null,
    entity_id: memoEntry,
    memo_book_id: memo.id,
    ledger_id: null,
    sync_id: memo.sync_id,
    base_revision: 0,
    action: 'upsert',
    updated_at: previous,
    payload: {
      book_type: 'normal',
      title: '昨天创建的备忘录',
      body_format: 'delta_v1',
      body: { ops: [{ insert: '日历只显示标题，正文不放进格子\n' }] },
      order_key: null,
      created_at: previous,
      updated_at: previous,
    },
  };
  await peer.push(memoChange);
  const first = unwrap(
    await peer.client.GET('/api/v1/memo-books/{memo_book_id}/entries', { params: { path: { memo_book_id: memo.id } } }),
  ).items[0]!;
  await peer.push({
    ...memoChange,
    mutation_id: randomUUID(),
    base_revision: first.revision,
    updated_at: now,
    payload: { ...memoChange.payload, title: '今天修改的备忘录', updated_at: now },
  });
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'memo_entry',
    day_book_id: null,
    entity_id: randomUUID(),
    memo_book_id: credential.id,
    ledger_id: null,
    sync_id: credential.sync_id,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: {
      book_type: 'credentials',
      title: '日历私密账号',
      body_format: 'fields_v1',
      body: { fields: [{ label: '密码', value: 'calendar-private-value' }] },
      order_key: '0',
      created_at: now,
      updated_at: now,
    },
  });

  const dayId = randomUUID();
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'day_book',
    entity_id: dayId,
    day_book_id: dayId,
    ledger_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: { name: '日历农历本', created_at: now },
  });
  const day = unwrap(await peer.client.GET('/api/v1/sync/day-books')).day_books[0]!;
  const eventId = randomUUID();
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'day_event',
    entity_id: eventId,
    day_book_id: day.id,
    ledger_id: null,
    sync_id: day.sync_id,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: {
      name: '农历当天生日',
      category: 'birthday',
      countdown_mode: null,
      interval_days: null,
      repeat_type: 'yearly',
      statistic_type: 'day',
      event: convertCalendar(solarDate(today), 'lunar'),
      start: null,
      end: null,
      created_at: now,
    },
  });
  const spaceId = randomUUID();
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'fitness_space',
    day_book_id: null,
    memo_book_id: null,
    entity_id: spaceId,
    fitness_space_id: spaceId,
    ledger_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: { name: '日历训练空间', created_at: now, updated_at: now },
  });
  const space = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces[0]!;
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'fitness_workout',
    day_book_id: null,
    memo_book_id: null,
    entity_id: randomUUID(),
    fitness_space_id: space.id,
    ledger_id: null,
    sync_id: space.sync_id,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: newWorkout('日历当天训练', today, undefined, now),
  });

  const url = `/calendar?date=${today}&ledger=${ledger.id}&memo=${memo.id}&credential=${credential.id}&day=${day.id}&space=${space.id}`;
  await page.goto(url);
  await expect(page.getByRole('heading', { name: '日历', exact: true })).toBeVisible();
  const yearPicker = page.getByRole('combobox', { name: '日历年份', exact: true });
  const monthPicker = page.getByRole('combobox', { name: '日历月份', exact: true });
  const currentYear = today.slice(0, 4);
  const currentMonth = today.slice(5, 7);
  await expect(yearPicker).toHaveValue(currentYear);
  await expect(monthPicker).toHaveValue(currentMonth);
  await expect(yearPicker.locator('option:checked')).toHaveText(`${currentYear}年`);
  await expect(monthPicker.locator('option:checked')).toHaveText(`${String(Number(currentMonth))}月`);
  for (const picker of [yearPicker, monthPicker]) {
    await picker.scrollIntoViewIfNeeded();
    const box = await picker.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  }
  const checkMonthAndScope = async (month: string) => {
    await expect.poll(() => new URL(page.url()).searchParams.get('month')).toBe(month);
    const parameters = new URL(page.url()).searchParams;
    expect(parameters.get('date')).toBe(`${month}-01`);
    for (const [key, id] of Object.entries({
      ledger: ledger.id,
      memo: memo.id,
      credential: credential.id,
      day: day.id,
      space: space.id,
    }))
      expect(parameters.get(key), '选择月份必须保留已选择的内容范围').toBe(id);
  };
  const anotherMonth = String((Number(currentMonth) % 12) + 1).padStart(2, '0');
  await monthPicker.selectOption(anotherMonth);
  await checkMonthAndScope(`${currentYear}-${anotherMonth}`);
  const anotherYear = String(Number(currentYear) < 2100 ? Number(currentYear) + 1 : Number(currentYear) - 1);
  await yearPicker.selectOption(anotherYear);
  await checkMonthAndScope(`${anotherYear}-${anotherMonth}`);
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await expect(yearPicker).toHaveValue(currentYear);
  await expect(monthPicker).toHaveValue(currentMonth);
  await expect.poll(() => new URL(page.url()).searchParams.get('date')).toBe(today);
  const cell = page.getByRole('button', { name: new RegExp(`^${today}，`) });
  await expect(cell).toHaveAttribute('aria-label', /支出 12\.5 CNY.*1 条备忘录.*1 张账号卡片.*1 次训练.*1 个日子/);
  await expect(page.getByRole('link', { name: /今天修改的备忘录/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /农历当天生日/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /日历当天训练/ })).toBeVisible();
  await expect(page.getByText('calendar-private-value', { exact: true })).toHaveCount(0);
  await expect(page.getByText('日历只显示标题，正文不放进格子', { exact: true })).toHaveCount(0);

  await testInfo.attach('calendar-populated', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });

  await page.getByRole('link', { name: /今天修改的备忘录/ }).click();
  await expect(page.getByRole('dialog').getByLabel('标题', { exact: true })).toHaveValue('今天修改的备忘录');
  await page.goBack();
  await expect(page).toHaveURL(/\/calendar\?/);
  await page.getByRole('link', { name: /农历当天生日/ }).click();
  await expect(page.getByRole('dialog').getByLabel('名称', { exact: true })).toHaveValue('农历当天生日');
  await page.goBack();
  await page.getByRole('link', { name: /日历当天训练/ }).click();
  await expect(page.getByRole('dialog', { name: '日历当天训练', exact: true })).toBeVisible();
  await page.goBack();
  await page.getByRole('link', { name: '查看当天账目', exact: true }).click();
  await expect(page.getByText('日历当天支出', { exact: true })).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: '上个月', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('link', { name: /今天修改的备忘录/ })).toBeVisible();

  await page.goto('/settings');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  const otherAccount = newAccount();
  const other = await peerClient(otherAccount, true);
  await login(page, otherAccount);
  const foreignScopeRequests: string[] = [];
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (
      requestUrl.pathname.startsWith('/api/') &&
      [ledger.id, memo.id, credential.id, day.id, space.id].some(
        (id) => requestUrl.pathname.includes(id) || [...requestUrl.searchParams.values()].includes(id),
      )
    )
      foreignScopeRequests.push(requestUrl.pathname);
  });
  await page.goto(url);
  await page.getByText('选择日历内容', { exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('所选内容已不存在或无法访问，请展开“选择日历内容”重新选择。');
  for (const label of ['日历账本', '日历备忘录本', '日历账号密码本', '日历日子本', '日历健身空间'])
    await expect(page.getByRole('combobox', { name: label, exact: true })).toHaveValue('');
  await expect(page.getByRole('link', { name: /今天修改的备忘录|农历当天生日|日历当天训练|日历当天支出/ })).toHaveCount(
    0,
  );
  await expect(page.getByText('calendar-private-value', { exact: true })).toHaveCount(0);
  const denied = await other.client.GET('/api/v1/memo-books/{memo_book_id}/calendar-counts', {
    params: {
      path: { memo_book_id: memo.id },
      query: { since: previous, until: now, time_zone: 'Asia/Shanghai', sync_id: memo.sync_id },
    },
  });
  expect([403, 404]).toContain(denied.response.status);
  expect(foreignScopeRequests, '跨账号深链不得发起旧账号内容查询').toEqual([]);
});
