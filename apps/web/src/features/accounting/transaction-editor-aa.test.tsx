import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { components } from '@sesame-notes/api-client';
import { afterEach, expect, it, vi } from 'vitest';
import { TransactionEditor } from './transaction-editor';

const mocks = vi.hoisted(() => ({ submit: vi.fn().mockResolvedValue({}), get: vi.fn() }));
vi.mock('../../lib/session', () => ({
  useSession: () => ({ session: { user: { user_id: 'owner' } } }),
  api: { GET: mocks.get },
}));
vi.mock('../../lib/use-product-analytics', () => ({ useProductAnalyticsPage: vi.fn() }));
vi.mock('../../lib/product-analytics-runtime', () => ({
  captureProductAnalyticsContext: () => null,
  trackProductAction: vi.fn(),
}));
vi.mock('../../components/use-draft-close', () => ({
  useDraftClose: (_dirty: boolean, _busy: boolean, close: () => void) => ({ close, finish: close }),
}));
vi.mock('./transaction-submit', () => ({ createTransactionSubmitter: () => ({ submit: mocks.submit }) }));
vi.mock('./transaction-update', async (original) => ({
  ...(await original<typeof import('./transaction-update')>()),
  createTransactionUpdater: () => ({ submit: mocks.submit }),
}));

const ledger: components['schemas']['Ledger'] = {
  id: 'ledger',
  sync_id: 'sync',
  name: '日常',
  currency: 'CNY',
  month_start_day: 1,
  aa_enabled: true,
  archived_at: null,
  archive_updated_at: null,
  archive_device_id: null,
  role: 'owner',
  member_count: 3,
  updated_at: '2026-10-19T00:00:00.000Z',
};
const category: components['schemas']['Category'] = {
  id: 'food',
  name: '餐饮',
  kind: 'expense',
  level: 1,
  parent_id: null,
  sort_order: 0,
  icon: 'utensils',
  deleted_at: null,
  updated_at: '2026-10-19T00:00:00.000Z',
  version_token: 'version',
};
const transaction: components['schemas']['Transaction'] = {
  id: 'tx',
  ledger_id: ledger.id,
  tx_type: 'expense',
  amount: '0.03',
  native_amount: '0.20',
  currency_code: 'USD',
  happened_at: '2026-10-19T00:00:00.000Z',
  category_id: category.id,
  category_name: category.name,
  category_kind: 'expense',
  recurring_id: null,
  occurrence_date: null,
  created_by_member_id: 'a',
  last_edited_by_member_id: null,
  last_edited_at: null,
  created_at: '2026-10-19T00:00:00.000Z',
  note: '原备注',
  aa_mode: '2',
  payer_member_id: 'a',
  revision: 1,
  updated_at: '2026-10-19T00:00:00.000Z',
  splits: [
    { member_id: 'a', amount: '0.0666666666' },
    { member_id: 'b', amount: '0.0666666667' },
    { member_id: 'c', amount: '0.0666666667' },
  ],
};
const clients: QueryClient[] = [];

/** 使用真实表单、成员选择和校验，只替代网络边界以捕获最终提交内容。 */
async function renderEditor(aaEnabled = true) {
  mocks.get.mockImplementation(async (path: string) =>
    path.endsWith('/members')
      ? { data: [{ member_id: 'b', user_id: 'owner' }] }
      : {
          data: ['a', 'b', 'c'].map((id) => ({
            id,
            ledger_id: ledger.id,
            display_name: id,
            member_type: 'REGISTERED',
            status: 'ACTIVE',
            updated_at: ledger.updated_at,
          })),
        },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <TransactionEditor
        ledger={{ ...ledger, aa_enabled: aaEnabled }}
        existing={transaction}
        categories={[category]}
        categoriesLoading={false}
        categoriesError={null}
        retryCategories={() => {}}
        onClose={() => {}}
        onSaved={async () => {}}
      />
    </QueryClientProvider>,
  );
  if (aaEnabled) await screen.findByLabelText('分摊金额 1 · USD');
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  mocks.submit.mockClear();
  mocks.get.mockClear();
});

it('客户端十位分摊在Web按原币回显，修改备注后完整保留本位币分摊', async () => {
  await renderEditor();
  for (let index = 1; index <= 3; index++)
    expect((screen.getByLabelText(`分摊金额 ${index} · USD`) as HTMLInputElement).value).toBe('0.01');
  fireEvent.change(screen.getByLabelText('备注'), { target: { value: '只修改备注' } });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
  expect(mocks.submit.mock.calls[0]![0]).toMatchObject({
    note: '只修改备注',
    amount: '0.03',
    native_amount: '0.2',
    splits: transaction.splits,
  });
});

it('均分和输入校验使用原币金额，修改折算金额只影响保存时的本位币换算', async () => {
  await renderEditor();
  fireEvent.change(screen.getByLabelText('记账金额'), { target: { value: '0.06' } });
  fireEvent.change(screen.getByLabelText('折合主货币 · CNY'), { target: { value: '0.40' } });
  fireEvent.click(screen.getByRole('button', { name: '按当前参与人均分' }));
  for (let index = 1; index <= 3; index++)
    expect((screen.getByLabelText(`分摊金额 ${index} · USD`) as HTMLInputElement).value).toBe('0.02');
  fireEvent.change(screen.getByLabelText('分摊金额 1 · USD'), { target: { value: '0.021' } });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await screen.findByText(/每人金额大于 0 且最多 2 位小数/);
  expect(mocks.submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('分摊金额 1 · USD'), { target: { value: '0.02' } });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
  expect(mocks.submit.mock.calls[0]![0].splits).toEqual([
    { member_id: 'a', amount: '0.1333333334' },
    { member_id: 'b', amount: '0.1333333333' },
    { member_id: 'c', amount: '0.1333333333' },
  ]);
});

it('AA关闭时修改备注不提交隐藏分摊字段', async () => {
  await renderEditor(false);
  fireEvent.change(screen.getByLabelText('备注'), { target: { value: '关闭AA保留分摊' } });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
  const body = mocks.submit.mock.calls[0]![0];
  expect(body).not.toHaveProperty('splits');
  expect(body).not.toHaveProperty('aa_mode');
  expect(body).not.toHaveProperty('payer_member_id');
});

it('默认本人位于参与人中间时，原币均分与本位币换算尾差均归本人', async () => {
  await renderEditor();
  fireEvent.change(screen.getByLabelText('支出人'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('记账金额'), { target: { value: '0.10' } });
  fireEvent.click(screen.getByRole('button', { name: '按当前参与人均分' }));
  expect((screen.getByLabelText('分摊金额 2 · USD') as HTMLInputElement).value).toBe('0.04');
  fireEvent.change(screen.getByLabelText('记账金额'), { target: { value: '0.03' } });
  fireEvent.click(screen.getByRole('button', { name: '按当前参与人均分' }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
  expect(mocks.submit.mock.calls[0]![0]).toMatchObject({
    payer_member_id: 'b',
    splits: [
      { member_id: 'a', amount: '0.0666666667' },
      { member_id: 'b', amount: '0.0666666666' },
      { member_id: 'c', amount: '0.0666666667' },
    ],
  });
});
