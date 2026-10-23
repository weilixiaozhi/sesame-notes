// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersPage } from './application/users';
import { AccountsPage } from './system/accounts';
import { GroupsPage } from './system/groups';
import { AuditPage } from './system/operation-logs';
import { FitnessManagementPage } from './fitness';
import { ReferencePicker } from './fitness/reference-picker';
import { GroupSelect } from '../components/group-select';
import { useListQuerySubmit } from '../lib/use-list-query-submit';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  /** 所有页面读取都经过同一个可观测边界，避免测试访问网络。 */
  const list = (name: string) => (query: unknown, signal?: AbortSignal) => mocks.read(name, query, signal);
  return {
    ...actual,
    api: {
      adminUsers: { list: list('users') },
      adminAccounts: { list: list('accounts') },
      adminGroups: {
        list: list('groups'),
        members: (_id: string, query: unknown) => mocks.read('members', query),
        candidates: (_id: string, query: unknown) => mocks.read('candidates', query),
      },
      adminAudit: { list: list('audit'), actions: async () => [] },
      adminFitnessExercises: { list: list('exercise') },
      adminFitnessTemplates: { list: list('template') },
      adminFitnessPlans: { list: list('plan') },
      adminFitnessTaxonomies: { list: async () => ({ items: [] }) },
    },
  };
});
vi.mock('../auth/session', () => ({
  useSession: () => ({ session: { admin: { id: 'operator', permissions: [] } } }),
  queryClient: { invalidateQueries: vi.fn() },
}));

type Query = { page: number; page_size: number; q?: string; search?: string; actor_search?: string };
type Scenario = {
  name: string;
  endpoint: string;
  render: () => ReactNode;
  dialog?: boolean;
  selector?: boolean;
  open?: () => Promise<void>;
};
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let unmounted: boolean;

/** 点击实际页面按钮，等待 React 与查询状态发布。 */
async function click(text: string, scope: ParentNode = document): Promise<void> {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text);
  if (!button) throw new Error(`未找到按钮：${text}`);
  await act(async () => {
    button.click();
  });
}

const scenarios: Scenario[] = [
  { name: '应用用户', endpoint: 'users', render: () => createElement(UsersPage, { active: true, navigate: vi.fn() }) },
  { name: '后台用户', endpoint: 'accounts', render: () => createElement(AccountsPage, { active: true }) },
  { name: '用户组', endpoint: 'groups', render: () => createElement(GroupsPage, { active: true }) },
  { name: '操作日志', endpoint: 'audit', render: () => createElement(AuditPage, { active: true }) },
  ...(['exercise', 'template', 'plan'] as const).map((kind) => ({
    name: `健身目录 ${kind}`,
    endpoint: kind,
    render: () => createElement(FitnessManagementPage, { active: true, kind }),
  })),
  ...(['exercise', 'template'] as const).map((kind) => ({
    name: `健身引用 ${kind}`,
    endpoint: kind,
    dialog: true,
    render: () => createElement(ReferencePicker, { kind, onSelect: vi.fn(), onClose: vi.fn() }),
  })),
  {
    name: '用户组选择器',
    endpoint: 'groups',
    selector: true,
    render: () => createElement(GroupSelect, { value: '', mode: 'filter', onChange: vi.fn() }),
  },
  ...(['members', 'candidates'] as const).map((mode) => ({
    name: `组内账号 ${mode}`,
    endpoint: mode,
    dialog: true,
    render: () => createElement(GroupsPage, { active: true }),
    open: async () => {
      await click('成员管理');
      if (mode === 'candidates') await click('添加成员');
    },
  })),
];

/** 返回合法列表与可进入成员管理的组，分页总数足以覆盖下一页。 */
function page(name: string, query: Query) {
  return {
    items:
      name === 'groups'
        ? [
            {
              id: 'group',
              name: '测试组',
              description: '',
              member_count: 1,
              is_enabled: true,
              is_default: false,
              version: 1,
              updated_at: null,
            },
          ]
        : [],
    page: query.page,
    page_size: query.page_size,
    total: 30,
  };
}

/** 只统计目标列表，后台用户页附带的用户组选择器查询不混入断言。 */
function requests(endpoint: string): Query[] {
  return mocks.read.mock.calls.filter(([name]) => name === endpoint).map(([, query]) => query as Query);
}

/** 实际查询栏位于页面或弹窗；选择器通过查找按钮触发，避免外层表单提交。 */
function toolbar(scenario: Scenario): HTMLElement {
  const scope = scenario.dialog ? document.querySelector('[role="dialog"]')! : container;
  const target = scope.querySelector<HTMLElement>(
    scenario.selector ? '.inline-fields' : 'form.toolbar, form.inline-fields',
  );
  if (!target) throw new Error(`查询栏不存在：${scenario.name}`);
  return target;
}

/** 通过原生输入事件更新真实受控表单。 */
async function changeInput(target: HTMLElement, value: string): Promise<void> {
  const input = target.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 提交真实查询栏，让页面自己的归一化和目标 queryKey 参与回归。 */
async function submit(scenario: Scenario): Promise<void> {
  const target = toolbar(scenario);
  await act(async () => {
    if (scenario.selector) target.querySelector<HTMLButtonElement>('button')!.click();
    else target.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** 顺序查询等待请求结束且真实按钮恢复可用；在途连点用例直接提交，不经过此等待。 */
async function waitForQueryReady(scenario: Scenario): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(client.isFetching()).toBe(0);
    const button = toolbar(scenario).querySelector<HTMLButtonElement>(
      scenario.selector ? 'button' : 'button[type="submit"]',
    );
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
  });
}

/** 为每个测试创建全新内存缓存，保留生产的非轮询和新鲜缓存行为。 */
async function mount(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, node));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('列表测试禁止访问网络');
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.read.mockReset().mockImplementation(async (name, query) => page(name, query));
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  unmounted = false;
});

