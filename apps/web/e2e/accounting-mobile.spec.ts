import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('手机触控记账、固定保存栏与完整明细统计', async ({ page, account }, testInfo) => {
  try {
    const peer = await peerClient(account);
    const ledger = unwrap(
      await peer.client.POST('/api/v1/ledgers', { body: { name: '手机日常账本', currency: 'CNY' } }),
    );
    const parent = unwrap(
      await peer.client.POST('/api/v1/ledgers/{ledger_id}/categories', {
        params: { path: { ledger_id: ledger.id } },
        body: { name: '手机餐饮', kind: 'expense', level: 1, icon: 'utensils' },
      }),
    );
    const child = unwrap(
      await peer.client.POST('/api/v1/ledgers/{ledger_id}/categories', {
        params: { path: { ledger_id: ledger.id } },
        body: { name: '早餐', kind: 'expense', level: 2, parent_id: parent.id, icon: 'coffee' },
      }),
    );
    await login(page, account);
    await page.goto(`/accounting?ledger=${ledger.id}`);
    await page.getByRole('button', { name: '记一笔', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '记一笔', exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('button', { name: '取消', exact: true })).toHaveCount(0);
    await expect(editor.getByRole('button', { name: '关闭弹窗', exact: true })).toBeVisible();
    await expect(editor.getByRole('checkbox', { name: /不计支出|不计入统计/ })).toHaveCount(0);
    // 打开后先浏览分类，不主动占用屏幕唤起金额输入键盘。
    await expect(page.locator('input:focus, textarea:focus')).toHaveCount(0);
    await editor.getByRole('button', { name: '选择分类 手机餐饮', exact: true }).click();
    await expect(editor.getByRole('button', { name: '选择分类 手机餐饮', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await editor.getByRole('button', { name: '选择分类 手机餐饮 / 早餐', exact: true }).click();
    await expect(editor.getByRole('status')).toContainText('手机餐饮 / 早餐');
    await testInfo.attach('mobile-category-selection', {
      body: await page.screenshot({ path: testInfo.outputPath('mobile-category-selection.png') }),
      contentType: 'image/png',
    });
    await editor.getByLabel('货币', { exact: true }).click();
    const currencyPicker = page.getByRole('dialog', { name: '选择币种', exact: true });
    await expect(currencyPicker).toBeVisible();
    await expect(page.locator('input:focus, textarea:focus')).toHaveCount(0);
    await currencyPicker.getByRole('button', { name: '人民币（CNY）', exact: true }).click();
    await expect(currencyPicker).toHaveCount(0);
    await expect(editor.getByRole('status')).toContainText('手机餐饮 / 早餐');
    const amountInput = editor.getByLabel('记账金额', { exact: true });
    const noteInput = editor.getByLabel('备注', { exact: true });
    await amountInput.fill('18.801');
    await noteInput.fill('备'.repeat(21));
    await expect(noteInput).toHaveValue('备'.repeat(20));
    await editor.getByRole('button', { name: '完成', exact: true }).click();
    await expect(editor.getByText('请输入大于 0 的金额，最多 28 位整数、2 位小数', { exact: true })).toBeVisible();
    await amountInput.fill('18.80');
    await noteInput.fill('手机早餐记账');

    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await editor.getByLabel('备注', { exact: true }).scrollIntoViewIfNeeded();
      const geometry = await editor.evaluate((dialog) => {
        const box = dialog.getBoundingClientRect();
        const save = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.getBoundingClientRect();
        const body = dialog.querySelector<HTMLElement>('.dialog-body')!;
        const note = dialog.querySelector<HTMLInputElement>('input[name="note"]')!;
        return {
          x: box.x,
          width: box.width,
          viewport: window.innerWidth,
          height: box.height,
          visibleHeight: window.visualViewport?.height ?? window.innerHeight,
          saveBottom: save.bottom,
          saveHeight: save.height,
          saveWidth: save.width,
          noOverflow: body.scrollWidth <= body.clientWidth,
          noteFontSize: Number.parseFloat(getComputedStyle(note).fontSize),
        };
      });
      expect(Math.abs(geometry.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.width - geometry.viewport)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.height - geometry.visibleHeight)).toBeLessThanOrEqual(1);
      expect(geometry.saveBottom).toBeLessThanOrEqual(geometry.visibleHeight);
      expect(geometry.saveHeight).toBeGreaterThanOrEqual(48);
      expect(geometry.saveWidth).toBeGreaterThanOrEqual(width - 32);
      expect(geometry.noOverflow).toBe(true);
      expect(geometry.noteFontSize).toBeGreaterThanOrEqual(16);
      await testInfo.attach(`mobile-editor-${width}`, {
        body: await page.screenshot({ path: testInfo.outputPath(`mobile-editor-${width}.png`) }),
        contentType: 'image/png',
      });
    }

    await editor.getByRole('button', { name: '完成', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const records = unwrap(
      await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', { params: { path: { ledger_id: ledger.id } } }),
    ).items;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category_id: child.id,
      amount: '18.8',
      note: '手机早餐记账',
    });

    const second = unwrap(
      await peer.client.POST('/api/v1/ledgers/{ledger_id}/transactions', {
        params: { path: { ledger_id: ledger.id } },
        body: {
          tx_type: 'expense',
          amount: '12.4',
          native_amount: '12.4',
          currency_code: 'CNY',
          category_id: child.id,
          happened_at: new Date().toISOString(),
          note: '第二笔手机早餐',
        },
      }),
    );
    await page.goto(`/accounting?ledger=${ledger.id}`);
    await expect(page.getByRole('button', { name: /^查看手机早餐记账 / })).toBeVisible();
    await expect(page.getByRole('button', { name: /^查看第二笔手机早餐 / })).toBeVisible();
    const statistics = page.getByRole('region', { name: '账本统计与筛选', exact: true });
    await expect(statistics.locator('.accounting-total-amount')).toHaveText('31.20');
    await expect(statistics).toContainText('共 2 笔记录');
    await expect(page.getByText(/不计支出|不计入统计|计入支出/)).toHaveCount(0);
    await statistics.locator('summary').filter({ hasText: '筛选条件' }).click();
    await expect(statistics.getByLabel('统计标记', { exact: true })).toHaveCount(0);
    await expect(statistics.getByRole('option', { name: /不计支出|不计入统计|所有记录|计入统计/ })).toHaveCount(0);

    await page.getByRole('button', { name: /^查看第二笔手机早餐 / }).click();
    const detail = page.getByRole('dialog', { name: '手机餐饮 / 早餐', exact: true });
    await expect(detail).toBeVisible();
    await expect(detail.getByText('手机餐饮 / 早餐', { exact: true }).first()).toBeVisible();
    await expect(detail.getByLabel('记账金额', { exact: true })).toHaveCount(0);
    await expect(detail.getByText('支出统计', { exact: true })).toHaveCount(0);
    await expect(detail.getByText(/不计支出|不计入统计|计入支出/)).toHaveCount(0);
    await testInfo.attach('mobile-transaction-detail', {
      body: await page.screenshot({ path: testInfo.outputPath('mobile-transaction-detail.png') }),
      contentType: 'image/png',
    });
    await detail.getByRole('button', { name: '编辑记账', exact: true }).click();
    const editing = page.getByRole('dialog', { name: '记一笔', exact: true });
    await expect(editing.getByRole('checkbox', { name: /不计支出|不计入统计/ })).toHaveCount(0);
    const selectedCategory = editing.getByRole('button', { name: '选择分类 手机餐饮 / 早餐', exact: true });
    await expect(selectedCategory).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() =>
        selectedCategory.evaluate((button) => {
          const box = button.getBoundingClientRect();
          const rows = button.closest('.transaction-category-rows')!.getBoundingClientRect();
          const dialog = button.closest('[role="dialog"]')!;
          const heading = dialog.querySelector('.dialog-heading')!.getBoundingClientRect();
          const footer = dialog.querySelector('.dialog-footer')!.getBoundingClientRect();
          return box.top >= Math.max(rows.top, heading.bottom) && box.bottom <= Math.min(rows.bottom, footer.top);
        }),
      )
      .toBe(true);
    await editing.getByLabel('记账金额', { exact: true }).fill('20');
    await editing.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await expect(editing.getByLabel('记账金额', { exact: true })).toHaveValue('20');
    await editing.getByRole('button', { name: '完成', exact: true }).click();
    await expect(editing).toHaveCount(0);
    const updated = unwrap(
      await peer.client.GET('/api/v1/ledgers/{ledger_id}/transactions', {
        params: { path: { ledger_id: ledger.id } },
      }),
    ).items;
    expect(updated.find((record) => record.id === second.id)).toMatchObject({
      amount: '20',
      note: '第二笔手机早餐',
    });
    await expect(statistics.locator('.accounting-total-amount')).toHaveText('38.80');
    await page.getByRole('button', { name: /^查看第二笔手机早餐 / }).click();
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^查看第二笔手机早餐 / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^查看手机早餐记账 / })).toBeVisible();
  } catch (error) {
    console.error('手机触控记账验收失败', { error });
    throw error;
  }
});
