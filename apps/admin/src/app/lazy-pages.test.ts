// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { App } from './index';

const mocks = vi.hoisted(() => ({
  loads: [] as string[],
  mounts: {} as Record<string, number>,
  unmounts: {} as Record<string, number>,
  accountsGate: null as Promise<void> | null,
  personalGate: null as Promise<void> | null,
  session: {
    phase: 'anonymous',
    epoch: 0,
    message: '',
    session: {
      admin: {
        id: 'admin-a',
        username: 'admin-a',
        display_name: '管理员甲',
        is_enabled: true,
        identity_type: 'super_admin',
        permissions: [] as string[],
        allowed_pages: [] as string[],
        group: { is_enabled: true },
      },
    },
  },
}));
vi.mock('../auth/session', () => ({ useSession: () => mocks.session }));
vi.mock('../api/client', () => ({ reportError: vi.fn(), errorMessage: () => '读取失败' }));
vi.mock('../features/authentication', () => ({ LoginPage: () => createElement('p', null, '登录后台') }));
vi.mock('../features/application/users', () => ({ UsersPage: testPage('users') }));
vi.mock('../features/system/accounts', async () => {
  await mocks.accountsGate;
  return { AccountsPage: testPage('accounts') };
});
vi.mock('../features/system/groups', () => ({ GroupsPage: testPage('groups') }));
vi.mock('../features/system/operation-logs', () => ({ AuditPage: testPage('audit') }));
vi.mock('../features/analytics/overview', () => ({ AnalyticsOverview: testPage('overview') }));
vi.mock('../features/analytics/events', () => ({ EventAnalysis: testPage('events') }));
vi.mock('../features/analytics/tracking', () => ({ TrackingManagement: testPage('tracking') }));
vi.mock('../features/fitness', () => ({ FitnessManagementPage: testPage('fitness') }));
vi.mock('../features/personal/security', async () => {
  await mocks.personalGate;
  return { PersonalCenter: testPage('personal') };
});

/** 模拟模块只在真实动态导入时执行；组件通过本地草稿与挂载记录暴露生命周期。 */
function testPage(name: string) {
  mocks.loads.push(name);
  /** 页签状态必须随隐藏保留，权限工作区重挂时必须销毁。 */
  function Page({ active, onClose }: { active?: boolean; onClose?: () => void }) {
    const [draft, setDraft] = useState('');
    useEffect(() => {
      mocks.mounts[name] = (mocks.mounts[name] ?? 0) + 1;
      return () => {
        mocks.unmounts[name] = (mocks.unmounts[name] ?? 0) + 1;
      };
    }, []);
    return createElement(
      'div',
      { 'data-page': name, 'data-active': String(active) },
      createElement('input', {
        'aria-label': `${name}草稿`,
        value: draft,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
      }),
      onClose ? createElement('button', { onClick: onClose }, '关闭个人中心') : null,
    );
  }
  return Page;
}

/** 等待本地模块导入和 React 提交，不启动浏览器或访问网络。 */
async function settleImports(): Promise<void> {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

/** 触发真实页面按钮并等待 React 状态更新。 */
async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

it('页面按访问加载，页签局部挂起保留草稿，个人中心可取消，权限代次销毁全部页面状态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  /** 同一路由容器保留页签导航，登录进入工作区时只重建一次容器。 */
  async function render(key: string, path: string): Promise<void> {
    await act(async () => {
      root.render(createElement(MemoryRouter, { key, initialEntries: [path] }, createElement(App)));
    });
  }
  try {
    await render('login', '/login');
    expect(mocks.loads).toEqual([]);
    mocks.session.phase = 'authenticated';
    await render('workspace', '/application/users');
    await settleImports();
    expect(mocks.loads).toEqual(['users']);
    const draft = container.querySelector<HTMLInputElement>('[aria-label="users草稿"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(draft, '保留我的筛选');
      draft.dispatchEvent(new Event('input', { bubbles: true }));
    });

    let releaseAccounts!: () => void;
    mocks.accountsGate = new Promise((resolve) => {
      releaseAccounts = resolve;
    });
    const navigation = container.querySelector('nav[aria-label="管理后台导航"]')!;
    const accountButton = [...navigation.querySelectorAll('button')].find(
      (button) => button.textContent === '后台用户',
    )!;
    await click(accountButton);
    expect(container.querySelector('#panel-accounts')!.textContent).toContain('正在打开后台用户');
    expect(container.querySelector('#panel-users [data-active="false"]')).not.toBeNull();
    expect(mocks.unmounts.users ?? 0).toBe(0);
    releaseAccounts();
    await settleImports();
    expect(mocks.loads).toEqual(['users', 'accounts']);
    await click(container.querySelector<HTMLButtonElement>('#tab-users')!);
    expect(container.querySelector<HTMLInputElement>('[aria-label="users草稿"]')!.value).toBe('保留我的筛选');
    expect(mocks.mounts.users).toBe(1);
    expect(container.querySelector('#panel-accounts [data-active="false"]')).not.toBeNull();

    let releasePersonal!: () => void;
    mocks.personalGate = new Promise((resolve) => {
      releasePersonal = resolve;
    });
    expect(mocks.loads).not.toContain('personal');
    await click(container.querySelector<HTMLButtonElement>('.profile-trigger')!);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('正在打开个人中心');
    await click(document.querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')!);
    releasePersonal();
    await settleImports();
    expect(mocks.loads).toContain('personal');
    expect(mocks.mounts.personal ?? 0).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(container.querySelector<HTMLButtonElement>('.profile-trigger')!);
    await settleImports();
    expect(mocks.mounts.personal).toBe(1);

    mocks.session.epoch += 1;
    mocks.session.session.admin = {
      ...mocks.session.session.admin,
      id: 'admin-b',
      username: 'admin-b',
      display_name: '管理员乙',
      identity_type: 'standard_user',
      permissions: ['users:read'],
      allowed_pages: ['users'],
    };
    await render('workspace', '/application/users');
    await settleImports();
    expect(mocks.unmounts.users).toBe(1);
    expect(mocks.unmounts.accounts).toBe(1);
    expect(mocks.unmounts.personal).toBe(1);
    expect(mocks.mounts.users).toBe(2);
    expect(container.querySelector<HTMLInputElement>('[aria-label="users草稿"]')!.value).toBe('');
    expect(container.querySelector('#tab-accounts')).toBeNull();
    expect(mocks.loads).not.toContain('groups');
    expect(mocks.loads).not.toContain('fitness');
    expect(mocks.loads).not.toContain('overview');
    expect(mocks.loads).not.toContain('events');
    expect(mocks.loads).not.toContain('tracking');
    expect(mocks.loads).not.toContain('audit');
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});
