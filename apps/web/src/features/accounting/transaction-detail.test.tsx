import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { components } from '@sesame-notes/api-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TransactionDetail } from './transaction-detail';
import { TransactionTimeline } from './transaction-timeline';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../lib/session', () => ({
  api: { GET: mocks.get },
  useSession: () => ({ session: { user: { user_id: 'owner' } } }),
}));
vi.mock('../../lib/use-product-analytics', () => ({ useProductAnalyticsPage: vi.fn() }));

const ledger: components['schemas']['Ledger'] = {
  id: 'ledger',
  sync_id: 'sync',
  name: '日常账本',
  currency: 'CNY',
  month_start_day: 1,
  aa_enabled: true,
  archived_at: null,
  archive_updated_at: null,
  archive_device_id: null,
  role: 'owner',
  member_count: 2,
  updated_at: '2026-10-19T00:00:00.000Z',
};
const transaction: components['schemas']['Transaction'] = {
  id: 'expense',
  ledger_id: ledger.id,
  tx_type: 'expense',
  amount: '10.25',
  native_amount: '71.75',
  currency_code: 'USD',
  happened_at: '2026-10-19T05:20:00.000Z',
  note: '旅行午餐\n两人一起',
  category_id: 'lunch',
  category_name: '午餐',
  category_kind: 'expense',

  payer_member_id: 'self',
  aa_mode: '2',
  splits: [
    { member_id: 'self', amount: '40' },
    { member_id: 'friend', amount: '31.75' },
  ],
  recurring_id: null,
  occurrence_date: null,
  created_by_member_id: 'self',
  last_edited_by_member_id: null,
  revision: 1,
  last_edited_at: null,
  updated_at: '2026-10-19T05:20:00.000Z',
  created_at: '2026-10-19T05:20:00.000Z',
};
const categories: components['schemas']['Category'][] = [
  {
    id: 'food',
    name: '餐饮',
    kind: 'expense',
    level: 1,
    parent_id: null,
    sort_order: 0,
    icon: 'utensils',
    deleted_at: null,
    updated_at: '2026-10-19T00:00:00.000Z',
    version_token: 'food-version',
  },
  {
    id: 'lunch',
    name: '午餐',
    kind: 'expense',
    level: 2,
    parent_id: 'food',
    sort_order: 0,
    icon: 'utensils',
    deleted_at: null,
    updated_at: '2026-10-19T00:00:00.000Z',
    version_token: 'lunch-version',
  },
];
const members: components['schemas']['Member'][] = [
  {
    id: 'self',
    ledger_id: ledger.id,
    display_name: '小芝',
    member_type: 'REGISTERED',
    status: 'ACTIVE',
    updated_at: '2026-10-19T00:00:00.000Z',
  },
  {
    id: 'friend',
    ledger_id: ledger.id,
    display_name: '小麻',
    member_type: 'REGISTERED',
    status: 'LEFT',
    updated_at: '2026-10-19T00:00:00.000Z',
  },
];
const clients: QueryClient[] = [];

/** 为详情建立隔离缓存，成员加载失败可直接重试，不依赖真实账号或网络。 */
function renderDetail(overrides: Partial<ComponentProps<typeof TransactionDetail>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TransactionDetail
        transaction={transaction}
        ledger={ledger}
        categories={categories}
        onEdit={onEdit}
        onDelete={onDelete}
        onClose={onClose}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onEdit, onDelete, onClose };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.get.mockResolvedValue({ data: members });
});

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
});

