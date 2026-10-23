import { randomUUID } from 'node:crypto';
import { unwrap, type paths } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';
import { newWorkout, type TemplatePayload, type WorkoutPayload } from '../src/features/fitness/fitness-model';

type Peer = Awaited<ReturnType<typeof peerClient>>;

/** 每项只为新注册的合成账号创建独立空间，不读取任何现有云数据。 */
async function createSpace(peer: Peer) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'fitness_space',
    entity_id: id,
    fitness_space_id: id,
    ledger_id: null,
    day_book_id: null,
    memo_book_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload: { name: '动作替换验收空间', created_at: now, updated_at: now },
  });
  const space = unwrap(await peer.client.GET('/api/v1/sync/fitness-spaces')).fitness_spaces.find(
    (item) => item.id === id,
  );
  expect(space).toBeDefined();
  return space!;
}

/** 两个动作分别使用总重和单边重量，验证替换的影响范围及完成历史。 */
function exercises(): WorkoutPayload['exercises'] {
  return [
    {
      id: randomUUID(),
      exercise_id: '0025',
      rest_seconds: 75,
      warmup_rest_seconds: 30,
      sets: [
        {
          id: randomUUID(),
          kind: 'warmup',
          reps: 8,
          weight: '20',
          weight_left: null,
          weight_right: null,
          completed: true,
          rest_durations_seconds: [29],
        },
        {
          id: randomUUID(),
          kind: 'working',
          reps: 6,
          weight: '24.75',
          weight_left: null,
          weight_right: null,
          completed: false,
          rest_durations_seconds: [],
        },
      ],
    },
    {
      id: randomUUID(),
      exercise_id: '0047',
      rest_seconds: 90,
      warmup_rest_seconds: null,
      sets: [
        {
          id: randomUUID(),
          kind: 'working',
          reps: 10,
          weight: null,
          weight_left: '17.5',
          weight_right: '18',
          completed: true,
          rest_durations_seconds: [45],
        },
      ],
    },
  ];
}

test('动作重量口径统一写入偏好及所有同动作实例，新增组保持单边输入', async ({ page, account }) => {
  const peer = await peerClient(account);
  const space = await createSpace(peer);
  const now = new Date().toISOString();
  const workoutId = randomUUID();
  const source = exercises()[0]!;
  const payload: WorkoutPayload = {
    ...newWorkout('动作重量口径验收', now.slice(0, 10), undefined, now),
    exercises: [source, source].map((item) => ({
      ...item,
      id: randomUUID(),
      sets: item.sets.map((set) => ({ ...set, id: randomUUID(), completed: false, rest_durations_seconds: [] })),
    })),
  };
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'fitness_workout',
    entity_id: workoutId,
    fitness_space_id: space.id,
    sync_id: space.sync_id,
    ledger_id: null,
    day_book_id: null,
    memo_book_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload,
  });
  await login(page, account);
  await page.goto(`/fitness?space=${space.id}&detail=${workoutId}`);
  await page
    .getByRole('dialog', { name: payload.name, exact: true })
    .getByRole('button', { name: '编辑记录', exact: true })
    .click();
  const editor = page.getByRole('dialog', { name: '编辑训练记录', exact: true });
  await editor.getByRole('button', { name: '动作 1 重量口径', exact: true }).click();
  await expect(editor.getByLabel('动作 2 第 2 组右侧重量', { exact: true })).toHaveValue('24.75');
  await expect(editor.getByLabel('动作 1 第 1 组左侧重量', { exact: true })).toHaveValue('20');
  await editor.getByRole('button', { name: '添加一组', exact: true }).first().click();
  await expect(editor.getByLabel('动作 1 第 3 组左侧重量', { exact: true })).toHaveValue('');
  await editor.getByRole('button', { name: '保存训练', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const preferences = unwrap(
    await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/preferences', {
      params: { path: { fitness_space_id: space.id }, query: { limit: 1 } },
    }),
  ).items[0]!;
  expect(preferences.exercise_weight_modes['0025']).toBe(true);
  const saved = unwrap(
    await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/workouts', {
      params: { path: { fitness_space_id: space.id } },
    }),
  ).items.find((item) => item.id === workoutId)!;
  for (const exercise of saved.exercises) {
    expect(exercise.sets[0]).toMatchObject({ weight: null, weight_left: '20', weight_right: '20' });
    expect(exercise.sets[1]).toMatchObject({ weight: null, weight_left: '24.75', weight_right: '24.75' });
  }
  expect(saved.exercises[0]!.sets[2]).toMatchObject({ weight: null, weight_left: null, weight_right: null });
});

