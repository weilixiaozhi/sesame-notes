import { Component, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FitnessTransferDialog } from './fitness-transfer-content';
import type { FitnessSpace } from '../fitness-types';

vi.mock('../../../lib/session', () => ({
  useSession: () => ({ session: { user: { user_id: 'account' } } }),
  captureSessionOperation: () => ({
    signal: new AbortController().signal,
    assertCurrent: () => undefined,
    client: {},
  }),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock('../official-catalog', () => ({ loadOfficialCatalog: async () => ({ exercises: [] }) }));

/** 渲染错误代表整个应用退出业务页面，与对话框内可修正的文件错误区分。 */
class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  /** 仅在 React 渲染失败时展示测试兜底页面。 */
  static getDerivedStateFromError() {
    return { failed: true };
  }

  /** 保留真实导入界面供测试读取文件和修改映射。 */
  render() {
    return this.state.failed ? <p>业务页面崩溃</p> : this.props.children;
  }
}

it('损坏的结构单元格留在导入弹窗，调整映射后可继续校验', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const space: FitnessSpace = {
    id: 'space',
    sync_id: 'sync',
    name: '测试空间',
    revision: 1,
    entity_count: 0,
    deleted_at: null,
    created_at: '2026-10-22T00:00:00.000Z',
    updated_at: '2026-10-22T00:00:00.000Z',
  };
  const file = new File(['数据类型,名称,动作与组\n模板,测试,无效JSON'], 'fitness.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => '数据类型,名称,动作与组\n模板,测试,无效JSON' });
  const view = render(
    <RenderBoundary>
      <QueryClientProvider client={client}>
        <FitnessTransferDialog space={space} onClose={() => undefined} />
      </QueryClientProvider>
    </RenderBoundary>,
  );
  try {
    fireEvent.change(screen.getByLabelText('选择健身文件'), { target: { files: [file] } });
    await screen.findByText('动作结构字段不是有效的 JSON，请检查文件或调整字段对应关系。');
    expect(screen.queryByText('业务页面崩溃')).toBeNull();
    expect((screen.getByRole('button', { name: '校验并预览' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('动作与组'), { target: { value: '' } });
    expect(screen.queryByText('动作结构字段不是有效的 JSON，请检查文件或调整字段对应关系。')).toBeNull();
    expect((screen.getByRole('button', { name: '校验并预览' }) as HTMLButtonElement).disabled).toBe(false);
  } finally {
    view.unmount();
    client.clear();
    log.mockRestore();
  }
});
