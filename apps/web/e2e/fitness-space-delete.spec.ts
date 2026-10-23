import { randomUUID } from 'node:crypto';
import { unwrap, type paths } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';
import { workoutPayload } from '../src/features/fitness/fitness-model';
import { ensureRecordingStarted, openBookManagement } from './recording-start';

type PushRequest = paths['/api/v1/sync/push']['post']['requestBody']['content']['application/json'];
type PushResponse = paths['/api/v1/sync/push']['post']['responses'][200]['content']['application/json'];

test('整健身空间删除：完整名称确认、并发新数据保护、重新核对后删除测试空间', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/fitness');
  const name = '仅供自动验收删除的空间';
  await ensureRecordingStarted(page, 'fitness');
  const initialSpaces = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces;
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '新建空间', exact: true }).click();
  await page.getByLabel('空间名称').fill(name);
  await page.getByRole('button', { name: '保存空间', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const space = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces.find(
    (item) => item.name === name,
  )!;
  expect(space).toBeDefined();
  await page.getByRole('button', { name: '安排训练', exact: true }).click();
  await page.getByLabel('训练名称').fill('仅用于删除验收的训练');
  await expect.poll(() => page.getByLabel('添加动作').locator('option').count()).toBeGreaterThan(1);
  await page.getByLabel('添加动作').selectOption('0025');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByLabel('次数', { exact: true }).fill('8');
  await page.getByRole('button', { name: '保存训练', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const workout = unwrap(
    await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/workouts', {
      params: { path: { fitness_space_id: space.id } },
    }),
  ).items[0]!;
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '删除空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除健身空间', exact: true });
  await expect(dialog.getByText('训练 1 项 · 模板 0 项 · 计划 0 项', { exact: false })).toBeVisible();
  const input = dialog.getByLabel('输入完整空间名称确认');
  const remove = dialog.getByRole('button', { name: '确认删除空间', exact: true });
  await input.fill('不完整名称');
  await expect(remove).toBeDisabled();
  await input.fill(name);
  await expect(remove).toBeEnabled();

  // 延迟浏览器已准备的旧游标删除请求，先用真实第二设备写入新训练内容。
  let raced = false;
  await page.route('**/api/v1/sync/push', async (route) => {
    const body = route.request().postDataJSON() as PushRequest;
    const change = body.changes.find((item) => item.entity_type === 'fitness_space' && item.action === 'delete');
    if (change && !raced) {
      raced = true;
      const payload = { ...workoutPayload(workout), name: '并发更新必须保留', updated_at: new Date().toISOString() };
      await peer.push({
        mutation_id: randomUUID(),
        entity_type: 'fitness_workout',
        entity_id: workout.id,
        ledger_id: null,
        day_book_id: null,
        memo_book_id: null,
        fitness_space_id: space.id,
        sync_id: space.sync_id,
        base_revision: workout.revision,
        action: 'upsert',
        updated_at: payload.updated_at,
        payload,
      });
    }
    await route.continue();
  });
  const rejectedResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/sync/push'),
  );
  await remove.click();
  const rejected: PushResponse = await (await rejectedResponse).json();
  expect(rejected.outcomes.some((item) => item.status === 'accepted' || item.status === 'ignored')).toBe(false);
  await expect(dialog.getByRole('alert')).toBeVisible();
  const stillPresent = unwrap(
    await peer.client.GET('/api/v1/sync/fitness-spaces/full', { params: { query: { fitness_space_id: space.id } } }),
  );
  expect(stillPresent.fitness_workouts[0]?.name).toBe('并发更新必须保留');
  await dialog.getByRole('button', { name: '重新核对空间', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(remove).toBeDisabled();
  await input.fill(name);
  await expect(remove).toBeEnabled();

  await testInfo.attach('fitness-delete-confirmation', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await remove.click();
  await expect(dialog).toHaveCount(0);
  const spaces = page.getByRole('group', { name: '健身空间', exact: true });
  await expect(spaces.getByRole('button', { name: initialSpaces[0]!.name, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(spaces.getByRole('button', { name, exact: true })).toHaveCount(0);
  const after = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces'));
  expect(after.fitness_spaces).toEqual(initialSpaces);
  expect(after.fitness_spaces.some((item) => item.id === space.id)).toBe(false);
  const full = await peer.client.GET('/api/v1/sync/fitness-spaces/full', {
    params: { query: { fitness_space_id: space.id } },
  });
  expect(full.response.status).toBe(404);
});
