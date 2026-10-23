import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient, newAccount } from './fixtures';

test('两个隔离账号邀请共享、权限边界与完整 AA 结算', async ({ page, account }, testInfo) => {
  const owner = await peerClient(account);
  unwrap(await owner.client.PATCH('/api/v1/profile/me', { body: { display_name: 'AA 所有者' } }));
  const friendAccount = newAccount();
  const friend = await peerClient(friendAccount, true);
  unwrap(await friend.client.PATCH('/api/v1/profile/me', { body: { display_name: 'AA 伙伴' } }));
  const ledger = unwrap(
    await owner.client.POST('/api/v1/ledgers', { body: { name: '双账号 AA 验收', currency: 'CNY', aa_enabled: true } }),
  );
  await login(page, account);
  await page.goto(`/accounting?ledger=${ledger.id}`);
  await page.getByRole('button', { name: '账本管理', exact: true }).click();
  await page.getByRole('button', { name: '共享与成员', exact: true }).click();
  await page.getByRole('button', { name: '生成邀请码', exact: true }).click();
  const code = page.getByLabel('邀请码', { exact: true });
  await expect(code).not.toHaveValue('');
  const invitation = await code.inputValue();
  await page.getByRole('dialog', { name: '共享与成员' }).getByRole('button', { name: '关闭弹窗' }).click();
  await page.goto('/settings');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  await login(page, friendAccount);
  await page.goto(`/accounting?invite=${encodeURIComponent(invitation)}`);
  await page.getByRole('button', { name: '预览邀请', exact: true }).click();
  await expect(page.getByRole('heading', { name: ledger.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认加入账本', exact: true }).click();
  await expect(
    page.getByRole('group', { name: '当前账本', exact: true }).getByRole('button', { name: ledger.name, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '账本管理', exact: true }).click();
  await expect(page.getByRole('button', { name: '共享与成员', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '汇率设置', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '当前账本设置', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '分类', exact: true }).click();
  await expect(page.getByText('共享账本的分类由账本所有者维护。')).toBeVisible();
  await expect(page.getByRole('button', { name: '添加分类', exact: true })).toHaveCount(0);
  await page.getByRole('dialog', { name: '支出分类', exact: true }).getByRole('button', { name: '关闭弹窗' }).click();
  const now = new Date().toISOString();
  unwrap(
    await owner.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
      body: {
        tx_type: 'expense',
        amount: '80',
        native_amount: '80',
        currency_code: 'CNY',
        happened_at: now,
        note: '所有者实付',
        aa_mode: '0',
      },
    }),
  );
  unwrap(
    await friend.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
      body: {
        tx_type: 'expense',
        amount: '30',
        native_amount: '30',
        currency_code: 'CNY',
        happened_at: now,
        note: '伙伴实付',
        aa_mode: '0',
      },
    }),
  );
  unwrap(
    await friend.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
      params: { path: { ledger_id: ledger.id } },
      body: {
        tx_type: 'expense',
        amount: '9',
        native_amount: '9',
        currency_code: 'CNY',
        happened_at: now,
        note: '个人不分摊',
        aa_mode: '1',
      },
    }),
  );
  const statistics = page.getByRole('group', { name: '全部时间的成员与分摊统计', exact: true });
  await expect(statistics).toContainText('全部时间');
  await statistics.getByRole('button', { name: 'AA 统计', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AA 分摊与结算', exact: true });
  await expect(dialog.getByRole('row', { name: /AA 所有者/ })).toContainText('80.00');
  await expect(dialog.getByRole('row', { name: /AA 所有者/ })).toContainText('55.00');
  await expect(dialog.getByRole('row', { name: /AA 所有者/ })).toContainText('应收 25.00');
  await expect(dialog.getByRole('row', { name: /AA 伙伴/ })).toContainText('应付 25.00');
  await expect(dialog.getByRole('row', { name: /AA 伙伴/ })).toContainText('39.00');
  await expect(dialog.getByText(/AA 伙伴 → AA 所有者/)).toContainText('25.00 CNY');

  await testInfo.attach('aa-sharing-settlement', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await dialog.getByRole('button', { name: 'AA 伙伴（我）', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'AA 伙伴的付款明细', exact: true });
  await expect(detail.getByText(/伙伴实付/)).toBeVisible();
  await expect(detail.getByText(/个人不分摊/)).toBeVisible();
  await expect(detail.getByText(/所有者实付/)).toHaveCount(0);
  await detail.getByRole('button', { name: '关闭弹窗' }).click();
  await dialog.getByRole('button', { name: '查看不参与 AA 的 1 笔记录', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '不参与 AA 的支出', exact: true }).getByText(/个人不分摊/),
  ).toBeVisible();
});

test('未开启AA仍按付款人汇总全部支出，保留已退出成员记录', async ({ page, account }, testInfo) => {
  try {
    const owner = await peerClient(account);
    unwrap(await owner.client.PATCH('/api/v1/profile/me', { body: { display_name: '成员所有者' } }));
    const friend = await peerClient(newAccount(), true);
    unwrap(await friend.client.PATCH('/api/v1/profile/me', { body: { display_name: '历史付款伙伴' } }));
    const ledger = unwrap(
      await owner.client.POST('/api/v1/ledgers', {
        body: { name: '非AA成员支出验收', currency: 'CNY', aa_enabled: false },
      }),
    );
    const invite = unwrap(
      await owner.client.POST('/api/v1/ledgers/{ledger_id}/invites', {
        params: { path: { ledger_id: ledger.id } },
        body: {},
      }),
    );
    unwrap(await friend.client.POST('/api/v1/invites/{code}/accept', { params: { path: { code: invite.code } } }));
    const participants = unwrap(
      await owner.client.GET('/api/v1/ledgers/{ledger_id}/participants', {
        params: { path: { ledger_id: ledger.id } },
      }),
    );
    const payer = participants.find((member) => member.display_name === '历史付款伙伴');
    const self = participants.find((member) => member.display_name === '成员所有者');
    expect(payer).toBeDefined();
    expect(self).toBeDefined();
    unwrap(
      await owner.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
        params: { path: { ledger_id: ledger.id } },
        body: {
          tx_type: 'expense',
          amount: '10.1234567891',
          native_amount: '10.1234567891',
          currency_code: 'CNY',
          happened_at: new Date().toISOString(),
          note: '所有者记录伙伴付款',
          payer_member_id: payer!.id,
          aa_mode: '1',
        },
      }),
    );
    unwrap(
      await friend.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
        params: { path: { ledger_id: ledger.id } },
        body: {
          tx_type: 'expense',
          amount: '0.2',
          native_amount: '0.2',
          currency_code: 'CNY',
          happened_at: new Date().toISOString(),
          note: '伙伴记录所有者付款',
          payer_member_id: self!.id,
          aa_mode: '1',
        },
      }),
    );
    unwrap(
      await owner.client.DELETE('/api/v1/ledgers/{ledger_id}/members/{member_id}', {
        params: { path: { ledger_id: ledger.id, member_id: payer!.id } },
      }),
    );
    await login(page, account);
    await page.goto(`/accounting?ledger=${ledger.id}`);
    const statistics = page.getByRole('group', { name: '全部时间的成员与分摊统计', exact: true });
    await expect(statistics).toContainText('全部时间');
    await expect(page.getByRole('button', { name: 'AA 统计', exact: true })).toHaveCount(0);
    await statistics.getByRole('button', { name: '成员支出', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '成员支出', exact: true });
    await expect(dialog.getByText('10.3234567891 CNY', { exact: true })).toBeVisible();
    await expect(dialog.getByText('2 位付款人 · 2 笔支出', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('row', { name: /历史付款伙伴/ })).toContainText('10.1234567891 CNY');
    await expect(dialog.getByRole('row', { name: /历史付款伙伴/ })).toContainText('已退出');
    await expect(dialog.getByRole('row', { name: /成员所有者/ })).toContainText('0.20 CNY');

    await testInfo.attach('non-aa-member-expenses', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
  } catch (error) {
    console.error('成员支出历史记录兼容验收失败', { error });
    throw error;
  }
});
