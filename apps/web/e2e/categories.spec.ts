import { randomUUID } from 'node:crypto';
import { unwrap, type components } from '@sesame-notes/api-client';
import { test, expect, login, peerClient, type Mutation } from './fixtures';

test('完整分类模板、同级排序、图标与重命名在桌面和触屏均可操作', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  const ledger = unwrap(await peer.client.POST('/api/v1/ledgers', { body: { name: '模板验收', currency: 'CNY' } }));
  const initialCategories = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(initialCategories).toHaveLength(61);
  expect(initialCategories.find((row) => row.name === '餐饮' && row.level === 1)).toMatchObject({
    id: 'ffec6471-df8b-5bb3-8a05-93ef863ca958',
    parent_id: null,
  });
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await page.getByRole('button', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: '分类模板', exact: true }).click();
  await page.getByRole('button', { name: '分层分类', exact: true }).click();
  await page.getByRole('button', { name: '全选可添加项', exact: true }).click();
  // 完整分层模板130项与默认目录重合56项，应只添加剩余74项。
  await expect(page.getByText('已选 74 项', { exact: true })).toBeVisible();

  await testInfo.attach('category-template-selection', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: /^添加所选/ }).click();
  await expect(page.getByRole('dialog', { name: '添加分类模板', exact: true })).toHaveCount(0);
  const categories = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(categories).toHaveLength(135);
  for (const original of initialCategories) expect(categories.find((row) => row.id === original.id)).toEqual(original);
  const roots = categories.filter((row) => row.level === 1).sort((a, b) => a.sort_order - b.sort_order);
  expect(roots.length).toBeGreaterThan(1);
  await page.getByRole('button', { name: '分类模板', exact: true }).click();
  await page.getByRole('button', { name: '分层分类', exact: true }).click();
  await page.getByRole('button', { name: '全选可添加项', exact: true }).click();
  await expect(page.getByText('已选 0 项', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^添加所选/ })).toBeDisabled();
  await page
    .getByRole('dialog', { name: '添加分类模板', exact: true })
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
  await page.getByRole('button', { name: '调整顺序', exact: true }).click();
  const reorder = page.getByRole('dialog', { name: '调整分类顺序', exact: true });
  await reorder.getByRole('button', { name: `下移${roots[0]!.name}`, exact: true }).click();
  await expect(reorder.getByRole('button', { name: `上移${roots[1]!.name}`, exact: true })).toBeDisabled();
  await reorder.getByRole('button', { name: '保存顺序', exact: true }).click();
  await expect(reorder).toHaveCount(0);
  const sorted = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(sorted.find((row) => row.id === roots[1]!.id)?.sort_order).toBe(0);
  await page.getByRole('button', { name: `编辑分类${roots[0]!.name}`, exact: true }).click();
  await page.getByLabel('分类名称', { exact: true }).fill('跨端自定义名称');
  await page.getByRole('button', { name: '选择图标 wallet', exact: true }).click();

  await testInfo.attach('category-icon-editor', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: '保存分类', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑分类跨端自定义名称', exact: true })).toBeVisible();
  const edited = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(edited.find((row) => row.id === roots[0]!.id)).toMatchObject({ name: '跨端自定义名称', icon: 'wallet' });
});

