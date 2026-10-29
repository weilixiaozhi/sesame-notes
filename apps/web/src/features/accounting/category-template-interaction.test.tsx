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
  return { ...original, Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
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

describe('分类模板添加交互', () => {
  it('明确选择同名父项后仅向该ID添加子分类', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: '午餐' } });
    fireEvent.click(screen.getByLabelText('选择餐饮中的午餐'));
    expect((screen.getByRole('button', { name: '添加 1 个子分类' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个子分类' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0]![1].body.items).toMatchObject([{ name: '午餐', level: 2, parent_id: 'second' }]);
    expect(mocks.post.mock.calls[0]![1].params.path.ledger_id).toBe('ledger');
  });

  it('同名分类不禁用模板，丢失回执重试保持整批ID和幂等键，双击只提交一次', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.post.mockRejectedValueOnce(new TypeError('回执丢失'));
    view();
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: '午餐' } });
    fireEvent.click(screen.getByLabelText('选择餐饮中的午餐'));
    fireEvent.click(screen.getByRole('button', { name: '新建 2 个分类' }));
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
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: '午餐' } });
    fireEvent.click(screen.getByLabelText('选择餐饮中的午餐'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个子分类' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    rendered.unmount();
    await act(async () => resolve({ data: targets }));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('追加模式批量选择搜索到的旅行，不要求模板预置子项', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: '旅行' } });
    fireEvent.click(screen.getByRole('button', { name: '选择当前模板' }));
    expect((screen.getByLabelText('选择分类旅行') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个子分类' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0]![1].body.items).toMatchObject([{ name: '旅行', parent_id: 'second', level: 2 }]);
  });

  it('新鲜目录发现目标失效后清空选择并保留新候选，不按同名替换', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fresh = [targets[1]!, { ...targets[0]!, id: 'third', icon: 'coffee' }];
    mocks.get.mockResolvedValue({ data: fresh });
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: '旅行' } });
    fireEvent.click(screen.getByLabelText('选择分类旅行'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个子分类' }));
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(['second', 'third']);
    expect(radios.every((radio) => !radio.checked)).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个子分类' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0]![1].body.items[0].parent_id).toBe('third');
  });

  it('服务端最终发现目标失效时可重新选择，未发送未知结果重试请求', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.post.mockRejectedValueOnce(new ApiError(400, 'CATEGORY_PARENT_UNAVAILABLE', '目标不可用'));
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: '旅行' } });
    fireEvent.click(screen.getByLabelText('选择分类旅行'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个子分类' }));
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '重试上次添加' })).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 个子分类' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[1]![1].body.items[0].parent_id).toBe('second');
  });

  it('陈旧账号属性不能捕获新账号客户端发送创建请求', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.currentUserId = 'another-owner';
    view('owner');
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: '旅行' } });
    fireEvent.click(screen.getByLabelText('选择分类旅行'));
    fireEvent.click(screen.getByRole('button', { name: '新建 1 个分类' }));
    await waitFor(() => expect(mocks.capture).toHaveBeenCalledWith('owner'));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('窄容器和大字号改变分行与网格相同列数，展开跟随所在行', async () => {
    let resized: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('category-template-groups')
        ? { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 288, width: 288, height: 600, toJSON: () => ({}) }
        : original.call(this);
    });
    const { container } = view();
    await waitFor(() =>
      expect(container.querySelector('.category-template-card-grid')?.getAttribute('style')).toContain('repeat(2,'),
    );
    expect(container.querySelector('.category-template-row .category-template-card-grid')?.children).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '展开交通子分类' }));
    expect(
      container.querySelector('.category-template-row')?.querySelector('[aria-label="交通的子分类"]'),
    ).not.toBeNull();
    const group = container.querySelector('.category-template-groups') as HTMLDivElement;
    group.style.fontSize = '24px';
    act(() => resized?.());
    await waitFor(() =>
      expect(container.querySelector('.category-template-card-grid')?.getAttribute('style')).toContain('repeat(1,'),
    );
    const row = screen.getByLabelText('选择分类交通').closest('.category-template-row');
    expect(row?.querySelector('.category-template-card-grid')?.children).toHaveLength(1);
    expect(row?.querySelector('[aria-label="交通的子分类"]')).not.toBeNull();
  });

  it('追加模式批量选择全部可见节点，包含搜索子项所在的分类卡片', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    fireEvent.change(screen.getByLabelText('搜索模板'), { target: { value: '午餐' } });
    fireEvent.click(screen.getByRole('button', { name: '选择当前模板' }));
    expect((screen.getByLabelText('选择分类餐饮') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('选择餐饮中的午餐') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '添加 2 个子分类' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    const added = mocks.post.mock.calls[0]![1].body.items;
    expect(added.map((row: { name: string }) => row.name)).toEqual(['餐饮', '午餐']);
    expect(added.every((row: { parent_id: string }) => row.parent_id === 'second')).toBe(true);
  });
});
