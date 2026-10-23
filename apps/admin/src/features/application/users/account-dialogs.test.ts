// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDetail } from '../../../api/types';
import { ChangeAvatarDialog, ChangePhoneDialog, DeleteAvatarDialog, ResetPasswordDialog } from './account-dialogs';
import { UsersPage } from './index';

const mocks = vi.hoisted(() => ({
  changePhone: vi.fn(),
  resetPassword: vi.fn(),
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
  invalidateQueries: vi.fn(),
  reportError: vi.fn(),
  permissions: ['users:read', 'users:write'],
  query: vi.fn(),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: mocks.query,
}));
vi.mock('../../../api/client', () => ({
  api: { adminUsers: mocks },
  InputError: class extends Error {},
  request: (operation: () => unknown) => operation(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : '操作失败'),
  reportError: mocks.reportError,
}));
vi.mock('../../../auth/session', () => ({
  queryClient: { invalidateQueries: mocks.invalidateQueries },
  useSession: () => ({ session: { admin: { permissions: mocks.permissions } } }),
}));

const user: UserDetail = {
  id: 'user-1',
  phone: '+8613812345678',
  phone_masked: '+86 138****5678',
  sesame_number: '100000001',
  display_name: '测试用户',
  gender: 'UNSPECIFIED',
  is_enabled: true,
  created_at: '2026-10-10T00:00:00Z',
  avatar_url: '/api/v1/admin/users/user-1/avatar?v=3',
  avatar_version: 3,
  profile_updated_at: null,
  primary_currency: 'CNY',
  theme_primary_color: null,
};
let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const onClose = vi.fn();
const onSaved = vi.fn();

/** 使用真实 React 和 Radix 弹窗验证填写、确认与关闭行为。 */
async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient }, element)));
}

/** 按可见字段文字定位表单元素，避免依赖实现内部状态。 */
function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(label: string): T {
  const element = Array.from(document.querySelectorAll('label')).find((candidate) =>
    candidate.textContent?.startsWith(label),
  );
  return element!.querySelector('input,select,textarea') as T;
}