test('替换训练动作：取消保留成绩，确认只清空目标动作成绩并保留全部身份', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  const space = await createSpace(peer);
  const now = new Date().toISOString();
  const started = new Date(Date.now() - 120_000).toISOString();
  const workoutId = randomUUID();
  const payload: WorkoutPayload = {
    ...newWorkout('动作替换成绩边界', now.slice(0, 10), undefined, started),
    status: 'in_progress',
    run_segments: [{ started_at: started, ended_at: now }],
    exercises: exercises(),
    updated_at: now,
  };
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'fitness_workout',
    entity_id: workoutId,
    fitness_space_id: space.id,
    sync_id: space.sync_id,
    ledger_id: null,
    day_book_id: null,
    memo_book_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload,
  });
  const read = async () =>
    unwrap(
      await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/workouts', {
        params: { path: { fitness_space_id: space.id } },
      }),
    ).items.find((item) => item.id === workoutId)!;
  const before = await read();
  await login(page, account);
  await page.goto(`/fitness?space=${space.id}&detail=${workoutId}`);
  await page
    .getByRole('dialog', { name: payload.name, exact: true })
    .getByRole('button', { name: '编辑记录', exact: true })
    .click();
  const editor = page.getByRole('dialog', { name: '编辑训练记录', exact: true });
  await editor.getByRole('button', { name: '替换动作 杠铃卧推', exact: true }).click();
  let replacement = page.getByRole('dialog', { name: '替换动作', exact: true });
  await replacement.getByLabel('替换为', { exact: true }).selectOption('0289');
  await expect(replacement).toContainText('此动作已有完成组。');
  await replacement.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(editor.getByLabel('动作 1 第 1 组重量', { exact: true })).toHaveValue('20');
  await expect(editor.getByRole('checkbox', { name: '已完成', exact: true }).first()).toBeChecked();
  expect(await read()).toEqual(before);

  await editor.getByRole('button', { name: '替换动作 杠铃卧推', exact: true }).click();
  replacement = page.getByRole('dialog', { name: '替换动作', exact: true });
  await replacement.getByLabel('替换为', { exact: true }).selectOption('0289');
  await replacement.getByRole('button', { name: '确认替换', exact: true }).click();
  await expect(editor.getByRole('button', { name: '替换动作 哑铃卧推', exact: true })).toBeVisible();
  await expect(editor.getByLabel('动作 1 第 1 组左侧重量', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('动作 1 第 1 组右侧重量', { exact: true })).toHaveValue('');
  await expect(editor.getByRole('checkbox', { name: '已完成', exact: true }).first()).not.toBeChecked();
  await editor.getByRole('button', { name: '保存训练', exact: true }).scrollIntoViewIfNeeded();

  await testInfo.attach('workout-replacement', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await editor.getByRole('button', { name: '保存训练', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const after = await read();
  expect(after.revision).toBe(before.revision + 1);
  expect(after.exercises[0]).toEqual({
    ...before.exercises[0],
    exercise_id: '0289',
    sets: before.exercises[0]!.sets.map((set) => ({
      ...set,
      reps: null,
      weight: null,
      weight_left: null,
      weight_right: null,
      completed: false,
      rest_durations_seconds: [],
    })),
  });
  expect(after.exercises[1]).toEqual(before.exercises[1]);
  expect(after.run_segments).toEqual(before.run_segments);
  expect(after.status).toBe(before.status);
});

test('个人模板复制与替换：丢回执重试只有一份副本，副本使用新身份且编辑不影响原模板', async ({
  page,
  account,
  diagnostics,
}, testInfo) => {
  const peer = await peerClient(account);
  const space = await createSpace(peer);
  const now = new Date().toISOString();
  const sourceId = randomUUID();
  const payload: TemplatePayload = {
    name: '需要独立复制的个人模板',
    created_at: now,
    updated_at: now,
    exercises: exercises().map((exercise) => ({
      id: exercise.id,
      exercise_id: exercise.exercise_id,
      rest_seconds: exercise.rest_seconds,
      warmup_rest_seconds: exercise.warmup_rest_seconds,
      sets: exercise.sets.map((set) => ({
        id: set.id,
        kind: set.kind,
        reps: set.reps,
        weight: set.weight,
        weight_left: set.weight_left,
        weight_right: set.weight_right,
      })),
    })),
  };
  await peer.push({
    mutation_id: randomUUID(),
    entity_type: 'fitness_template',
    entity_id: sourceId,
    fitness_space_id: space.id,
    sync_id: space.sync_id,
    ledger_id: null,
    day_book_id: null,
    memo_book_id: null,
    base_revision: 0,
    action: 'upsert',
    updated_at: now,
    payload,
  });
  const read = async () =>
    unwrap(
      await peer.client.GET('/api/v1/fitness-spaces/{fitness_space_id}/templates', {
        params: { path: { fitness_space_id: space.id } },
      }),
    ).items;
  const original = (await read())[0]!;
  await login(page, account);
  await page.goto(`/fitness?space=${space.id}&tab=templates&detail=${sourceId}`);
  const detail = page.getByRole('dialog', { name: payload.name, exact: true });
  const copies: string[] = [];
  diagnostics.connectionFailureExpected = true;
  await page.route('**/api/v1/sync/push', async (route) => {
    copies.push(route.request().postData()!);
    if (copies.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      const result: paths['/api/v1/sync/push']['post']['responses'][200]['content']['application/json'] =
        await committed.json();
      expect(result.outcomes[0]?.status).toBe('accepted');
      await route.abort('connectionrefused');
    } else await route.continue();
  });
  await detail.getByRole('button', { name: '复制模板', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await read()).toHaveLength(2);
  await detail.getByRole('button', { name: '复制模板', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '已复制模板' })).toBeVisible();
  expect(copies).toHaveLength(2);
  expect(copies[1]).toBe(copies[0]);
  await page.unroute('**/api/v1/sync/push');
  diagnostics.connectionFailureExpected = false;
  const templates = await read();
  expect(templates).toHaveLength(2);
  expect(templates.find((item) => item.id === sourceId)).toEqual(original);
  const copied = templates.find((item) => item.id !== sourceId)!;
  expect(copied.name).toBe(`${original.name} · 副本`);
  for (const [index, exercise] of copied.exercises.entries()) {
    const source = original.exercises[index]!;
    expect(exercise.id).not.toBe(source.id);
    expect(exercise.exercise_id).toBe(source.exercise_id);
    for (const [setIndex, set] of exercise.sets.entries()) {
      expect(set.id).not.toBe(source.sets[setIndex]!.id);
      expect({ ...set, id: source.sets[setIndex]!.id }).toEqual(source.sets[setIndex]);
    }
  }
  await page.goto(`/fitness?space=${space.id}&tab=templates&detail=${copied.id}`);
  await page
    .getByRole('dialog', { name: copied.name, exact: true })
    .getByRole('button', { name: '编辑模板', exact: true })
    .click();
  const editor = page.getByRole('dialog', { name: '编辑个人模板', exact: true });
  await editor.getByRole('button', { name: '替换动作 杠铃卧推', exact: true }).click();
  const replacement = page.getByRole('dialog', { name: '替换动作', exact: true });
  await replacement.getByLabel('替换为', { exact: true }).selectOption('0289');
  await replacement.getByRole('button', { name: '确认替换', exact: true }).click();
  await editor.getByRole('button', { name: '保存模板', exact: true }).scrollIntoViewIfNeeded();

  await testInfo.attach('template-replacement', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await editor.getByRole('button', { name: '保存模板', exact: true }).click();
  await expect(editor).toHaveCount(0);
  const after = await read();
  expect(after.find((item) => item.id === sourceId)).toEqual(original);
  const edited = after.find((item) => item.id === copied.id)!;
  expect(edited.exercises[0]).toEqual({
    ...copied.exercises[0],
    exercise_id: '0289',
    sets: copied.exercises[0]!.sets.map((set) => ({
      ...set,
      reps: null,
      weight: null,
      weight_left: null,
      weight_right: null,
    })),
  });
  expect(edited.exercises[1]).toEqual(copied.exercises[1]);
});
