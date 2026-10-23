import { readFile } from 'node:fs/promises';
import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';
import { ensureRecordingStarted, openBookManagement } from './recording-start';

test('健身 JSON 原子导入、重复回执、CSV 导出与独立空间重新导入', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  await login(page, account);
  await page.goto('/fitness');
  await ensureRecordingStarted(page, 'fitness');
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '新建空间', exact: true }).click();
  await page.getByLabel('空间名称').fill('数据传输验收');
  await page.getByRole('button', { name: '保存空间', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const space = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces.find(
    (item) => item.name === '数据传输验收',
  )!;
  const now = new Date().toISOString();
  const sourceId = crypto.randomUUID();
  const source = [
    {
      entity_type: 'fitness_template',
      id: sourceId,
      name: '保留精确重量的模板',
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
              weight: '123456789012345678.1234567891',
              weight_left: null,
              weight_right: null,
              reps: 8,
            },
          ],
        },
      ],
      created_at: now,
      updated_at: now,
    },
  ];
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '导入与导出', exact: true }).click();
  await page.getByLabel('选择健身文件', { exact: true }).setInputFiles({
    name: '手机健身.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  await page.getByRole('button', { name: '校验并预览', exact: true }).click();
  await expect(page.getByText('已选择 1 / 1 条', { exact: true })).toBeVisible();
  expect(
    unwrap(
      await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
        params: { path: { fitness_space_id: space.id } },
      }),
    ).items,
  ).toHaveLength(0);
  await page.getByRole('button', { name: '确认导入所选记录', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '新增 1 条' })).toBeVisible();
  const templates = unwrap(
    await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
      params: { path: { fitness_space_id: space.id } },
    }),
  ).items;
  expect(templates).toHaveLength(1);
  expect(templates[0]?.id).not.toBe(sourceId);
  expect(templates[0]?.exercises[0]?.sets[0]?.weight).toBe(source[0]!.exercises[0]!.sets[0]!.weight);
  await page.getByRole('button', { name: '确认导入所选记录', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '新增 0 条，已导入过 1 条' })).toBeVisible();

  await testInfo.attach('fitness-import-receipt', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: '导出数据', exact: true }).click();
  await page.getByLabel('导出格式', { exact: true }).selectOption('csv');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整数据', exact: true }).click();
  const download = await downloadPromise;
  const path = testInfo.outputPath('fitness-export.csv');
  await download.saveAs(path);
  const contents = await readFile(path, 'utf8');
  expect(contents).toContain('123456789012345678.1234567891');
  expect(contents).toContain('保留精确重量的模板');
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await ensureRecordingStarted(page, 'fitness');
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '新建空间', exact: true }).click();
  await page.getByLabel('空间名称').fill('CSV 恢复目标');
  await page.getByRole('button', { name: '保存空间', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const target = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces.find(
    (item) => item.name === 'CSV 恢复目标',
  )!;
  await openBookManagement(page, 'fitness');
  await page.getByRole('button', { name: '导入与导出', exact: true }).click();
  await page.getByLabel('选择健身文件', { exact: true }).setInputFiles(path);
  await page.getByRole('button', { name: '校验并预览', exact: true }).click();
  await expect(page.getByText('已选择 1 / 1 条', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认导入所选记录', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '新增 1 条' })).toBeVisible();
  const restored = unwrap(
    await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
      params: { path: { fitness_space_id: target.id } },
    }),
  ).items;
  expect(restored).toHaveLength(1);
  expect(restored[0]?.id).not.toBe(templates[0]?.id);
  expect(restored[0]?.exercises[0]?.sets[0]?.weight).toBe(source[0]!.exercises[0]!.sets[0]!.weight);
});