test('分类迁移先核对关联范围，正确确认后跨账本保留交易并同步', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  const ledger = unwrap(await peer.client.POST('/api/v1/ledgers', { body: { name: '分类迁移验收', currency: 'CNY' } }));
  const second = unwrap(
    await peer.client.POST('/api/v1/ledgers', { body: { name: '另一本保留交易', currency: 'CNY' } }),
  );
  const rootId = randomUUID();
  const childId = randomUUID();
  const targetId = randomUUID();
  for (const [id, name, parent] of [
    [rootId, '迁移父类', null],
    [childId, '迁移子类', rootId],
    [targetId, '保留目标', null],
  ] as const) {
    unwrap(
      await peer.client.POST('/api/v1/ledgers/{ledger_id}/categories', {
        params: { path: { ledger_id: ledger.id } },
        body: { id, name, level: parent ? 2 : 1, parent_id: parent, kind: 'expense', sort_order: 0 },
      }),
    );
  }
  const transaction = unwrap(
    await peer.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: second.id } },
      body: {
        tx_type: 'expense',
        category_id: childId,
        amount: '18.25',
        native_amount: '18.25',
        currency_code: 'CNY',
        happened_at: new Date().toISOString(),
        note: '跨本分类保留',
      },
    }),
  );
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await page.getByRole('button', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: '删除分类迁移父类', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '处理所选分类', exact: true });
  await expect(dialog.getByText(/包含 2 个分类、1 笔关联交易/)).toBeVisible();
  await page.getByLabel('处理方式', { exact: true }).selectOption('migrate');
  await page.getByLabel('迁移到分类', { exact: true }).selectOption(targetId);
  await page.getByLabel('输入完整分类名称确认', { exact: true }).fill('错误名称');
  await expect(dialog.getByRole('button', { name: '确认迁移并移除', exact: true })).toBeDisabled();
  await page.getByLabel('输入完整分类名称确认', { exact: true }).fill('迁移父类');

  await testInfo.attach('category-migration-confirmation', {
    body: await page.screenshot({ fullPage: (await page.getByRole('dialog').count()) === 0 }),
    contentType: 'image/png',
  });
  await dialog.getByRole('button', { name: '确认迁移并移除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除分类迁移父类', exact: true })).toHaveCount(0);
  const records = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', { params: { path: { ledger_id: second.id } } }),
  );
  expect(records.items.find((row) => row.id === transaction.id)).toMatchObject({
    category_id: targetId,
    amount: '18.25',
    note: '跨本分类保留',
  });
  const pull = unwrap(await peer.client.GET('/api/v1/sync/pull', { params: { query: { since: '0', limit: 500 } } }));
  expect(pull.changes.some((change) => change.entity_id === rootId && change.action === 'delete')).toBe(true);
  expect(pull.changes.some((change) => change.entity_id === transaction.id && change.action === 'upsert')).toBe(true);
});

