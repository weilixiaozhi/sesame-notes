import { expect, it } from 'vitest';
import { credentialMarkdown, credentialDocumentNode, credentialDocx } from './memo-credential-export';
import type { MemoEntry, MemoBook } from './memo-content';
const book: MemoBook = {
  id: 'book',
  sync_id: 'sync',
  name: '测试账号本',
  type: 'credentials',
  revision: 1,
  deleted_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const entry: MemoEntry = {
  id: 'first',
  memo_book_id: 'book',
  sync_id: 'sync',
  revision: 1,
  deleted_at: null,
  created_at: book.created_at,
  updated_at: book.updated_at,
  book_updated_at: book.updated_at,
  book_type: 'credentials',
  title: '卡片一',
  body_format: 'fields_v1',
  body: { fields: [{ label: '密码', value: 'fake-secret-one' }] },
  order_key: '1',
};

const second: MemoEntry = {
  ...entry,
  id: 'second',
  title: '卡片二',
  body: { fields: [{ label: '账号', value: 'fake-account-two' }] },
  order_key: '2',
};

it('合并格式保留卡片顺序、中文和内容，只导出给定集合', async () => {
  const text = credentialMarkdown([second, entry]);
  expect(text.indexOf('卡片二')).toBeLessThan(text.indexOf('卡片一'));
  expect(credentialMarkdown([second])).not.toContain('fake-secret-one');
  const node = credentialDocumentNode(document, '私密文档', [second]);
  expect(node.textContent).toContain('fake-account-two');
  expect(node.textContent).not.toContain('fake-secret-one');
  const blob = await credentialDocx('私密文档', [second, entry]);
  expect(blob.size).toBeGreaterThan(1000);
});
