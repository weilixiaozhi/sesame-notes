import { randomUUID } from 'node:crypto';
import { unwrap } from '@sesame-notes/api-client';
import { test, expect, login, peerClient } from './fixtures';

test('外币指定AA由第二设备同步进入Web，编辑备注及默认付款人后分摊保持精确', async ({ page, account }) => {
  try {
    const peer = await peerClient(account);
    const ledger = unwrap(
      await peer.client.POST('/api/v1/ledgers', {
        body: { name: '外币分摊同步验收', currency: 'CNY', aa_enabled: true },
      }),
    );
    const category = unwrap(
      await peer.client.POST('/api/v1/ledgers/{ledger_id}/categories', {
        params: { path: { ledger_id: ledger.id } },
        body: { name: '分摊餐饮', kind: 'expense', level: 1, icon: 'utensils' },
      }),
    );
    const others = [randomUUID(), randomUUID()];
    const now = new Date().toISOString();
    for (const [index, id] of others.entries())
      await peer.push({
        mutation_id: randomUUID(),
        entity_type: 'member',
        entity_id: id,
        ledger_id: ledger.id,
        sync_id: ledger.sync_id,
        updated_at: now,
        action: 'upsert',
        payload: { display_name: `参与人${index + 1}` },
      });
    const members = unwrap(
      await peer.client.GET('/api/v1/ledgers/{ledger_id}/members', {
        params: { path: { ledger_id: ledger.id } },
      }),
    );
    const self = members[0]!.member_id;
    const ids = [others[0]!, self, others[1]!];
    const splits = ids.map((member_id, index) => ({
      member_id,
      amount: index === 1 ? '0.0666666666' : '0.0666666667',
    }));
    const transactionId = randomUUID();
    await peer.push({
      mutation_id: randomUUID(),
      entity_type: 'transaction',
      entity_id: transactionId,
      ledger_id: ledger.id,
      sync_id: ledger.sync_id,
      base_revision: 0,
      updated_at: now,
      action: 'upsert',
      payload: {
        tx_type: 'expense',
        amount: '0.03',
        native_amount: '0.2',
        currency_code: 'USD',
        happened_at: now,
        category_id: category.id,
        note: '来自客户端精确分摊',
        recurring_id: null,
        last_edited_at: null,
        payer_member_id: self,
        aa_mode: '2',
        splits,
      },
    });
    await login(page, account);
    await page.goto(`/accounting?ledger=${ledger.id}`);
    await page.getByRole('button', { name: /^查看来自客户端精确分摊 / }).click();
    await page.getByRole('button', { name: '编辑记账', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '记一笔', exact: true });
    for (let index = 1; index <= 3; index++)
      await expect(editor.getByLabel(`分摊金额 ${index} · USD`, { exact: true })).toHaveValue('0.01');
    await editor.getByLabel('备注', { exact: true }).fill('Web修改备注保留分摊');
    await editor.getByLabel('支出人', { exact: true }).selectOption('');
    await editor.getByRole('button', { name: '完成', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const snapshot = unwrap(
      await peer.client.GET('/api/v1/sync/full', {
        params: { query: { ledger_id: ledger.id, sync_id: ledger.sync_id } },
      }),
    );
    const saved = snapshot.transactions.find((entry) => entry.id === transactionId)!;
    expect(saved).toMatchObject({
      note: 'Web修改备注保留分摊',
      amount: '0.03',
      native_amount: '0.2',
      payer_member_id: self,
    });
    expect(new Map(saved.splits.map((split) => [split.member_id, split.amount]))).toEqual(
      new Map(splits.map((split) => [split.member_id, split.amount])),
    );
    // 第二设备回传相同精确分摊并修改备注，Web再次打开仍恢复原币两位金额。
    await peer.push({
      mutation_id: randomUUID(),
      entity_type: 'transaction',
      entity_id: saved.id,
      ledger_id: ledger.id,
      sync_id: ledger.sync_id,
      base_revision: saved.revision,
      updated_at: new Date().toISOString(),
      action: 'upsert',
      payload: {
        tx_type: 'expense',
        amount: saved.amount,
        native_amount: saved.native_amount,
        currency_code: saved.currency_code,
        happened_at: saved.happened_at,
        category_id: category.id,
        note: '第二设备确认精确分摊',
        recurring_id: null,
        last_edited_at: new Date().toISOString(),
        payer_member_id: saved.payer_member_id,
        aa_mode: '2',
        splits: saved.splits,
      },
    });
    await page.reload();
    await page.getByRole('button', { name: /^查看第二设备确认精确分摊 / }).click();
    await page.getByRole('button', { name: '编辑记账', exact: true }).click();
    for (let index = 1; index <= 3; index++)
      await expect(page.getByLabel(`分摊金额 ${index} · USD`, { exact: true })).toHaveValue('0.01');
  } catch (error) {
    console.error('外币指定AA跨设备验收失败', error);
    throw error;
  }
});
