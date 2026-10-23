import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { detectMemoTableMapping, mapMemoTable, credentialFieldLabel } from './memo-table-import';
import { mapDayRows, detectDayMapping } from '../days/day-import-format';
import { parseJsonTables, selectTable } from '../../lib/transfer/table';
import type { MemoBook } from './memo-content';
const now = '2026-09-30T00:00:00.000Z';
const book: MemoBook = {
  id: 'cf9b3091-8f55-48f9-997e-a7624a47947b',
  name: '测试本',
  type: 'normal',
  sync_id: 'b7ed5383-a523-4c7d-8019-cf21eac01d93',
  revision: 1,
  created_at: now,
  updated_at: now,
  deleted_at: null,
};
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
describe('普通备忘录与私密卡片表格映射', () => {
  it('普通正文规范化CRLF并追加结束换行，重复映射身份稳定', async () => {
    const table = { headers: ['title', 'body'], rows: [['标题', '第一行\r\n第二行']] };
    const mapping = detectMemoTableMapping(table.headers);
    const first = await mapMemoTable(table, mapping, {}, book, now);
    expect(first.books[0]?.entries[0]?.body).toEqual({ ops: [{ insert: '第一行\n第二行\n' }] });
    const repeat = await mapMemoTable(table, mapping, {}, book, '2026-10-01T00:00:00.000Z');
    expect(repeat.export_id).toBe(first.export_id);
    expect(repeat.books[0]?.entries[0]?.source_entry_id).toBe(first.books[0]?.entries[0]?.source_entry_id);
  });
  it('账号字段保留值空白，标题列排除，空映射不导入该列', async () => {
    const table = {
      headers: ['title', 'username', 'password', 'ignore'],
      rows: [['卡片', 'user', '  secret  ', 'unused']],
    };
    const result = await mapMemoTable(
      table,
      detectMemoTableMapping(table.headers),
      { title: '标题', username: '账号', password: '密码', ignore: '' },
      { ...book, type: 'credentials' },
      now,
    );
    expect(result.books[0]?.entries[0]?.body).toEqual({
      fields: [
        { label: '账号', value: 'user' },
        { label: '密码', value: '  secret  ' },
      ],
    });
    expect(credentialFieldLabel('toString')).toBe('toString');
    expect(credentialFieldLabel('password')).toBe('密码');
  });
  it('错误行不包含私密字段值，超20字段需明确调整', async () => {
    const table = { headers: ['title', 'password'], rows: [['卡片', 'sensitive'.repeat(300)]] };
    await expect(
      mapMemoTable(
        table,
        detectMemoTableMapping(table.headers),
        { password: '密码' },
        { ...book, type: 'credentials' },
        now,
      ),
    ).rejects.toThrow('第 2 行：正文或账号字段');
    const fields = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`field${index}`, `字段${index}`]));
    await expect(
      mapMemoTable(table, detectMemoTableMapping(table.headers), fields, { ...book, type: 'credentials' }, now),
    ).rejects.toThrow('最多 20');
  });
  it('日子通用JSON与XLSX零点日期同样保留自然日', () => {
    const table = selectTable(parseJsonTables('[{"name":"学习日","date":"2026-09-30T00:00:00.000Z"}]')[0]!, true);
    const result = mapDayRows(table, detectDayMapping(table.headers), 'anniversary', 'day', now);
    expect(result[0]?.payload.event?.solar_date).toBe('2026-09-30');
  });
});
