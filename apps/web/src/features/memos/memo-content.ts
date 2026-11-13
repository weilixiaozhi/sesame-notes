import { z } from 'zod';
import type { components } from '@sesame-notes/api-client';

export type MemoEntry = components['schemas']['MemoEntry'];
export type MemoBook = components['schemas']['MemoBook'];

const attributesSchema = z.strictObject({
  bold: z.boolean().optional(),
  header: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  list: z.enum(['ordered', 'bullet', 'checked', 'unchecked']).optional(),
  indent: z.number().int().min(0).max(5).optional(),
});
/** 图片引用只保存客户端生成的媒体标识，正文不承载地址或字节。 */
const memoImageIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** 单篇正文最多引用 20 张图片，与客户端插入限制一致。 */
const memoImageMaxCount = 20;
const textOpSchema = z
  .strictObject({
    insert: z.string().min(1).refine(isWellFormed),
    attributes: attributesSchema.optional(),
  })
  .refine(
    (op) =>
      !op.attributes ||
      ((!('header' in op.attributes) || !('list' in op.attributes)) &&
        (!['header', 'list', 'indent'].some((key) => key in op.attributes!) || /^\n+$/.test(op.insert))),
  );
/** 图片 op 是严格单键对象，不能携带段落属性或尺寸信息。 */
const imageOpSchema = z.strictObject({ insert: z.strictObject({ memo_image: memoImageIdSchema }) });
export const deltaSchema = z
  .strictObject({
    ops: z.array(z.union([textOpSchema, imageOpSchema])).min(1),
  })
  .refine((delta) => delta.ops.filter((op) => typeof op.insert !== 'string').length <= memoImageMaxCount)
  .refine((delta) => {
    const last = delta.ops.at(-1);
    return typeof last?.insert === 'string' && last.insert.endsWith('\n');
  });
export const fieldsSchema = z.strictObject({
  fields: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(64).refine(hasVisibleText),
        value: z.string().max(2048).refine(isWellFormed),
      }),
    )
    .max(20),
});
export type MemoDelta = z.infer<typeof deltaSchema>;
export type MemoFields = z.infer<typeof fieldsSchema>['fields'];
export const emptyDelta: MemoDelta = { ops: [{ insert: '\n' }] };

/** 拒绝损坏的 UTF-16，避免跨端编码后正文发生变化。 */
export function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** 名称仅校验可见性，字段值和正文保持原样。 */
export function hasVisibleText(value: string): boolean {
  return (
    isWellFormed(value) &&
    Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return (
        !/[\s\p{Cf}\p{Cc}]/u.test(character) &&
        ![0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x2800, 0x3164, 0xffa0].includes(code) &&
        !(code >= 0xfe00 && code <= 0xfe0f)
      );
    })
  );
}
/** 记录错误类型、调用位置和校验路径，日志不包含正文或账号字段值。 */
export function logMemoError(action: string, error: unknown, context: Record<string, string | number> = {}): void {
  try {
    console.error(action, {
      ...context,
      errorType: error instanceof Error ? error.name : typeof error,
      // 异常消息可能包含多行输入值，仅保留运行时生成的调用帧。
      stack:
        error instanceof Error
          ? error.stack
              ?.split('\n')
              .filter((line) => /^\s+at\s/.test(line))
              .join('\n')
          : undefined,
      issues: error instanceof z.ZodError ? error.issues.map(({ code, path }) => ({ code, path })) : undefined,
    });
  } catch {
    // 日志输出失败时保持原有错误处理流程可用。
  }
}

/** 提取正文引用的图片标识，去重并保持出现顺序，供导出预加载与渲染使用。 */
export function memoImageIds(body: unknown): string[] {
  const parsed = deltaSchema.safeParse(body);
  if (!parsed.success) return [];
  const ids = new Set<string>();
  for (const op of parsed.data.ops) {
    if (typeof op.insert !== 'string') ids.add(op.insert.memo_image);
  }
  return [...ids];
}

/** 账号卡片直接展示字段，普通笔记摘要跳过与外部标题相同的正文首行。 */
export function memoPreview(entry: Pick<MemoEntry, 'book_type' | 'body' | 'title'>): string {
  if (entry.book_type === 'credentials') {
    const parsed = fieldsSchema.safeParse(entry.body);
    return parsed.success
      ? parsed.data.fields
          .map((field) => `${field.label}：${field.value}`)
          .join('\n')
          .slice(0, 180)
      : '字段格式暂不支持，请在客户端查看';
  }
  const parsed = deltaSchema.safeParse(entry.body);
  if (!parsed.success) return '正文格式暂不支持，请在客户端查看';
  // 图片 op 不产生摘要文字，只拼接文字 op。
  const lines = parsed.data.ops
    .flatMap((op) => (typeof op.insert === 'string' ? [op.insert] : []))
    .join('')
    .trim()
    .split('\n');
  // 只跳过首行重复标题，正文中其余同名段落仍保留在摘要中。
  if (entry.title.trim() && lines[0]?.trim() === entry.title.trim()) lines.shift();
  return lines.join('\n').trim().slice(0, 180);
}
