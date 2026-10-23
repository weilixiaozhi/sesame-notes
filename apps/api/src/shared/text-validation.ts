import { ApiError } from './errors.js';

/** 固定不可见字符集合供名称校验复用，保留输入原值而不修剪或改写。 */
export function hasVisibleText(value: string): boolean {
  if (!value.isWellFormed()) return false;
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- 此处逐个排除独立不可见码点，不匹配组合字形。
  return /[^\s\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFFA0]/u.test(
    value,
  );
}

/** 普通名称在所有业务共用同一规范；密码与正文不经过此入口。 */
export const MAX_NAME_LENGTH = 100;
// Unicode White_Space 加 BOM，与移动端和日子数据库约束一致。
const NAME_EDGE_WHITESPACE =
  // eslint-disable-next-line no-control-regex -- 固定空白字符集合。
  /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$/gu;
export function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_NAME', '请输入名称');
  const name = value.replace(NAME_EDGE_WHITESPACE, '');
  if (!hasVisibleText(name) || Array.from(name).length > MAX_NAME_LENGTH || name.includes('\u0000'))
    throw new ApiError(400, 'INVALID_NAME', `名称需包含可见文字，且不超过 ${MAX_NAME_LENGTH} 个字符`);
  return name;
}
