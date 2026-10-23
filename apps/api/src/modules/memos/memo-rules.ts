import { ApiError } from '../../shared/errors.js';
import { parseStrictTimestamp } from '../../shared/contracts/scalars.js';
import { hasVisibleText } from '../../shared/text-validation.js';
import { Value } from '@sinclair/typebox/value';
import { Type } from '@sinclair/typebox';
import { MemoEntryPayloadSchema, type MemoEntryPayload } from './memo-schemas.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** delta_v1 只保存完整文字文档；拒绝未知格式，不修剪或改写正文。 */
export function validateMemoDelta(value: unknown): void {
  const fail = (): never => {
    throw new ApiError(400, 'INVALID_MEMO_DELTA', '备忘录正文格式无效');
  };
  if (!isObject(value) || Object.keys(value).some((key) => key !== 'ops')) return fail();
  const ops = value.ops;
  if (!Array.isArray(ops) || ops.length === 0) return fail();
  for (const op of ops) {
    if (!isObject(op) || Object.keys(op).some((key) => key !== 'insert' && key !== 'attributes')) return fail();
    if (typeof op.insert !== 'string' || op.insert.length === 0 || !op.insert.isWellFormed()) return fail();
    if (!Object.hasOwn(op, 'attributes')) continue;
    const attributes = op.attributes;
    if (!isObject(attributes)) return fail();
    for (const [key, attribute] of Object.entries(attributes)) {
      if (key === 'bold') {
        if (typeof attribute !== 'boolean') return fail();
      } else if (key === 'header') {
        if (![1, 2, 3].includes(attribute as number)) return fail();
      } else if (key === 'list') {
        if (!['ordered', 'bullet', 'checked', 'unchecked'].includes(attribute as string)) return fail();
      } else if (key === 'indent') {
        if (typeof attribute !== 'number' || !Number.isInteger(attribute) || attribute < 0 || attribute > 5)
          return fail();
      } else return fail();
    }
    // 段落格式只归属于换行，标题与列表不能同时定义同一行。
    if (['header', 'list', 'indent'].some((key) => Object.hasOwn(attributes, key)) && !/^\n+$/.test(op.insert))
      return fail();
    if (Object.hasOwn(attributes, 'header') && Object.hasOwn(attributes, 'list')) return fail();
  }
  const last = ops.at(-1) as Record<string, unknown>;
  if (!(last.insert as string).endsWith('\n')) return fail();
}

const MEMO_FIELD_MAX = 20;
const MEMO_LABEL_MAX = 64;
const MEMO_VALUE_MAX = 2048;

/** fields_v1 只保存有名字段的键值对：字段名必须可见，值允许为空串。 */
export function validateMemoFields(value: unknown): Array<Record<string, unknown>> {
  const fail = (): never => {
    throw new ApiError(400, 'INVALID_MEMO_FIELDS', '账号密码字段无效');
  };
  if (!isObject(value) || Object.keys(value).some((key) => key !== 'fields')) return fail();
  const fields = value.fields;
  if (!Array.isArray(fields) || fields.length > MEMO_FIELD_MAX) return fail();
  const checked: Array<Record<string, unknown>> = [];
  for (const field of fields) {
    if (!isObject(field) || Object.keys(field).some((key) => key !== 'label' && key !== 'value')) return fail();
    const { label, value: text } = field;
    if (typeof label !== 'string' || typeof text !== 'string') return fail();
    if (!label.isWellFormed() || !text.isWellFormed()) return fail();
    if (!hasVisibleText(label) || label.length > MEMO_LABEL_MAX || text.length > MEMO_VALUE_MAX) return fail();
    checked.push(field);
  }
  return checked;
}

export const memoTimestamp = (value: unknown): Date =>
  parseStrictTimestamp(value, 'INVALID_MEMO_TIME', '备忘录时间无效');
// 日期由 memoTimestamp 严格校验；TypeBox Value 不依赖 Fastify 的格式注册表。
const StaticMemoEntrySchema = Type.Object({
  ...MemoEntryPayloadSchema.properties,
  created_at: Type.String(),
  updated_at: Type.String(),
});
export function validateMemoEntry(value: unknown): MemoEntryPayload {
  if (
    !Value.Check(StaticMemoEntrySchema, value) ||
    Object.keys(value).some((key) => !(key in MemoEntryPayloadSchema.properties))
  )
    throw new ApiError(400, 'INVALID_MEMO_ENTRY', '备忘录字段无效');
  memoTimestamp(value.created_at);
  memoTimestamp(value.updated_at);
  if (!value.title.isWellFormed()) throw new ApiError(400, 'INVALID_MEMO_ENTRY', '备忘录字段无效');
  if (value.book_type === 'credentials') {
    // 字段格式与顺序号是卡片的结构约束；字段内容由 validateMemoFields 逐项校验。
    if (value.body_format !== 'fields_v1') throw new ApiError(400, 'INVALID_MEMO_CARD', '账号卡片字段无效');
    const fields = validateMemoFields(value.body);
    if (value.order_key === null || BigInt(value.order_key) > 9223372036854775807n)
      throw new ApiError(400, 'INVALID_MEMO_CARD', '账号卡片字段无效');
    // 名称与字段都为空时卡片既无标题也无内容，拒绝落库。
    if (!hasVisibleText(value.title) && fields.length === 0)
      throw new ApiError(400, 'INVALID_MEMO_CARD', '账号卡片字段无效');
  } else {
    if (value.body_format !== 'delta_v1' || value.order_key !== null)
      throw new ApiError(400, 'INVALID_MEMO_NOTE', '笔记字段无效');
    validateMemoDelta(value.body);
  }
  return value;
}
