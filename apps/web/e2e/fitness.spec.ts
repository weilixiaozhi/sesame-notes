import { unwrap, type paths } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';
import { ensureRecordingStarted, openBookManagement } from './recording-start';

test('健身空间、安排训练、执行状态与官方模板独立副本', async ({ page, account, diagnostics }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  const mediaRequests: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/fitness/media/')) mediaRequests.push(url);
  });
  const catalogResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/fitness/catalog',
  );
  await page.goto('/fitness');
  const publicCatalog = await catalogResponse;
  expect(publicCatalog.status()).toBe(200);
  const catalog: { exercises: Array<{ id: string; media_url: string }> } = await publicCatalog.json();
  const benchPress = catalog.exercises.find((exercise) => exercise.id === '0025');
  expect(benchPress?.media_url).toMatch(/^\/api\/v1\/fitness\/media\//);
  await ensureRecordingStarted(page, 'fitness');
  const initialSpaces = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces;
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '新建空间', exact: true }).click();
  await page.getByLabel('空间名称').fill('浏览器训练空间');
  diagnostics.connectionFailureExpected = true;
  const spaceWrites: string[] = [];
  // 先让真实服务端完成写入，再丢弃回执；未修改草稿的重试必须复用整个命令。
  await page.route('**/api/v1/sync/push', async (route) => {
    spaceWrites.push(route.request().postData()!);
    if (spaceWrites.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      const result: paths['/api/v1/sync/push']['post']['responses'][200]['content']['application/json'] =
        await committed.json();
      expect(result.outcomes[0]?.status).toBe('accepted');
      await route.abort('connectionrefused');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '保存空间', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建健身空间', exact: true });
  await expect(editor.getByRole('alert')).toBeVisible();
  const committedSpaces = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces;
  expect(committedSpaces).toHaveLength(initialSpaces.length + 1);
  const committed = committedSpaces.find((item) => item.name === '浏览器训练空间')!;
  expect(committed).toBeDefined();
  await editor.getByRole('button', { name: '保存空间', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(spaceWrites).toHaveLength(2);
  expect(spaceWrites[1]).toBe(spaceWrites[0]);
  await page.unroute('**/api/v1/sync/push');
  diagnostics.connectionFailureExpected = false;
  const spaces = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces;
  expect(spaces).toHaveLength(initialSpaces.length + 1);
  expect(spaces.filter((item) => initialSpaces.some((initial) => initial.id === item.id))).toEqual(initialSpaces);
  const space = spaces.find((item) => item.id === committed.id)!;
  expect(space.id).toBe(committed.id);
  expect(space.name).toBe('浏览器训练空间');
  await page.getByRole('button', { name: '安排训练', exact: true }).click();
  await page.getByLabel('训练名称').fill('Web 真实训练');
  await expect.poll(() => page.getByLabel('添加动作').locator('option').count()).toBeGreaterThan(1);
  await page.getByLabel('添加动作').selectOption(benchPress!.id);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByLabel('次数', { exact: true }).fill('12');
  await page.getByRole('button', { name: '保存训练', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Web 真实训练/ })).toBeVisible();
  const readWorkouts = async () =>
    unwrap(
      await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/workouts', {
        params: { path: { fitness_space_id: space.id } },
      }),
    ).items;
  let workouts = await readWorkouts();
  expect(workouts).toHaveLength(1);
  expect(workouts[0]).toMatchObject({ name: 'Web 真实训练', status: 'scheduled' });
  expect(workouts[0]?.exercises[0]?.exercise_id).toBe(benchPress!.id);
  expect(workouts[0]?.exercises[0]?.sets[0]?.reps).toBe(12);

  await page.getByRole('button', { name: /Web 真实训练/ }).click();
  await page.getByRole('button', { name: '开始训练', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停训练', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暂停训练', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续训练', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续训练', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停训练', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第 1 组', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成训练', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '完成训练', exact: true }).click();
  await page
    .getByRole('dialog', { name: '完成这次训练？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '完成这次训练？', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '完成训练', exact: true })).toHaveCount(0);
  workouts = await readWorkouts();
  expect(workouts[0]?.status).toBe('completed');
  expect(workouts[0]?.run_segments.length).toBeGreaterThanOrEqual(2);
  expect(workouts[0]?.run_segments.every((segment) => segment.ended_at !== null)).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await testInfo.attach('fitness-data', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: '训练日历', exact: true }).click();
  await expect(
    page.getByRole('button', { name: `${workouts[0]!.scheduled_date}，1次训练，0项休息安排`, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Web 真实训练/ }).click();
  await expect(page.getByRole('dialog', { name: 'Web 真实训练', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await testInfo.attach('fitness-calendar', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: '训练统计', exact: true }).click();
  await expect(page.getByRole('heading', { name: '训练时长趋势', exact: true })).toBeVisible();
  for (const period of ['周', '月', '年']) {
    const response =
      period === '月'
        ? null
        : page.waitForResponse((item) => item.url().includes('/statistics?') && item.status() === 200);
    await page.getByRole('button', { name: period, exact: true }).click();
    if (response) {
      const result: paths['/api/v1/fitness-spaces/{fitness_space_id}/statistics']['get']['responses'][200]['content']['application/json'] =
        await (await response).json();
      expect(result.completed_workouts).toBe(1);
      expect(result.training_days).toBe(1);
      expect(result.completed_sets).toBe(1);
    }
    await expect(page.getByRole('button', { name: period, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await testInfo.attach('fitness-statistics', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: '动作库', exact: true }).click();
  await page.getByPlaceholder('动作名称').fill('杠铃卧推');
  const preview = page.getByRole('img', { name: '杠铃卧推静态预览', exact: true });
  await expect(preview).toHaveAttribute('src', `${benchPress!.media_url}?preview=1`);
  await expect
    .poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
    .toBe(true);
  expect(mediaRequests.length).toBeGreaterThan(0);
  expect(mediaRequests.every((url) => url.searchParams.get('preview') === '1')).toBe(true);
  await page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: '杠铃卧推', exact: true }) })
    .click();
  const gif = page.getByRole('img', { name: '杠铃卧推动作演示', exact: true });
  await expect(gif).toBeVisible();
  await expect
    .poll(() => gif.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))
    .toBe(true);
  await expect(gif).toHaveAttribute('src', benchPress!.media_url);
  expect(mediaRequests.filter((url) => !url.searchParams.has('preview')).map((url) => url.pathname)).toEqual([
    benchPress!.media_url,
  ]);
  await expect(page.locator('body')).not.toContainText(/Gym\s*Visual/i);
  await expect(page.locator('a[href*="gymvisual.com"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开训练 Web 真实训练', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开训练 Web 真实训练', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Web 真实训练', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: '官方内容库', exact: true }).click();
  const library = unwrap(await peer.client.GET('/api/v1/fitness/library'));
  expect(library.templates.length).toBeGreaterThan(0);
  const official = library.templates[0]!;
  await page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: official.name.zh, exact: true }) })
    .click();
  await page.getByRole('button', { name: '添加到我的模板', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '我的模板', exact: true }).click();
  await expect(page.getByRole('heading', { name: official.name.zh, exact: true })).toBeVisible();
  const templates = unwrap(
    await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
      params: { path: { fitness_space_id: space.id } },
    }),
  ).items;
  expect(templates).toHaveLength(1);
  expect(templates[0]?.id).not.toBe(official.id);
  expect(templates[0]?.catalog_origin?.item_id).toBe(official.id);

  await page.getByRole('button', { name: '训练计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有训练计划' })).toBeVisible();
});
