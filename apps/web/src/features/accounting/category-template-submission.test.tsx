import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type components } from '@sesame-notes/api-client';
import { CategoryTemplates } from './category-templates';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  close: vi.fn(),
  invalidate: vi.fn(),
  session: new AbortController(),
  capture: vi.fn(),
  currentUserId: 'owner',
}));
vi.mock('../../lib/session', () => ({
  queryClient: { invalidateQueries: mocks.invalidate },
  captureSessionOperation: (expected: string) => mocks.capture(expected),
}));
vi.mock('../../lib/use-product-analytics', () => ({ useProductAnalyticsPage: () => {} }));
vi.mock('../../components/use-draft-close', () => ({
  useDraftClose: (_dirty: boolean, _pending: boolean, onClose: () => void) => ({
    close: onClose,
    finish: onClose,
    confirmation: null,
  }),
}));
vi.mock('../../components/ui', async () => {
  const original = await vi.importActual<typeof import('../../components/ui')>('../../components/ui');
  return {
    ...original,
    Dialog: ({ children, footer, title }: { children: React.ReactNode; footer?: React.ReactNode; title: string }) => (
      <section role="dialog" aria-label={title}>
        {children}
        {footer}
      </section>
    ),
  };
});
const targets: components['schemas']['Category'][] = ['first', 'second'].map((id, index) => ({
  id,
  name: '餐饮',
  kind: 'expense',
  level: 1,
  parent_id: null,
  icon: index ? 'home' : 'utensils',
  sort_order: index,
  deleted_at: null,
  version_token: 'test-version',
  updated_at: '2026-10-01T00:00:00Z',
}));

/** 每次挂载独立查询容器，模拟真实的账号与账本切换。 */
function view(accountId = 'owner', ledgerId = 'ledger') {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CategoryTemplates accountId={accountId} ledgerId={ledgerId} categories={targets} onClose={mocks.close} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = new AbortController();
  mocks.currentUserId = 'owner';
  mocks.capture.mockImplementation((expected: string) => {
    if (expected !== mocks.currentUserId) throw new ApiError(401, 'SESSION_CHANGED', '账号已变化');
    return {
      client: { POST: mocks.post, GET: mocks.get },
      signal: mocks.session.signal,
      assertCurrent: () => mocks.session.signal.throwIfAborted(),
    };
  });
  mocks.post.mockResolvedValue({ data: [] });
  mocks.get.mockResolvedValue({ data: targets });
  mocks.invalidate.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 通过真实的目标选择与确认操作指定分类，不按名称猜测实例。 */
function chooseTarget(index: number) {
  fireEvent.click(screen.getByRole('button', { name: /选择已有分类|更换目标分类/ }));
  fireEvent.click(screen.getAllByRole('radio')[index]!);
  fireEvent.click(screen.getByRole('button', { name: '确定' }));
}

describe('分类模板提交边界', () => {
  it('未知回执重试固定ID及幂等键，并发重试只提交一次', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.post.mockRejectedValueOnce(new TypeError('回执丢失'));
    view();
    fireEvent.click(screen.getByLabelText('选择分类餐饮'));
    fireEvent.click(screen.getByLabelText('选择餐饮中的午餐'));
    fireEvent.click(screen.getByRole('button', { name: '添加 2 项' }));
    await screen.findByRole('button', { name: '重试上次添加' });
    const frozen = structuredClone({
      body: mocks.post.mock.calls[0]![1].body,
      params: mocks.post.mock.calls[0]![1].params,
    });
    const retry = screen.getByRole('button', { name: '重试上次添加' });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect({ body: mocks.post.mock.calls[1]![1].body, params: mocks.post.mock.calls[1]![1].params }).toEqual(frozen);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(frozen.body.items[0].id).not.toBe('first');
    expect(frozen.body.items[1].parent_id).toBe(frozen.body.items[0].id);
  });

  it('离开账号后迟到的目标查询不能向新目录创建分类', async () => {
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const rendered = view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    chooseTarget(0);
    fireEvent.click(screen.getByLabelText('选择分类午餐'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    rendered.unmount();
    await act(async () => resolve({ data: targets }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('陈旧账号属性不能捕获新账号客户端发送创建请求', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.currentUserId = 'another-owner';
    view('owner');
    fireEvent.click(screen.getByLabelText('选择分类旅行'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledWith('owner'));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
