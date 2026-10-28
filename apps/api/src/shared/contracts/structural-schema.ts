import { CloneType, type TSchema } from '@sinclair/typebox';

/** 保留原始 JSON 的结构约束；日期格式与名称码点长度交给调用方的领域规则验证。 */
export function structuralSchema(schema: TSchema): TSchema {
  const result = CloneType(schema);
  /** 逐层移除格式器与名称 UTF-16 长度限制，结构校验本身不转换或删除输入字段。 */
  function visit(value: unknown, name = false): void {
    if (!value || typeof value !== 'object') return;
    if ('format' in value) delete value.format;
    if (name && 'maxLength' in value) delete value.maxLength;
    for (const [key, nested] of Object.entries(value)) visit(nested, name || key === 'name' || key.endsWith('_name'));
  }
  visit(result);
  return result;
}
