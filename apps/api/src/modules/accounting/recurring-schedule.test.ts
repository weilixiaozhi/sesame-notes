import { describe, expect, it } from 'vitest';
import {
  nextRecurringDate,
  parseOccurrenceDate,
  recurringOccurrenceId,
  recurringOccurrenceInstant,
  recurringToday,
  validateRecurringTimeZone,
  type RecurringSchedule,
} from './recurring-schedule.js';

/** 构造与移动端黄金向量相同的 UTC 日历规则。 */
function rule(fields: Partial<RecurringSchedule> = {}): RecurringSchedule {
  return {
    frequency: 'daily',
    interval: 1,
    dayOfMonth: null,
    dayOfWeek: null,
    monthOfYear: null,
    startDate: new Date('2024-01-31T00:00:00.000Z'),
    endDate: null,
    lastGeneratedDate: null,
    enabled: true,
    deletedAt: null,
    ...fields,
  };
}
const future = new Date('2030-01-01T00:00:00.000Z');

describe('跨端周期发生协议', () => {
  it('SHA256 发生身份与移动端黄金向量一致', () => {
    expect(
      recurringOccurrenceId(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '2024-02-29',
      ),
    ).toBe('8567ad8c-6340-4f61-b255-ad8e2317d077');
  });
  it.each([
    [{ frequency: 'monthly', lastGeneratedDate: new Date('2024-01-31') }, '2024-02-29'],
    [{ frequency: 'monthly', lastGeneratedDate: new Date('2024-02-29') }, '2024-03-31'],
    [{ frequency: 'monthly', interval: 2, lastGeneratedDate: new Date('2024-02-28') }, '2024-03-31'],
    [{ frequency: 'weekly', interval: 2, dayOfWeek: 1 }, '2024-02-05'],
    [{ frequency: 'weekly', interval: 2, dayOfWeek: 1, lastGeneratedDate: new Date('2024-02-05') }, '2024-02-19'],
    [
      { frequency: 'yearly', startDate: new Date('2024-02-29'), lastGeneratedDate: new Date('2027-02-28') },
      '2028-02-29',
    ],
  ] as const)('排期保留原始锚点 %#', (fields, expected) => {
    expect(nextRecurringDate(rule(fields), future)?.toISOString().slice(0, 10)).toBe(expected);
  });
  it.each([
    ['2024-03-10', 'America/New_York', '2024-03-10T05:00:00.000Z'],
    ['2024-03-11', 'America/New_York', '2024-03-11T04:00:00.000Z'],
    ['2018-11-04', 'America/Sao_Paulo', '2018-11-04T03:00:00.000Z'],
    ['2011-12-30', 'Pacific/Apia', '2011-12-30T10:00:00.000Z'],
    ['1900-01-01', 'UTC', '1900-01-01T00:00:00.000Z'],
  ])('时区日界和跳日与客户端一致 %s %s', (date, zone, expected) => {
    expect(recurringOccurrenceInstant(new Date(date), zone).toISOString()).toBe(expected);
  });
  it('到期日期取规则时区，结束日包含，删除或暂停不生成', () => {
    expect(recurringToday('America/New_York', new Date('2024-03-10T01:00:00.000Z'))).toEqual(new Date('2024-03-09'));
    expect(nextRecurringDate(rule({ endDate: new Date('2024-01-31') }), future)).toEqual(new Date('2024-01-31'));
    expect(
      nextRecurringDate(rule({ endDate: new Date('2024-01-31'), lastGeneratedDate: new Date('2024-01-31') }), future),
    ).toBeNull();
    expect(nextRecurringDate(rule({ enabled: false }), future)).toBeNull();
    expect(nextRecurringDate(rule({ deletedAt: new Date() }), future)).toBeNull();
    expect(() => validateRecurringTimeZone('GMT+08:00')).toThrow();
    expect(() => parseOccurrenceDate('2024-02-30')).toThrow();
    expect(() => nextRecurringDate(rule({ interval: 0 }), future)).toThrow();
  });
});
