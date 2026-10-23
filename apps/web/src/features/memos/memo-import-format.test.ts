import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertUniqueJsonKeys } from '../../lib/transfer/json';
import { createImportId } from '../../lib/transfer/import-identity';
import { parseMemoImport } from './memo-import-format';

const bookId = '1775f9e0-bc7d-4915-9d64-e6efce77d2f2';
const entryId = '28311426-261b-40cb-abed-ac0131a0b26d';
const exportId = '38311426-261b-40cb-abed-ac0131a0b26d';
const time = '2026-01-01T00:00:00.000Z';
const document = {
  format: 'sesame-memos',
  schema_version: 2,
  export_id: exportId,
  exported_at: time,
  books: [
    {
      source_book_id: bookId,
      name: '导入测试',
      type: 'normal',
      created_at: time,
      updated_at: time,
      entries: [
        {
          source_entry_id: entryId,
          source_book_id: bookId,
          book_type: 'normal',
          title: '中文记录',
          body_format: 'delta_v1',
          body: { ops: [{ insert: '文本\n' }] },
          order_key: null,
          created_at: time,
          updated_at: time,
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

describe('客户端格式导入', () => {
  it('合法v2文件通过，不改写正文', () => {
    expect(parseMemoImport(JSON.stringify(document), 'normal')).toEqual(document);
  });
  it('拒绝目标类型错配、其他版本和不兼容来源身份', () => {
    expect(() => parseMemoImport(JSON.stringify(document), 'credentials')).toThrow('类型');
    expect(() => parseMemoImport(JSON.stringify({ ...document, schema_version: 1 }), 'normal')).toThrow('v2');
    expect(() =>
      parseMemoImport(JSON.stringify({ ...document, export_id: exportId.replace('-40cb-', '-50cb-') }), 'normal'),
    ).toThrow();
  });
  it('拒绝正文中的重复JSON键，包括转义键', () => {
    expect(() => assertUniqueJsonKeys('{"x":1,"x":2}')).toThrow('重复');
    expect(() => assertUniqueJsonKeys('{"body":{"a":1,"\\u0061":2}}')).toThrow('重复');
    expect(() => assertUniqueJsonKeys('{"body":[{"a":1},{"a":2}]}')).not.toThrow();
  });
  it('拒绝重复条目与不属于源本的记录', () => {
    const book = document.books[0]!;
    expect(() =>
      parseMemoImport(
        JSON.stringify({ ...document, books: [{ ...book, entries: [...book.entries, ...book.entries] }] }),
        'normal',
      ),
    ).toThrow('身份');
    expect(() =>
      parseMemoImport(
        JSON.stringify({
          ...document,
          books: [{ ...book, entries: [{ ...book.entries[0], source_book_id: exportId }] }],
        }),
        'normal',
      ),
    ).toThrow('归属');
  });
  it('同来源同目标有稳定且兼容移动端v4校验的身份，目标间隔离', async () => {
    const first = await createImportId(bookId, exportId, entryId);
    expect(first).toBe(await createImportId(bookId, exportId, entryId));
    expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(first).not.toBe(await createImportId(exportId, exportId, entryId));
  });

  it('摘要计算失败保留原始错误，交给导入入口处理而不在内部重复日志', async () => {
    const failure = new Error('digest unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn().mockRejectedValue(failure) } });
    try {
      await expect(createImportId(bookId, exportId, entryId)).rejects.toBe(failure);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
