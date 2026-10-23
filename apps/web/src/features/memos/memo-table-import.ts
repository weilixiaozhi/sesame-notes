import { createImportId } from '../../lib/transfer/import-identity';
import { parseMemoImport, type MemoImportDocument } from './memo-import-format';
import { deltaSchema, fieldsSchema, isWellFormed, type MemoBook } from './memo-content';
import { importTimestamp } from '../../lib/transfer/timestamp';
import type { SelectedTable } from '../../lib/transfer/table';
export const memoTableFields = [
  ['title', '标题', ['title', 'name', '名称', '标题']],
  ['body', '正文', ['body', 'content', 'text', '内容', '正文']],
  ['created_at', '创建时间', ['created_at', '创建时间']],
  ['updated_at', '修改时间', ['updated_at', '修改时间']],
] as const;
type MemoTableKey = (typeof memoTableFields)[number][0];
export type MemoTableMapping = Record<MemoTableKey, string>;
/** 文件表头用于建议字段映射，字段值不写入日志。 */
export function detectMemoTableMapping(headers: string[]): MemoTableMapping {
  return Object.fromEntries(
    memoTableFields.map(([key, , aliases]) => [
      key,
      headers.find((header) => aliases.some((alias) => alias.toLowerCase() === header.toLowerCase())) ?? '',
    ]),
  ) as MemoTableMapping;
}
/** 账号卡片常见字段映射到中文语义，其余列名保持原样。 */
export function credentialFieldLabel(header: string): string {
  const names: Record<string, string> = {
    account: '账号',
    username: '账号',
    password: '密码',
    phone: '手机号',
    email: '邮箱',
    note: '备注',
    remark: '备注',
  };
  return Object.hasOwn(names, header.toLowerCase()) ? names[header.toLowerCase()]! : header;
}
/** 表格转换为同一严格交换模型，复用导入身份、正文校验和部分重试流程。 */
export async function mapMemoTable(
  table: SelectedTable,
  mapping: MemoTableMapping,
  fields: Record<string, string>,
  book: MemoBook,
  now: string,
): Promise<MemoImportDocument> {
  if (book.type === 'normal' && !mapping.body) throw new Error('请映射正文列');
  const reserved = new Set([mapping.title, mapping.created_at, mapping.updated_at]);
  const cardFields = Object.entries(fields).filter(([header, label]) => label.trim() && !reserved.has(header));
  if (book.type === 'credentials' && cardFields.length > 20)
    throw new Error('每张账号卡片最多 20 个字段，请调整字段映射');
  const source = await createImportId(book.id, 'memo-table', JSON.stringify({ table, mapping, fields }));
  const sourceBook = await createImportId(book.id, source, 'book');
  const entries = await Promise.all(
    table.rows.map(async (row, index) => {
      const get = (key: MemoTableKey) => (mapping[key] ? (row[table.headers.indexOf(mapping[key])] ?? '') : '');
      try {
        const created = get('created_at') ? importTimestamp(get('created_at')) : now;
        const updated = get('updated_at') ? importTimestamp(get('updated_at')) : created;
        if (updated < created) throw new Error('修改时间不能早于创建时间');
        const text = get('body').replace(/\r\n?/g, '\n');
        const body =
          book.type === 'normal'
            ? { ops: [{ insert: text.endsWith('\n') ? text : `${text}\n` }] }
            : {
                fields: cardFields.map(([header, label]) => ({
                  label: label.trim(),
                  value: row[table.headers.indexOf(header)] ?? '',
                })),
              };
        if (!isWellFormed(get('title'))) throw new Error('标题包含无效字符');
        if (book.type === 'normal' ? !deltaSchema.safeParse(body).success : !fieldsSchema.safeParse(body).success)
          throw new Error('正文或账号字段不符合格式与长度要求');
        return {
          source_entry_id: await createImportId(book.id, source, String(index)),
          source_book_id: sourceBook,
          book_type: book.type,
          title: get('title'),
          body_format: book.type === 'normal' ? 'delta_v1' : 'fields_v1',
          body,
          order_key: book.type === 'credentials' ? String(index) : null,
          created_at: created,
          updated_at: updated,
        };
      } catch (error) {
        throw new Error(`第 ${index + 2} 行：${error instanceof Error ? error.message : '数据无效'}`);
      }
    }),
  );
  return parseMemoImport(
    JSON.stringify({
      format: 'sesame-memos',
      schema_version: 2,
      export_id: source,
      exported_at: now,
      books: [
        { source_book_id: sourceBook, name: book.name, type: book.type, created_at: now, updated_at: now, entries },
      ],
    }),
    book.type,
  );
}