afterEach(async () => {
  if (!unmounted)
    await act(async () => {
      root.unmount();
    });
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('管理列表人工查询', () => {
  it('引用选择器跳页只提交分页，不触发外层内容保存表单', async () => {
    try {
      const save = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
      await mount(
        createElement(
          'form',
          { onSubmit: save },
          createElement(ReferencePicker, { kind: 'exercise', onSelect: vi.fn(), onClose: vi.fn() }),
        ),
      );
      const form = document.querySelector<HTMLElement>('[role="dialog"] .page-jump')!;
      await changeInput(form, '2');
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(requests('exercise').at(-1)).toMatchObject({ page: 2 });
      expect(save).not.toHaveBeenCalled();
    } catch (cause) {
      throw new Error('引用弹窗分页与内容保存隔离验证失败', { cause });
    }
  });

  it.each(scenarios)('$name：同条件取最新，变条件及翻页后仅查询目标第一页', async (scenario) => {
    await mount(scenario.render());
    await scenario.open?.();
    const before = requests(scenario.endpoint).length;
    const cacheSize = client.getQueryCache().getAll().length;
    await waitForQueryReady(scenario);
    await submit(scenario);
    await waitForQueryReady(scenario);
    await submit(scenario);
    expect(requests(scenario.endpoint)).toHaveLength(before + 2);
    expect(client.getQueryCache().getAll()).toHaveLength(cacheSize);

    await changeInput(toolbar(scenario), '  needle  ');
    await waitForQueryReady(scenario);
    await submit(scenario);
    expect(requests(scenario.endpoint)).toHaveLength(before + 3);
    expect(requests(scenario.endpoint).at(-1)).toMatchObject({
      page: 1,
      [scenario.endpoint === 'users' ? 'search' : scenario.endpoint === 'audit' ? 'actor_search' : 'q']: 'needle',
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const scope = scenario.dialog ? document.querySelector('[role="dialog"]')! : container;
    await click('下一页', scope.querySelector(scenario.selector ? '.selector-pages' : '.pagination')!);
    expect(requests(scenario.endpoint).at(-1)).toMatchObject({ page: 2 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const paged = requests(scenario.endpoint).length;
    await waitForQueryReady(scenario);
    await submit(scenario);
    expect(requests(scenario.endpoint)).toHaveLength(paged + 1);
    expect(requests(scenario.endpoint).at(-1)).toMatchObject({ page: 1 });
  });

  it('正在请求时连点或回车不取消重发，失败后同条件可重新查询', async () => {
    const scenario = scenarios[3]!;
    await mount(scenario.render());
    let reject!: (reason: Error) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    await submit(scenario);
    await submit(scenario);
    expect(requests('audit')).toHaveLength(2);
    const failure = new Error('模拟读取失败');
    await act(async () => {
      reject(failure);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('连接暂时不可用');
    expect(
      client
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey[1] === 'audit')?.state.error,
    ).toBe(failure);
    const logs = vi.mocked(console.error).mock.calls.filter(([label]) => label === '[Sesame Admin]');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[1]).toMatchObject({ context: 'audit-logs' });
    await submit(scenario);
    expect(requests('audit')).toHaveLength(3);
  });

  it('合法提交立即开始读取，退出取消在途请求且不向新会话延续', async () => {
    await mount(createElement(AuditPage, { active: true }));
    let signal!: AbortSignal;
    let complete!: (value: ReturnType<typeof page>) => void;
    mocks.read.mockImplementationOnce(
      (_name, _query, currentSignal: AbortSignal) =>
        new Promise((resolve) => {
          signal = currentSignal;
          complete = resolve;
        }),
    );
    try {
      await submit(scenarios[3]!);
      expect(requests('audit')).toHaveLength(2);
      expect(signal.aborted).toBe(false);
      act(() => {
        root.unmount();
        unmounted = true;
        client.clear();
      });
      expect(signal.aborted).toBe(true);
      await act(async () => {
        complete(page('audit', { page: 1, page_size: 10 }));
      });
      expect(requests('audit')).toHaveLength(2);
      expect(client.getQueryCache().getAll()).toHaveLength(0);
    } finally {
      complete(page('audit', { page: 1, page_size: 10 }));
    }
  });

  it('非活动页签即使收到表单事件也不读取业务数据', async () => {
    await mount(createElement(AuditPage, { active: false }));
    await submit(scenarios[3]!);
    expect(requests('audit')).toHaveLength(0);
  });

  it('切到非活动页签后不再发起人工查询，不重放已完成的合法提交', async () => {
    await mount(createElement(AuditPage, { active: true }));
    await submit(scenarios[3]!);
    expect(requests('audit')).toHaveLength(2);
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(AuditPage, { active: false })));
    });
    await submit(scenarios[3]!);
    expect(requests('audit')).toHaveLength(2);
  });

  it('内部条件提交失败明确抛出原错误，不伪装成查询成功', async () => {
    let submitQuery!: ReturnType<typeof useListQuerySubmit>;
    const key = ['admin', 'test'];
    /** 只暴露实际Hook，内部状态提交错误不经过网络或页面错误兜底。 */
    function Harness() {
      submitQuery = useListQuerySubmit(key);
      return null;
    }
    await mount(createElement(Harness));
    const failure = new Error('invalid internal condition');
    const refetch = vi.spyOn(client, 'refetchQueries');
    expect(() =>
      submitQuery(key, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(refetch).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
