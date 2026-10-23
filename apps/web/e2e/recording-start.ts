import { expect, type Page } from '@playwright/test';

const recordingEntrances = {
  accounting: { ready: '当前账本', start: '记第一笔', editor: '记一笔' },
  memos: { ready: '备忘录本', start: '写第一条备忘录', editor: '写一条备忘录' },
  credentials: { ready: '账号密码本', start: '新建账号卡片', editor: '新建账号卡片' },
  days: { ready: '日子本', start: '添加第一个日子', editor: '添加一个重要日子' },
  fitness: { ready: '健身空间', start: '开始第一次训练', editor: '安排训练' },
} as const;

/** 空目录先走真实首次记录入口并取消空白草稿，已有本子时保留当前选择与内容。 */
export async function ensureRecordingStarted(page: Page, kind: keyof typeof recordingEntrances): Promise<void> {
  try {
    const activeKind = kind === 'memos' && new URL(page.url()).pathname === '/credentials' ? 'credentials' : kind;
    const entrance = recordingEntrances[activeKind];
    const ready = page.getByRole('group', { name: entrance.ready, exact: true }).locator('button[aria-pressed="true"]');
    const start = page.getByRole('button', { name: entrance.start, exact: true });
    await expect(ready.or(start).first()).toBeVisible();
    if (await ready.isVisible()) return;

    await start.click();
    const editor = page.getByRole('dialog', { name: entrance.editor, exact: true });
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(ready).toBeVisible();
  } catch (error) {
    console.error('端到端测试的首次记录准备失败', { kind, error });
    throw error;
  }
}

/** 仅在管理面板收起时打开，避免后续创建、导入或删除误把面板收回。 */
export async function openBookManagement(page: Page, kind: keyof typeof recordingEntrances): Promise<void> {
  try {
    const labels = {
      accounting: '账本管理',
      memos: '本子管理',
      credentials: '本子管理',
      days: '日子本管理',
      fitness: '空间管理',
    };
    const trigger = page.getByRole('button', { name: labels[kind], exact: true });
    await expect(trigger).toBeVisible();
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    await expect(page.getByRole('region', { name: labels[kind], exact: true })).toBeVisible();
  } catch (error) {
    console.error('端到端测试打开本子管理失败', { kind, error });
    throw error;
  }
}
