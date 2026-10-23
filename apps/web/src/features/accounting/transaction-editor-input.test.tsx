import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { components } from '@sesame-notes/api-client';
import { afterEach, expect, it, vi } from 'vitest';
import { TransactionEditor } from './transaction-editor';

const mocks = vi.hoisted(() => ({ submit: vi.fn().mockResolvedValue({}) }));
vi.mock('../../lib/session', () => ({ useSession: () => ({ session: { user: { user_id: 'owner' } } }) }));
vi.mock('../../lib/use-product-analytics', () => ({ useProductAnalyticsPage: vi.fn() }));
vi.mock('../../lib/product-analytics-runtime', () => ({
  captureProductAnalyticsContext: () => null,
  trackProductAction: vi.fn(),
}));
vi.mock('../../components/use-draft-close', () => ({
  useDraftClose: (_dirty: boolean, _busy: boolean, close: () => void) => ({ close, finish: close }),
}));
vi.mock('./transaction-submit', () => ({ createTransactionSubmitter: () => ({ submit: mocks.submit }) }));

const ledger: components['schemas']['Ledger'] = {
  id: 'ledger',
  sync_id: 'sync',
  name: '日常',
  currency: 'CNY',
  month_start_day: 1,
  aa_enabled: false,
  archived_at: null,
  archive_updated_at: null,
  archive_device_id: null,
  role: 'owner',
  member_count: 1,
  updated_at: '2026-10-19T00:00:00.000Z',
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
    version_token: 'version',
  },
];
const clients: QueryClient[] = [];

/** 保留真实记账表单和输入事件，仅替代网络写入与埋点。 */
function renderEditor() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <TransactionEditor
        ledger={ledger}
        categories={categories}
        categoriesLoading={false}
        categoriesError={null}
        retryCategories={() => {}}
        onClose={() => {}}
        onSaved={async () => {}}
      />
    </QueryClientProvider>,
  );
  return screen.getByLabelText('备注') as HTMLInputElement;
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  mocks.submit.mockClear();
});

it('第20个汉字输入时保留完整拼音，组合结束后保存汉字', async () => {
  const note = renderEditor();
  const prefix = '记'.repeat(19);
  fireEvent.change(note, { target: { value: prefix } });
  fireEvent.compositionStart(note);
  fireEvent.change(note, { target: { value: `${prefix}zhong` } });
  expect(note.value).toBe(`${prefix}zhong`);
  fireEvent.compositionEnd(note, { target: { value: `${prefix}中` }, data: '中' });
  fireEvent.change(screen.getByLabelText('记账金额'), { target: { value: '12.34' } });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
  expect(mocks.submit.mock.calls[0]![0].note).toBe(`${prefix}中`);
});

it('组合输入提交后再执行20字限制，粘贴组合表情不拆开字符', () => {
  const note = renderEditor();
  const prefix = '记'.repeat(19);
  fireEvent.compositionStart(note);
  fireEvent.change(note, { target: { value: `${prefix}zhongwen` } });
  expect(note.value).toBe(`${prefix}zhongwen`);
  fireEvent.compositionEnd(note, { target: { value: `${prefix}中文` }, data: '中文' });
  expect(note.value).toBe(`${prefix}中`);
  const family = '👨‍👩‍👧‍👦';
  fireEvent.change(note, { target: { value: family.repeat(21) } });
  expect(note.value).toBe(family.repeat(20));
});

it('输入法候选词确认期间的回车不提前保存拼音', async () => {
  const note = renderEditor();
  fireEvent.change(screen.getByLabelText('记账金额'), { target: { value: '12.34' } });
  fireEvent.compositionStart(note);
  fireEvent.change(note, { target: { value: 'zaocan' } });
  await act(async () => fireEvent.submit(note.closest('form')!));
  expect(mocks.submit).not.toHaveBeenCalled();
  fireEvent.compositionEnd(note, { target: { value: '早餐' }, data: '早餐' });
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
  expect(mocks.submit.mock.calls[0]![0].note).toBe('早餐');
});
