import { describe, expect, it } from 'vitest';
import { memoExportJson } from './memo-export';
import { exportFileName } from '../../lib/transfer/download';
import type { MemoBook, MemoEntry } from './memo-content';
import { dayExportCsv } from '../days/day-export';
import { projectDate, type DayBook, type DayEvent } from '../days/day-dates';

const book: MemoBook = {
  id: 'book',
  name: '导出测试',
  type: 'normal',
  sync_id: 'internal-sync',
  revision: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
};
const entry: MemoEntry = {
  id: 'entry',
  memo_book_id: 'book',
  book_type: 'normal',
  sync_id: 'internal-sync',
  revision: 2,
  deleted_at: null,
  title: '标题',
  body_format: 'delta_v1',
  body: { ops: [{ insert: '粗体', attributes: { bold: true } }, { insert: '\n' }] },
  order_key: null,
  created_at: book.created_at,
  updated_at: book.updated_at,
  book_updated_at: book.updated_at,
};

describe('客户端兼容交换格式导出', () => {
  it('备忘录格式v2保留富文本，不泄漏内部同步身份', () => {
    const exported = memoExportJson(book, [entry], 'export', book.created_at);
    expect(JSON.parse(exported)).toMatchObject({
      format: 'sesame-memos',
      schema_version: 2,
      books: [{ source_book_id: book.id, entries: [{ source_entry_id: entry.id, body: entry.body }] }],
    });
    expect(exported).not.toContain('internal-sync');
    expect(exported).not.toContain('revision');
  });
  it('拒绝跨本内容，并排除已删除记录', () => {
    expect(() => memoExportJson(book, [{ ...entry, memo_book_id: 'other' }], 'export', book.created_at)).toThrow();
    expect(
      JSON.parse(memoExportJson(book, [{ ...entry, deleted_at: book.updated_at }], 'export', book.created_at)).books[0]
        .entries,
    ).toEqual([]);
  });
  it('日子CSV保留农历而非把原始日期换成公历', () => {
    const dayBook: DayBook = {
      id: book.id,
      name: book.name,
      sync_id: book.sync_id,
      revision: book.revision,
      created_at: book.created_at,
      updated_at: book.updated_at,
      deleted_at: null,
    };
    const event: DayEvent = {
      ...dayBook,
      id: 'day',
      day_book_id: book.id,
      name: '带逗号,和"引号"',
      category: 'anniversary',
      repeat_type: 'yearly',
      statistic_type: 'day',
      countdown_mode: null,
      interval_days: null,
      start: null,
      end: null,
      event: projectDate({
        calendar_type: 'lunar',
        original_year: 2026,
        original_month: 1,
        original_day: 1,
        is_leap_month: false,
        solar_date: '',
      }),
    };
    const csv = dayExportCsv(dayBook, [event]);
    expect(csv.startsWith('\uFEFFname,category,')).toBe(true);
    expect(csv).toContain('2026-01-01,lunar,false');
    expect(csv).toContain('"带逗号,和""引号"""');
  });
  it('文件名中移除系统禁用字符', () => {
    expect(exportFileName('a/b:c?d')).toBe('a_b_c_d');
  });
});
