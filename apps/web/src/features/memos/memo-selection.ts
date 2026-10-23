import type { QueryClient } from '@tanstack/react-query';
import type { MemoBook } from './memo-content';

type MemoSelection = Partial<Record<MemoBook['type'], string>>;

/** 普通笔记与账号密码分别记住选本，状态随账号查询缓存清除且不写入服务端。 */
export function rememberMemoBook(client: QueryClient, accountId: string, type: MemoBook['type'], id: string): void {
  try {
    const key = ['account', accountId, 'memo-selection'];
    client.setQueryDefaults(key, { gcTime: Infinity });
    client.setQueryData<MemoSelection>(key, (previous) => ({ ...previous, [type]: id }));
  } catch (error) {
    console.error('保存备忘录入口的本子选择失败', { accountId, type, error });
  }
}

/** 读取当前账号在对应入口的选择，调用方仍须用云端目录核对本子是否存在。 */
export function recalledMemoBook(client: QueryClient, accountId: string, type: MemoBook['type']): string | undefined {
  try {
    return client.getQueryData<MemoSelection>(['account', accountId, 'memo-selection'])?.[type];
  } catch (error) {
    console.error('读取备忘录入口的本子选择失败', { accountId, type, error });
    return undefined;
  }
}