it('详情使用分类标题和实际备注，保留原币折算及 AA 金额，编辑删除为明确操作', async () => {
  const { onEdit, onDelete } = renderDetail();
  expect(screen.getByRole('dialog', { name: '餐饮 / 午餐' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 3, name: '餐饮 / 午餐' })).toBeTruthy();
  expect(screen.queryByText(ledger.name)).toBeNull();
  expect(screen.queryByText('支出分类')).toBeNull();
  expect(screen.getByLabelText('记账金额 USD 10.25')).toBeTruthy();
  expect(screen.getByText('≈ CNY 71.75')).toBeTruthy();
  expect(screen.getByText('记账日期')).toBeTruthy();
  expect(screen.getByText('货币', { exact: true })).toBeTruthy();
  expect(screen.getByText('折合主货币')).toBeTruthy();
  expect(screen.getByText('旅行午餐 两人一起')).toBeTruthy();
  expect(screen.queryByText('支出统计')).toBeNull();
  expect(screen.queryByText(/不计支出|不计入统计/)).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  await screen.findByText('小麻（已退出）');
  expect(screen.getByText('指定分摊', { exact: true })).toBeTruthy();
  expect(screen.getByText('支出人', { exact: true })).toBeTruthy();
  expect(screen.getByText('40.00', { exact: true })).toBeTruthy();
  expect(screen.getByText('31.75', { exact: true })).toBeTruthy();
  const editButton = screen.getByRole('button', { name: '编辑记账' });
  const deleteButton = screen.getByRole('button', { name: '删除' });
  expect(editButton.closest('.dialog-footer')).toBeTruthy();
  expect(deleteButton.closest('.dialog-heading')).toBeTruthy();
  expect(screen.getAllByRole('button').filter((button) => button.closest('.dialog-footer'))).toHaveLength(1);
  fireEvent.click(editButton);
  expect(onEdit).toHaveBeenCalledOnce();
  fireEvent.click(deleteButton);
  expect(onDelete).toHaveBeenCalledOnce();
});

it('归档记录仍能打开详情，详情保留正文并隐藏编辑删除操作', () => {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  const list = render(
    <TransactionTimeline
      items={[transaction]}
      categories={categories}
      currency="CNY"
      archived
      onOpen={onOpen}
      onDelete={onDelete}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /^查看旅行午餐/ }));
  expect(onOpen).toHaveBeenCalledWith(transaction);
  expect(screen.queryByRole('button', { name: /^删除/ })).toBeNull();
  expect(screen.queryByText(/不计支出|不计入统计/)).toBeNull();
  list.unmount();
  renderDetail({ ledger: { ...ledger, archived_at: '2026-10-19T06:00:00.000Z' } });
  expect(screen.getByLabelText('记账金额 USD 10.25')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '编辑记账' })).toBeNull();
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
});

it('成员目录失败显示重试入口并记录上下文，重试成功后恢复分摊人名称', async () => {
  const error = new Error('成员网络读取失败');
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.get.mockRejectedValueOnce(error);
  renderDetail();
  fireEvent.click(await screen.findByRole('button', { name: '重新加载' }));
  await screen.findByText('小麻（已退出）');
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  expect(log).toHaveBeenCalledWith('支出详情成员目录读取失败', {
    ledgerId: ledger.id,
    transactionId: transaction.id,
    error,
  });
});

it('未开启 AA 的普通记录仅展示支出人，默认模式值不声称正在分摊', async () => {
  renderDetail({ ledger: { ...ledger, aa_enabled: false }, transaction: { ...transaction, aa_mode: '0', splits: [] } });
  expect(screen.getByRole('region', { name: '支出人' })).toBeTruthy();
  await screen.findByText('小芝', { exact: true });
  expect(screen.queryByText('人均分摊', { exact: true })).toBeNull();
  expect(screen.queryByText('分摊方式', { exact: true })).toBeNull();
});

it('人均分摊使用全部成员文案，空备注不添加装饰说明', async () => {
  renderDetail({ transaction: { ...transaction, note: '', aa_mode: '0', splits: [] } });
  await screen.findByText('人均分摊', { exact: true });
  expect(screen.getByText('全部成员', { exact: true })).toBeTruthy();
  expect(screen.queryByText('未填写备注')).toBeNull();
  expect(screen.queryByText(ledger.name)).toBeNull();
});

it('不分摊记录保留支出人并隐藏参与人，超大精确金额完整展示', async () => {
  const amount = '12345678901234567890123456.123456789';
  renderDetail({
    transaction: { ...transaction, amount, native_amount: amount, currency_code: 'CNY', aa_mode: '1', splits: [] },
  });
  await screen.findByText('不分摊', { exact: true });
  expect(screen.queryByText('参与人', { exact: true })).toBeNull();
  expect(screen.getByText('小芝', { exact: true })).toBeTruthy();
  expect(screen.getByLabelText(`记账金额 CNY ${amount}`).textContent).toBe(
    'CNY 12,345,678,901,234,567,890,123,456.123456789',
  );
  expect(screen.queryByText('折合主货币')).toBeNull();
});
