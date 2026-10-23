import type { Group } from '../api/types';

export type GroupChoice = Pick<Group, 'id' | 'name' | 'is_default'>;

/** 默认属性来自服务端标志，组名修改不会改变默认身份。 */
export function groupChoiceLabel(group: GroupChoice): string {
  return `${group.name}${group.is_default ? '（默认）' : ''}`;
}

/** 未手动选择时说明服务器自动分配，读取到名称后使用实际默认组名称。 */
export function automaticGroupLabel(group?: GroupChoice): string {
  return `${group?.name ?? '默认分组'}（自动）`;
}

/** 新建的自动默认选项已代表默认组，编辑和筛选仍保留其显式选项。 */
export function showExplicitGroup(group: GroupChoice, automaticDefault: boolean): boolean {
  return !automaticDefault || !group.is_default;
}
