import { assertUniqueJsonKeys } from '../../lib/transfer/json';
import { z } from 'zod';
import { deltaSchema, fieldsSchema, hasVisibleText, isWellFormed } from './memo-content';
import type { MemoBook, MemoEntry } from './memo-content';

const timestamp = z
  .string()
  .datetime({ precision: 3 })
  .refine((value) => new Date(value).toISOString() === value);
const uuid = z.uuidv4().refine((value) => value === value.toLowerCase());
const entrySchema = z.strictObject({
  source_entry_id: uuid,
  source_book_id: uuid,
  book_type: z.enum(['normal', 'credentials']),
  title: z.string().refine(isWellFormed),
  body_format: z.enum(['delta_v1', 'fields_v1']),
  body: z.record(z.string(), z.unknown()),
  order_key: z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/)
    .nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
const bookSchema = z.strictObject({
  source_book_id: uuid,
  name: z
    .string()
    .refine(hasVisibleText)
    .refine((text) => Array.from(text.trim()).length <= 100),
  type: z.enum(['normal', 'credentials']),
  created_at: timestamp,
  updated_at: timestamp,
  entries: z.array(entrySchema),
});
const documentSchema = z.strictObject({
  format: z.literal('sesame-memos'),
  schema_version: z.literal(2),
  export_id: uuid,
  exported_at: timestamp,
  books: z.array(bookSchema).length(1),
});
export type MemoImportDocument = z.infer<typeof documentSchema>;
type MemoImportEntry = MemoImportDocument['books'][number]['entries'][number];

/** 文件交换协议独立于 HTTP；严格验证后才允许用户预览和创建新记录。 */
export function parseMemoImport(text: string, targetType: MemoBook['type']): MemoImportDocument {
  if (new TextEncoder().encode(text).byteLength > 64 * 1024 * 1024) throw new Error('文件超过 64 MB');
  assertUniqueJsonKeys(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('文件不是有效的 JSON');
  }
  const result = documentSchema.safeParse(parsed);
  if (!result.success) throw new Error('请使用客户端或 Web 导出的 sesame-memos v2 JSON 文件');
  const book = result.data.books[0]!;
  if (book.type !== targetType) throw new Error('文件的本子类型与当前本子不一致，请选择相同类型的本子');
  const ids = new Set<string>();
  for (const entry of book.entries) {
    if (entry.source_book_id !== book.source_book_id || entry.book_type !== book.type || ids.has(entry.source_entry_id))
      throw new Error('文件中的本子归属或条目身份无效');
    ids.add(entry.source_entry_id);
    if (book.type === 'normal') {
      if (entry.body_format !== 'delta_v1' || entry.order_key !== null || !deltaSchema.safeParse(entry.body).success)
        throw new Error('文件包含不支持的富文本正文');
    } else if (
      entry.body_format !== 'fields_v1' ||
      !fieldsSchema.safeParse(entry.body).success ||
      entry.order_key === null ||
      BigInt(entry.order_key) > 9223372036854775807n ||
      (!hasVisibleText(entry.title) && fieldsSchema.parse(entry.body).fields.length === 0)
    )
      throw new Error('文件包含无效的账号卡片');
  }
  return result.data;
}

/** 导入新副本只取内容字段，不携带源账号的同步身份或修订号。 */
export function importedMemoPayload(
  entry: MemoImportEntry,
): Pick<MemoEntry, 'book_type' | 'title' | 'body_format' | 'body' | 'order_key' | 'created_at' | 'updated_at'> {
  return {
    book_type: entry.book_type,
    title: entry.title,
    body_format: entry.body_format,
    body: entry.body,
    order_key: entry.order_key,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}
