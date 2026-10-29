import { webcrypto } from 'node:crypto';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { AccountingTransferDialog } from './accounting-transfer-dialog';
import type { Ledger, Snapshot } from './transfer-schema';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), read: vi.fn() }));
vi.mock('../../../lib/session', () => ({
  api: { GET: mocks.get },
  useSession: () => ({ session: { user: { user_id: 'viewer' } } }),
  captureSessionOperation: () => ({
    client: { GET: mocks.get, POST: mocks.post },
    assertCurrent: () => {},
    invalidate: async () => {},
  }),
}));
vi.mock('../../../components/use-draft-close', () => ({
  useDraftClose: (_dirty: boolean, _pending: boolean, close: () => void) => ({ close, confirmation: null }),
}));
vi.mock('../../../lib/transfer/table', async (original) => ({
  ...(await original<object>()),
  readTransferFile: mocks.read,
}));

const ledger: Ledger = {
  id: 'd4d1c885-9a7a-4c87-968e-70b7dbe565f5',
  sync_id: '49712a79-35bd-4462-9e48-ead467c32b2a',
  owner_id: 'owner',
  name: '共享本',
  currency: 'CNY',
  month_start_day: 1,
  aa_enabled: false,
  archived_at: null,
  archive_updated_at: null,
  archive_device_id: null,
  role: 'editor',
  member_count: 2,
  updated_at: '2026-01-01T00:00:00Z',
};
const ids = ['c63266e7-7640-464c-ad22-bd9b5e1a4d1e', '8260fcb3-c519-49bc-909c-f44fb90d0850'];
const snapshot: Snapshot = {
  ledger,
  transactions: [],
  members: [],
  category_tombstones: [],
  recurring_transactions: [],
  exchange_rate_overrides: [],
  server_cursor: '1',
  categories: ids.map((id, index) => ({
    id,
    owner_id: 'owner',
    name: '旅行',
    icon: index ? 'car' : 'plane',
    parent_id: null,
    level: 1,
    kind: 'expense',
    sort_order: index,
    updated_at: ledger.updated_at,
    deleted_at: null,
    version_token: 'test',
  })),
};
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  mocks.get.mockReset().mockResolvedValue({ data: snapshot });
  mocks.post.mockReset().mockResolvedValue({ data: { imported_categories: 0, imported_transactions: 1 } });
  mocks.read.mockReset().mockResolvedValue([
    {
      name: 'CSV',
      records: [
        ['时间', '金额', '分类'],
        ['2026-09-30', '12', '旅行'],
      ],
    },
  ]);
});

it('共享成员的无ID来源必须明确选择owner分类后才可提交，失败重试保持原批次', async () => {
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AccountingTransferDialog ledger={ledger} onClose={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    fireEvent.change(screen.getByLabelText('选择明细文件'), { target: { files: [new File(['test'], 'input.csv')] } });
    fireEvent.click(await screen.findByRole('button', { name: '校验并预览' }));
    const target = await screen.findByLabelText('第 2 行：旅行');
    expect(screen.queryByRole('button', { name: '确认导入' })).toBeNull();
    expect(screen.queryByRole('option', { name: /新建独立分类/ })).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.change(target, { target: { value: ids[1] } });
    fireEvent.click(screen.getByRole('button', { name: '校验并预览' }));
    mocks.post.mockRejectedValueOnce(new Error('连接中断'));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    await screen.findByRole('button', { name: '继续未完成导入' });
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '继续未完成导入' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
    expect(mocks.post.mock.calls[0]![1].body).toMatchObject({
      categories: [],
      transactions: [{ category_id: ids[1] }],
    });
    await screen.findByText(/导入完成/);
    client.clear();
  } catch (cause) {
    throw new Error('导入分类明确选择与冻结重试交互验证失败', { cause });
  }
});

it('确认之后目标分类被删除，提交前阻断并允许重新选择，不按同名替代', async () => {
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AccountingTransferDialog ledger={ledger} onClose={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '导入文件' }));
    fireEvent.change(screen.getByLabelText('选择明细文件'), { target: { files: [new File(['test'], 'input.csv')] } });
    fireEvent.click(await screen.findByRole('button', { name: '校验并预览' }));
    fireEvent.change(await screen.findByLabelText('第 2 行：旅行'), { target: { value: ids[1] } });
    fireEvent.click(screen.getByRole('button', { name: '校验并预览' }));
    const submit = await screen.findByRole('button', { name: '确认导入' });
    mocks.get.mockResolvedValue({ data: { ...snapshot, categories: snapshot.categories.slice(0, 1) } });
    fireEvent.click(submit);
    await screen.findByText('目标分类已不可用，请重新校验并选择');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '确认导入' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '校验并预览' }));
    await screen.findByLabelText('第 2 行：旅行');
    expect(mocks.post).not.toHaveBeenCalled();
    client.clear();
  } catch (cause) {
    throw new Error('导入目标删除后的重新选择验证失败', { cause });
  }
});