/** 触发浏览器原生输入事件，使受控字段与真实使用方式一致。 */
async function fill(label: string, value: string): Promise<void> {
  await act(async () => {
    const input = field(label);
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** 根据用户可见按钮名称触发操作。 */
async function click(text: string): Promise<void> {
  await act(async () => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === text);
    expect(button).toBeDefined();
    button!.click();
  });
}

/** 模拟本地文件选择，保留文件异步读取而不产生网络请求。 */
async function choose(bytes: Promise<ArrayBuffer>): Promise<void> {
  await act(async () => {
    const file = new File(['image'], 'avatar.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => bytes });
    const input = field<HTMLInputElement>('选择图片');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.permissions = ['users:read', 'users:write'];
  mocks.query.mockReturnValue({ data: user, isPending: false, isError: false });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('应用用户后台设置', () => {
  it('用户列表显示服务端头像，未设置头像的用户显示默认图标', async () => {
    mocks.query.mockReturnValue({
      data: {
        items: [user, { ...user, id: 'user-2', avatar_url: null, avatar_version: 0 }],
        page: 1,
        page_size: 10,
        total: 2,
      },
      isPending: false,
      isError: false,
    });
    await render(createElement(UsersPage, { active: true, navigate: vi.fn() }));
    expect(container.querySelector('th')?.textContent).toBe('头像');
    const avatars = container.querySelectorAll('td[data-label="头像"]');
    expect(avatars).toHaveLength(2);
    expect(avatars[0]?.querySelector('img')?.getAttribute('src')).toBe(user.avatar_url);
    expect(avatars[1]?.querySelector('[aria-label="默认用户头像"]')).not.toBeNull();
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it('用户列表头像读取失败会记录日志并回退，新版本到达后恢复显示', async () => {
    mocks.query.mockReturnValue({
      data: { items: [user], page: 1, page_size: 10, total: 1 },
      isPending: false,
      isError: false,
    });
    await render(createElement(UsersPage, { active: true, navigate: vi.fn() }));
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[aria-label="头像暂时无法显示"]')).not.toBeNull();
    expect(mocks.reportError).toHaveBeenCalledWith('user-avatar-image', expect.any(Error));
    mocks.query.mockReturnValue({
      data: {
        items: [{ ...user, avatar_version: 4, avatar_url: '/api/v1/admin/users/user-1/avatar?v=4' }],
        page: 1,
        page_size: 10,
        total: 1,
      },
      isPending: false,
      isError: false,
    });
    await render(createElement(UsersPage, { active: true, navigate: vi.fn() }));
    expect(container.querySelector('img')?.getAttribute('src')).toContain('v=4');
  });

  it('列表不会向后台头像接口范围之外的地址发送图片请求', async () => {
    mocks.query.mockReturnValue({
      data: {
        items: [{ ...user, avatar_url: 'https://untrusted.example/avatar.png' }],
        page: 1,
        page_size: 10,
        total: 1,
      },
      isPending: false,
      isError: false,
    });
    await render(createElement(UsersPage, { active: true, navigate: vi.fn() }));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[aria-label="默认用户头像"]')).not.toBeNull();
  });

  it('只读管理员不能看到头像、换绑或密码写入口，有权限才显示', async () => {
    mocks.permissions = ['users:read'];
    await render(createElement(UsersPage, { active: true, userId: user.id, navigate: vi.fn() }));
    for (const text of ['更换头像', '恢复默认头像', '换绑手机号', '重置密码'])
      expect(container.textContent).not.toContain(text);
    mocks.permissions = ['users:read', 'users:write'];
    await render(createElement(UsersPage, { active: true, userId: user.id, navigate: vi.fn() }));
    for (const text of ['更换头像', '恢复默认头像', '换绑手机号', '重置密码'])
      expect(container.textContent).toContain(text);
  });

  it('头像曾加载失败后，服务器返回新头像版本时可再次显示', async () => {
    await render(createElement(UsersPage, { active: true, userId: user.id, navigate: vi.fn() }));
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    mocks.query.mockReturnValue({
      data: { ...user, avatar_version: 4, avatar_url: '/api/v1/admin/users/user-1/avatar?v=4' },
      isPending: false,
      isError: false,
    });
    await render(createElement(UsersPage, { active: true, userId: user.id, navigate: vi.fn() }));
    expect(container.querySelector('img')?.getAttribute('src')).toContain('v=4');
  });

  it('区号为默认 +86 的选择器，原因必填且换绑携带原手机号', async () => {
    await render(createElement(ChangePhoneDialog, { user, onClose, onSaved }));
    expect(field('国家或地区区号')).toBeInstanceOf(HTMLSelectElement);
    expect(field('国家或地区区号').value).toBe('+86');
    await fill('新手机号', '139 1234 5678');
    await click('确认换绑');
    expect(document.body.textContent).toContain('请填写操作原因');
    expect(mocks.changePhone).not.toHaveBeenCalled();
    await fill('操作原因', '用户要求更新绑定');
    await click('确认换绑');
    expect(mocks.changePhone).toHaveBeenCalledWith(user.id, {
      country_code: '+86',
      phone: '13912345678',
      current_phone: user.phone,
      reason: '用户要求更新绑定',
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['admin', 'users'] });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('手机号未变不发送换绑请求', async () => {
    await render(createElement(ChangePhoneDialog, { user, onClose, onSaved }));
    await fill('新手机号', '13812345678');
    await fill('操作原因', '核对号码');
    await click('确认换绑');
    expect(mocks.changePhone).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('新手机号与当前手机号相同');
  });

  it('新密码确认匹配后才提交，网络失败也清空两个密码输入并保留可见错误', async () => {
    mocks.resetPassword.mockRejectedValueOnce(new Error('稍后重试'));
    await render(createElement(ResetPasswordDialog, { user, onClose, onSaved }));
    expect(field('新密码').value).toBe('');
    await fill('新密码', ' a ');
    await fill('确认新密码', 'a');
    await fill('操作原因', '协助用户恢复登录');
    await click('确认重置密码');
    expect(mocks.resetPassword).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('两次输入的新密码不一致');
    await fill('确认新密码', ' a ');
    await click('确认重置密码');
    expect(mocks.resetPassword).toHaveBeenCalledWith(user.id, { new_password: ' a ', reason: '协助用户恢复登录' });
    expect(field('新密码').value).toBe('');
    expect(field('确认新密码').value).toBe('');
    expect(document.body.textContent).toContain('稍后重试');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('选择图片仅本地预览，确认后携带头像版本并刷新用户数据', async () => {
    await render(createElement(ChangeAvatarDialog, { user, onClose, onSaved }));
    await choose(Promise.resolve(new Uint8Array([1, 2, 3]).buffer));
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AQID');
    expect(mocks.uploadAvatar).not.toHaveBeenCalled();
    await fill('操作原因', '用户提供新头像');
    await click('保存头像');
    expect(mocks.uploadAvatar).toHaveBeenCalledWith(user.id, {
      content_type: 'image/png',
      data_base64: 'AQID',
      avatar_version: 3,
      reason: '用户提供新头像',
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['admin', 'users'] });
  });

  it('连续选择图片时迟到的旧读取不能覆盖新预览或上传内容', async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    const first = new Promise<ArrayBuffer>((resolve) => {
      finish = resolve;
    });
    await render(createElement(ChangeAvatarDialog, { user, onClose, onSaved }));
    await choose(first);
    await choose(Promise.resolve(new Uint8Array([4, 5, 6]).buffer));
    await act(async () => finish(new Uint8Array([1, 2, 3]).buffer));
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,BAUG');
    await fill('操作原因', '更新头像');
    await click('保存头像');
    expect(mocks.uploadAvatar.mock.calls[0]![1].data_base64).toBe('BAUG');
  });

  it('恢复默认头像要求原因并携带原头像版本', async () => {
    await render(createElement(DeleteAvatarDialog, { user, onClose, onSaved }));
    await fill('操作原因', '用户要求移除头像');
    await click('确认恢复默认头像');
    expect(mocks.deleteAvatar).toHaveBeenCalledWith(user.id, { avatar_version: 3, reason: '用户要求移除头像' });
    expect(onSaved).toHaveBeenCalledWith('已恢复默认头像。');
  });
});
