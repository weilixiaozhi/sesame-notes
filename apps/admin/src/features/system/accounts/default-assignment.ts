import type { api } from '../../../api/client';

type NewAccountGroup = Pick<Parameters<typeof api.adminAccounts.create>[0], 'group_id'>;

/** 新建时未手选就省略组字段，由服务端解析唯一默认组；不发送 null 或客户端固定 ID。 */
export function newAccountGroupSelection(value: string): NewAccountGroup {
  if (typeof value !== 'string') throw new Error('用户组选择无效');
  return value ? { group_id: value } : {};
}