test('迁移目标在确认后被另一设备修改时拒绝旧确认，重新核对后才能迁移', async ({
  page,
  account,
  diagnostics,
}, testInfo) => {
  const peer = await peerClient(account);
  const ledger = unwrap(
    await peer.client.POST('/api/v1/ledgers', { body: { name: '目标版本冲突验收', currency: 'CNY' } }),
  );
  const make = async (name: string) =>
    unwrap(
      await peer.client.POST('/api/v1/ledgers/{ledger_id}/categories', {
        params: { path: { ledger_id: ledger.id } },
        body: { name, level: 1, kind: 'expense' },
      }),
    );
  const source = await make('待迁移源分类');
  const target = await make('核对时的目标');
  const parent = await make('新的上级');
  const transaction = unwrap(
    await peer.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
      body: {
        tx_type: 'expense',
        category_id: source.id,
        amount: '6.75',
        native_amount: '6.75',
        currency_code: 'CNY',
        happened_at: new Date().toISOString(),
        note: '冲突前后都必须保留的支出',
      },
    }),
  );
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await page.getByRole('button', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: `删除分类${source.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '处理所选分类', exact: true });
  await dialog.getByLabel('处理方式', { exact: true }).selectOption('migrate');
  await dialog.getByLabel('迁移到分类', { exact: true }).selectOption(target.id);
  await dialog.getByLabel('输入完整分类名称确认', { exact: true }).fill(source.name);
  const submit = dialog.getByRole('button', { name: '确认迁移并移除', exact: true });
  await expect(submit).toBeEnabled();
  let raced = false;
  await page.route('**/api/v1/ledgers/*/categories/remove', async (route) => {
    if (route.request().method() === 'POST' && !raced) {
      raced = true;
      // 浏览器请求已经固化了旧目标版本；真实第二设备同时改名并换父级。
      unwrap(
        await peer.client.PATCH('/api/v1/ledgers/{ledger_id}/categories/{category_id}', {
          params: { path: { ledger_id: ledger.id, category_id: target.id } },
          body: { name: '修改后的目标', level: 2, parent_id: parent.id },
        }),
      );
    }
    await route.continue();
  });
  diagnostics.conflictExpected = true;
  const conflict = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/categories/remove'),
  );
  await submit.click();
  const rejected = await conflict;
  expect(rejected.status()).toBe(409);
  expect(await rejected.text()).toContain('CATEGORY_TARGET_CHANGED');
  await expect(dialog.getByRole('alert')).toBeVisible();
  const unchanged = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
    }),
  ).items.find((item) => item.id === transaction.id)!;
  expect(unchanged).toMatchObject({ category_id: source.id, amount: '6.75' });
  await dialog.getByRole('button', { name: '重新核对最新范围', exact: true }).click();
  await expect(
    dialog.getByLabel('迁移到分类', { exact: true }).getByRole('option', { name: /修改后的目标/ }),
  ).toHaveCount(1);
  await expect(dialog.getByLabel('输入完整分类名称确认', { exact: true })).toHaveValue('');
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('迁移到分类', { exact: true }).selectOption(target.id);
  await dialog.getByLabel('输入完整分类名称确认', { exact: true }).fill(source.name);
  await expect(submit).toBeEnabled();

  await testInfo.attach('category-target-rechecked', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await submit.click();
  await expect(dialog).toHaveCount(0);
  const after = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
    }),
  ).items.find((item) => item.id === transaction.id)!;
  expect(after).toMatchObject({ category_id: target.id, amount: '6.75', note: transaction.note });
  const categories = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(categories.some((item) => item.id === source.id)).toBe(false);
  expect(categories.find((item) => item.id === target.id)).toMatchObject({
    name: '修改后的目标',
    parent_id: parent.id,
  });
});

/** 旧设备已冻结的无基线请求，重放保留同一个 mutation 和分类身份。 */
function oldCategoryChange(category: components['schemas']['Category'], name: string): Mutation {
  return {
    mutation_id: randomUUID(),
    entity_type: 'category',
    entity_id: category.id,
    ledger_id: null,
    action: 'upsert',
    updated_at: '1970-01-01T00:00:00.000Z',
    payload: {
      name,
      kind: category.kind,
      level: category.level,
      parent_id: category.parent_id,
      icon: category.icon,
      sort_order: category.sort_order,
    },
  };
}

test('旧默认分类形成独立候选，保留云端或采用本地始终只有同一分类且交易引用不变', async ({
  page,
  account,
}, testInfo) => {
  const peer = await peerClient(account);
  const ledger = unwrap(
    await peer.client.POST('/api/v1/ledgers', { body: { name: '同身份分类确认', currency: 'CNY' } }),
  );
  const readCategories = async () =>
    unwrap(
      await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', {
        params: { path: { ledger_id: ledger.id } },
      }),
    );
  const initial = await readCategories();
  const dining = initial.find((row) => row.id === 'ffec6471-df8b-5bb3-8a05-93ef863ca958')!;
  expect(dining).toBeDefined();
  const cloud = unwrap(
    await peer.client.PATCH('/api/v1/ledgers/{ledger_id}/categories/{category_id}', {
      params: {
        path: { ledger_id: ledger.id, category_id: dining.id },
        query: { expected_version_token: dining.version_token },
        header: { 'idempotency-key': randomUUID() },
      },
      body: { name: '云端已编辑餐饮' },
    }),
  );
  const tx = unwrap(
    await peer.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
      body: {
        tx_type: 'expense',
        category_id: cloud.id,
        amount: '16.25',
        native_amount: '16.25',
        currency_code: 'CNY',
        happened_at: new Date().toISOString(),
      },
    }),
  );
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await page.getByRole('button', { name: '分类', exact: true }).click();
  let expectedCategory = cloud;
  for (const choice of ['cloud', 'local'] as const) {
    const name = choice === 'cloud' ? '旧设备餐饮候选' : '明确采用的餐饮';
    const frozen = oldCategoryChange(dining, name);
    const outcome = await peer.push(frozen, 'conflict');
    expect(outcome.category_conflict).toMatchObject({
      category_id: dining.id,
      status: 'pending',
      cloud_snapshot: expectedCategory,
    });
    const repeated = await peer.push(frozen, 'conflict');
    expect(repeated.category_conflict?.id).toBe(outcome.category_conflict?.id);
    const unchanged = await readCategories();
    expect(unchanged).toHaveLength(initial.length);
    expect(unchanged.filter((row) => row.id === dining.id)).toEqual([expectedCategory]);
    expect(unchanged.some((row) => row.name === name)).toBe(false);
    await page.getByRole('button', { name: '待确认分类', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '待确认分类', exact: true });
    await dialog.getByRole('button', { name: `${name} 待修改`, exact: true }).click();
    await expect(dialog.getByRole('button', { name: '确认选择', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('region', { name: '云端当前内容' })).toContainText(expectedCategory.name);
    await expect(dialog.getByRole('region', { name: '本地待确认内容' })).toContainText(name);
    await dialog.getByRole('radio', { name: choice === 'cloud' ? '保留云端' : '采用本地修改', exact: true }).check();

    await testInfo.attach(`category-conflict-${choice}`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
    await dialog.getByRole('button', { name: '确认选择', exact: true }).click();
    await expect(dialog.getByText('没有待确认分类', { exact: true })).toBeVisible();
    const after = await readCategories();
    expect(after).toHaveLength(initial.length);
    const sameId = after.filter((row) => row.id === dining.id);
    expect(sameId).toHaveLength(1);
    expect(sameId[0]?.name).toBe(choice === 'cloud' ? expectedCategory.name : name);
    if (choice === 'cloud') expect(sameId[0]).toEqual(expectedCategory);
    expectedCategory = sameId[0]!;
    const accepted = await peer.push(frozen);
    expect(accepted.status).toBe('accepted');
    expect(accepted.category_resolution).toMatchObject({
      conflict_id: outcome.category_conflict?.id,
      resolution: choice,
      category_state: expectedCategory,
    });
    const records = unwrap(
      await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', { params: { path: { ledger_id: ledger.id } } }),
    );
    expect(records.items.find((row) => row.id === tx.id)).toMatchObject({ category_id: dining.id, amount: '16.25' });
    await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  }
});

test('云端已删除的默认分类必须显式恢复同一ID，迁移的交易分类保持原值', async ({ page, account }, testInfo) => {
  const peer = await peerClient(account);
  const ledger = unwrap(await peer.client.POST('/api/v1/ledgers', { body: { name: '分类墓碑恢复', currency: 'CNY' } }));
  const initial = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  const breakfast = initial.find((row) => row.id === '02d2cbc5-0298-5dea-ae85-f4616e0eafc2')!;
  const target = initial.find((row) => row.level === 1 && row.id !== breakfast.id)!;
  expect(breakfast).toBeDefined();
  const tx = unwrap(
    await peer.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
      body: {
        tx_type: 'expense',
        category_id: breakfast.id,
        amount: '8.5',
        native_amount: '8.5',
        currency_code: 'CNY',
        happened_at: new Date().toISOString(),
      },
    }),
  );
  const preview = unwrap(
    await peer.client.POST('/api/v1/ledgers/{ledger_id}/categories/removal-preview', {
      params: { path: { ledger_id: ledger.id } },
      body: { category_ids: [breakfast.id] },
    }),
  );
  await peer.client
    .POST('/api/v1/ledgers/{ledger_id}/categories/remove', {
      params: {
        path: { ledger_id: ledger.id },
        header: { 'idempotency-key': randomUUID() },
      },
      body: {
        category_ids: [breakfast.id],
        mode: 'migrate',
        target_category_id: target.id,
        expected_target_updated_at: target.updated_at,
        preview_token: preview.preview_token,
      },
    })
    .then((result) => expect(result.response.status).toBe(200));
  const frozen = oldCategoryChange(breakfast, '明确恢复的早餐');
  const outcome = await peer.push(frozen, 'conflict');
  expect(outcome.category_conflict?.cloud_snapshot.deleted_at).not.toBeNull();
  const deleted = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(deleted).toHaveLength(initial.length - 1);
  expect(deleted.some((row) => row.id === breakfast.id)).toBe(false);
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await page.getByRole('button', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: '待确认分类', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '待确认分类', exact: true });
  await dialog.getByRole('button', { name: '明确恢复的早餐 待修改', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '云端当前内容' }).getByText('已删除', { exact: true })).toBeVisible();
  await dialog.getByRole('radio', { name: '采用本地修改', exact: true }).check();
  await expect(dialog.getByRole('button', { name: '确认选择', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '恢复此分类', exact: true }).check();

  await testInfo.attach('category-restore-confirmation', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await dialog.getByRole('button', { name: '确认选择', exact: true }).click();
  await expect(dialog.getByText('没有待确认分类', { exact: true })).toBeVisible();
  const restored = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(restored).toHaveLength(initial.length);
  expect(restored.filter((row) => row.id === breakfast.id)).toHaveLength(1);
  expect(restored.find((row) => row.id === breakfast.id)).toMatchObject({ name: '明确恢复的早餐', deleted_at: null });
  const records = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(records.items.find((row) => row.id === tx.id)).toMatchObject({ category_id: target.id, amount: '8.5' });
  expect((await peer.push(frozen)).category_resolution).toMatchObject({
    resolution: 'local',
    category_state: { id: breakfast.id, deleted_at: null },
  });
});

test('确认分类时云端再次修改返回409，重新读取清除旧选择且保留同一候选', async ({
  page,
  account,
  diagnostics,
}, testInfo) => {
  const peer = await peerClient(account);
  const ledger = unwrap(await peer.client.POST('/api/v1/ledgers', { body: { name: '分类确认CAS', currency: 'CNY' } }));
  const initial = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  const dining = initial.find((row) => row.id === 'ffec6471-df8b-5bb3-8a05-93ef863ca958')!;
  const frozen = oldCategoryChange(dining, '并发前本地餐饮');
  const pending = (await peer.push(frozen, 'conflict')).category_conflict!;
  expect(pending).toBeDefined();
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await page.getByRole('button', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: '待确认分类', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '待确认分类', exact: true });
  await dialog.getByRole('button', { name: '并发前本地餐饮 待修改', exact: true }).click();
  await dialog.getByRole('radio', { name: '采用本地修改', exact: true }).check();
  let concurrent: components['schemas']['Category'] | undefined;
  const resolvePath = `/api/v1/category-conflicts/${pending.id}/resolve`;
  await page.route(`**${resolvePath}`, async (route) => {
    if (route.request().method() === 'POST' && !concurrent) {
      concurrent = unwrap(
        await peer.client.PATCH('/api/v1/ledgers/{ledger_id}/categories/{category_id}', {
          params: {
            path: { ledger_id: ledger.id, category_id: dining.id },
            query: { expected_version_token: dining.version_token },
            header: { 'idempotency-key': randomUUID() },
          },
          body: { name: '确认途中云端新名称', icon: 'wallet' },
        }),
      );
    }
    await route.continue();
  });
  diagnostics.conflictExpected = true;
  const failed = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === resolvePath,
  );
  await dialog.getByRole('button', { name: '确认选择', exact: true }).click();
  const rejected = await failed;
  expect(rejected.status()).toBe(409);
  expect(await rejected.text()).toContain('CATEGORY_VERSION_CHANGED');
  await expect(dialog.getByRole('button', { name: '确认选择', exact: true })).toBeDisabled();
  const list = unwrap(
    await peer.client.GET('/api/v1/category-conflicts', { params: { query: { status: 'pending' } } }),
  );
  expect(list.items.find((row) => row.id === pending.id)).toMatchObject({
    status: 'pending',
    cloud_snapshot: concurrent,
  });
  await dialog.getByRole('button', { name: '重新读取分类', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '云端当前内容' })).toContainText('确认途中云端新名称');
  await expect(dialog.getByRole('radio', { name: '采用本地修改', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: '确认选择', exact: true })).toBeDisabled();

  await testInfo.attach('category-conflict-rechecked', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await dialog.getByRole('radio', { name: '采用本地修改', exact: true }).check();
  await dialog.getByRole('button', { name: '确认选择', exact: true }).click();
  await expect(dialog.getByText('没有待确认分类', { exact: true })).toBeVisible();
  const after = unwrap(
    await peer.client.GET('/api/v1/ledgers/{ledger_id}/categories', { params: { path: { ledger_id: ledger.id } } }),
  );
  expect(after).toHaveLength(initial.length);
  expect(after.filter((row) => row.id === dining.id)).toHaveLength(1);
  expect(after.find((row) => row.id === dining.id)?.name).toBe('并发前本地餐饮');
});
