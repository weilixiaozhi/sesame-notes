import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';
import { ensureRecordingStarted, openBookManagement } from './recording-start';

test('官方计划原子复制模板，二次导入可明确复用已有模板', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  const library = unwrap(await peer.client.GET('/api/v1/fitness/library'));
  const official = library.plans[0]!;
  const referenced = [...new Set(official.days.flatMap((day) => (day.template_id ? [day.template_id] : [])))];
  await login(page, account);
  await page.goto('/fitness');
  await ensureRecordingStarted(page, 'fitness');
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '新建空间', exact: true }).click();
  await page.getByLabel('空间名称').fill('官方计划验收');
  await page.getByRole('button', { name: '保存空间', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const space = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces.find(
    (item) => item.name === '官方计划验收',
  )!;
  const readTemplates = async () =>
    unwrap(
      await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
        params: { path: { fitness_space_id: space.id } },
      }),
    ).items;
  const readPlans = async () =>
    unwrap(
      await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/plans', {
        params: { path: { fitness_space_id: space.id } },
      }),
    ).items;
  await page.getByRole('button', { name: '官方内容库', exact: true }).click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: official.name.zh, exact: true }) });
  await card.getByRole('button', { name: '添加到我的计划', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '添加官方训练计划', exact: true });
  await dialog.getByRole('button', { name: '添加到我的计划', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '已添加到我的计划', exact: true })).toBeVisible();
  const firstTemplates = await readTemplates();
  expect(firstTemplates).toHaveLength(referenced.length);
  const firstPlan = (await readPlans())[0]!;
  expect(firstPlan.status).toBe('closed');
  expect(firstPlan.catalog_origin?.item_id).toBe(official.id);
  expect(firstPlan.id).not.toBe(official.id);
  expect(
    firstPlan.days.every(
      (day) => !day.slot || firstTemplates.some((template) => template.id === day.slot?.source_template_id),
    ),
  ).toBe(true);

  await testInfo.attach('official-plan-import', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await card.getByRole('button', { name: '添加到我的计划', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '添加官方训练计划', exact: true });
  for (const id of referenced) {
    const source = library.templates.find((template) => template.id === id)!;
    const existing = firstTemplates.find((template) => template.catalog_origin?.item_id === id)!;
    await dialog.getByLabel(source.name.zh, { exact: true }).selectOption(existing.id);
  }
  await dialog.getByRole('button', { name: '添加到我的计划', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '已添加到我的计划', exact: true })).toBeVisible();
  expect(await readTemplates()).toHaveLength(referenced.length);
  expect(await readPlans()).toHaveLength(2);
});

test('计划完整排班、下周期生效、停用重启与删除保留训练历史', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/fitness');
  await ensureRecordingStarted(page, 'fitness');
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '新建空间', exact: true }).click();
  await page.getByLabel('空间名称').fill('计划验收空间');
  await page.getByRole('button', { name: '保存空间', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const space = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces.find(
    (item) => item.name === '计划验收空间',
  )!;
  const now = new Date().toISOString();
  const templateId = crypto.randomUUID();
  await peer.push({
    mutation_id: crypto.randomUUID(),
    entity_type: 'fitness_template',
    entity_id: templateId,
    fitness_space_id: space.id,
    sync_id: space.sync_id,
    ledger_id: null,
    day_book_id: null,
    memo_book_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: {
      name: '计划力量模板',
      created_at: now,
      updated_at: now,
      exercises: [
        {
          id: crypto.randomUUID(),
          exercise_id: '0025',
          rest_seconds: 90,
          warmup_rest_seconds: 30,
          sets: [
            {
              id: crypto.randomUUID(),
              kind: 'working',
              weight: '32.5',
              weight_left: null,
              weight_right: null,
              reps: 8,
            },
          ],
        },
      ],
    },
  });
  const readPlans = async () =>
    unwrap(
      await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/plans', {
        params: { path: { fitness_space_id: space.id } },
      }),
    ).items;
  const readWorkouts = async () =>
    unwrap(
      await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/workouts', {
        params: { path: { fitness_space_id: space.id } },
      }),
    ).items;
  await page.getByRole('button', { name: '训练计划', exact: true }).click();
  await page.getByRole('button', { name: '新建计划', exact: true }).first().click();
  await page.getByLabel('计划名称', { exact: true }).fill('循序渐进计划');
  await page.getByLabel('第 1 天', { exact: true }).selectOption(templateId);
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('第 2 天');
  await page.getByRole('button', { name: '未安排日期设为休息', exact: true }).click();
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const original = (await readPlans())[0]!;
  const originalWorkouts = await readWorkouts();
  expect(original.cycle_days).toBe(7);
  expect(original.generation_state.generated_cycles).toHaveLength(1);
  expect(originalWorkouts).toHaveLength(1);
  expect(originalWorkouts[0]?.source_plan_id).toBe(original.id);
  expect(originalWorkouts[0]?.exercises[0]?.sets[0]?.weight).toBe('32.5');

  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('开始日期', { exact: true })).toBeDisabled();
  await page.getByLabel('周期天数', { exact: true }).fill('2');
  await page.getByRole('button', { name: '调整周期', exact: true }).click();
  await page.getByRole('button', { name: '确认缩短', exact: true }).click();
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const edited = (await readPlans())[0]!;
  expect(edited.cycle_days).toBe(7);
  expect(edited.pending_schedule?.cycle_days).toBe(2);
  expect((await readWorkouts()).map((item) => item.id)).toEqual(originalWorkouts.map((item) => item.id));
  await page.getByRole('button', { name: '查看安排', exact: true }).click();
  await page.getByLabel('查看排班', { exact: true }).selectOption('pending');
  await expect(page.getByRole('heading', { name: '第 1 天 · 计划力量模板', exact: true })).toBeVisible();

  await testInfo.attach('plan-pending-schedule', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();

  await page.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await readPlans())[0]?.status).toBe('closed');
  expect(await readWorkouts()).toHaveLength(1);
  await page.getByRole('button', { name: '重新启用', exact: true }).click();
  await expect(page.getByRole('note')).toContainText('包括已完成训练');
  await expect(page.getByLabel('重新开始日期', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存计划', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const restarted = (await readPlans())[0]!;
  expect(restarted.cycle_days).toBe(2);
  expect(restarted.status).toBe('in_progress');
  expect(restarted.generation_state.next_cycle_index).toBe(2);
  expect((await readWorkouts())[0]?.id).not.toBe(originalWorkouts[0]?.id);

  await page.getByRole('button', { name: '删除计划 循序渐进计划', exact: true }).click();
  await page.getByRole('button', { name: '删除计划', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await readPlans()).toHaveLength(0);
  expect(await readWorkouts()).toHaveLength(1);
});
