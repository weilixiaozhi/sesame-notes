import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    Dialog: ({
      children,
      footer,
      title,
      onClose,
      showCloseButton = true,
    }: {
      children: React.ReactNode;
      footer?: React.ReactNode;
      title: string;
      onClose: () => void;
      showCloseButton?: boolean;
    }) => (
      <section
        role="dialog"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        {children}
        {footer}
        {showCloseButton && <button onClick={onClose}>关闭弹窗</button>}
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

describe('紧凑分类模板添加交互', () => {
  it('模板页与目标弹层不包含搜索，追加模式一次平铺159个独立节点', () => {
    const { container } = view();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    expect(container.querySelectorAll('.category-template-flat-grid > .category-template-card')).toHaveLength(159);
    expect(screen.getAllByRole('checkbox')).toHaveLength(159);
    expect(screen.queryByRole('button', { name: /展开|收起/ })).toBeNull();
    expect(container.querySelector('.category-template-children')).toBeNull();
    expect(screen.queryByText('无子分类')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择已有分类' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(container.querySelectorAll('.category-template-target-list .category-template-icon')).toHaveLength(2);
    expect(within(screen.getByRole('dialog', { name: '选择已有分类' })).queryByText(/个子分类/)).toBeNull();
    expect(
      within(screen.getByRole('dialog', { name: '选择已有分类' })).queryByRole('button', { name: '关闭弹窗' }),
    ).toBeNull();
    expect(
      within(screen.getByRole('dialog', { name: '分类模板库' })).getByRole('button', { name: '关闭弹窗' }),
    ).not.toBeNull();
  });

  it('明确选择同名目标后仅向该ID添加午餐', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    fireEvent.click(screen.getByLabelText('选择分类午餐'));
    expect((screen.getByRole('button', { name: '添加 1 项' }) as HTMLButtonElement).disabled).toBe(true);
    chooseTarget(1);
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0]![1].body.items).toMatchObject([{ name: '午餐', level: 2, parent_id: 'second' }]);
    expect(mocks.post.mock.calls[0]![1].params.path.ledger_id).toBe('ledger');
  });

  it('新建模式点击分类展开，未知回执重试固定ID及幂等键，双击只提交一次', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.post.mockRejectedValueOnce(new TypeError('回执丢失'));
    view();
    fireEvent.click(screen.getByLabelText('选择分类餐饮'));
    expect(screen.getByRole('status').textContent).toBe('已选 1 项');
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

  it('追加旅行无需展开且只创建目标下一个节点', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    chooseTarget(1);
    fireEvent.click(screen.getByLabelText('选择分类旅行'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0]![1].body.items).toMatchObject([{ name: '旅行', parent_id: 'second', level: 2 }]);
  });

  it('新鲜目录发现目标失效后允许重新选，保留已选模板', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fresh = [targets[1]!, { ...targets[0]!, id: 'third', icon: 'coffee' }];
    mocks.get.mockResolvedValue({ data: fresh });
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    chooseTarget(0);
    fireEvent.click(screen.getByLabelText('选择分类旅行'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
    expect((screen.getByLabelText('选择分类旅行') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '选择已有分类' }));
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual(['second', 'third']);
    expect(radios.every((radio) => !radio.checked)).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0]![1].body.items[0].parent_id).toBe('third');
  });

  it('服务端最终发现目标失效时可重新选择，不自动重试已拒绝请求', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.post.mockRejectedValueOnce(new ApiError(400, 'CATEGORY_PARENT_UNAVAILABLE', '目标不可用'));
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    chooseTarget(0);
    fireEvent.click(screen.getByLabelText('选择分类旅行'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '重试上次添加' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '选择已有分类' }));
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('radio'));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[1]![1].body.items[0].parent_id).toBe('second');
  });

  it('取消更换目标不改变已确认的目标ID', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    chooseTarget(0);
    fireEvent.click(screen.getByRole('button', { name: '更换目标分类餐饮' }));
    fireEvent.click(screen.getAllByRole('radio')[1]!);
    fireEvent.keyDown(screen.getByRole('dialog', { name: '选择已有分类' }), { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('选择分类午餐'));
    fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0]![1].body.items[0].parent_id).toBe('first');
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

  it('窄容器和字号变化时逻辑分行与网格列数一致', async () => {
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
      expect(container.querySelector('.category-template-card-grid')?.getAttribute('style')).toContain('repeat(3,'),
    );
    expect(container.querySelector('.category-template-row .category-template-card-grid')?.children).toHaveLength(3);
    fireEvent.click(screen.getByLabelText('选择分类交通'));
    expect(
      container.querySelector('.category-template-row')?.querySelector('[aria-label="交通的子分类"]'),
    ).not.toBeNull();
    const group = container.querySelector('.category-template-groups') as HTMLDivElement;
    group.style.fontSize = '24px';
    act(() => resized?.());
    await waitFor(() =>
      expect(container.querySelector('.category-template-card-grid')?.getAttribute('style')).toContain('repeat(2,'),
    );
    const row = screen.getByLabelText('选择分类交通').closest('.category-template-row');
    expect(row?.querySelector('.category-template-card-grid')?.children).toHaveLength(2);
    expect(row?.querySelector('[aria-label="交通的子分类"]')).not.toBeNull();
  });

  it('根卡点击只保留一个展开组，重复点保持展开，切组保留其他组选择', () => {
    const { container } = view();
    const dining = screen.getByLabelText('选择分类餐饮') as HTMLInputElement;
    const transport = screen.getByLabelText('选择分类交通') as HTMLInputElement;
    fireEvent.click(dining);
    expect(dining.checked).toBe(true);
    expect(dining.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(dining);
    expect(dining.checked).toBe(false);
    expect(dining.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(dining);
    fireEvent.click(transport);
    expect(dining.checked).toBe(true);
    expect(transport.checked).toBe(true);
    expect(container.querySelectorAll('.category-template-children')).toHaveLength(1);
    expect(screen.queryByLabelText('餐饮的子分类')).toBeNull();
    expect(screen.getByLabelText('交通的子分类')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('选择分类家庭'));
    expect(container.querySelectorAll('.category-template-children')).toHaveLength(0);
    expect(dining.checked).toBe(true);
    expect(transport.checked).toBe(true);
    expect(dining.closest('.category-template-card')?.querySelector('.transaction-category-badge')).not.toBeNull();
    expect(
      screen
        .getByLabelText('选择分类家庭')
        .closest('.category-template-card')
        ?.querySelector('.transaction-category-badge'),
    ).toBeNull();
    expect(container.querySelector('.category-template-expand')).toBeNull();
    expect(screen.queryByText('无子分类')).toBeNull();
  });

  it('平铺全选保持159个独立ID并全部绑定明确目标', async () => {
    view();
    fireEvent.click(screen.getByRole('button', { name: '添加到已有分类' }));
    chooseTarget(1);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getAllByRole('checkbox').every((input) => (input as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '添加 159 项' }));
    await waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    const added = mocks.post.mock.calls[0]![1].body.items;
    expect(added).toHaveLength(159);
    expect(new Set(added.map((row: { id: string }) => row.id)).size).toBe(159);
    expect(added.every((row: { parent_id: string }) => row.parent_id === 'second')).toBe(true);
  });
});
