import { describe, expect, it } from 'vitest';
import { importTimestamp } from './timestamp';

describe('导入时间的共同年份边界', () => {
  it.each(['0000-01-01T00:00:00.000Z', '0000-12-31T23:00:00-01:00'])(
    '拒绝零年份来源时间 %s，不用时区转换生成有效年份',
    (value) => {
      try {
        expect(() => importTimestamp(value)).toThrow('日期无效');
      } catch (cause) {
        throw new Error('导入解析器接受了业务协议禁止的零年份', { cause });
      }
    },
  );

  it.each([
    ['0001-01-01T00:00:00.000Z', '0001-01-01T00:00:00.000Z'],
    ['0004-02-29T12:00:00.000Z', '0004-02-29T12:00:00.000Z'],
    ['0099-12-31T23:59:59.999Z', '0099-12-31T23:59:59.999Z'],
    ['2026-02-28T12:00:00+08:00', '2026-02-28T04:00:00.000Z'],
  ])('合法时间 %s 保留精确瞬间', (input, expected) => {
    try {
      expect(importTimestamp(input)).toBe(expected);
    } catch (cause) {
      throw new Error('合法导入时间被年份校验改写或拒绝', { cause });
    }
  });

  it.each(['0001-01-01T00:00:00+08:00', '9999-12-31T23:59:59-01:00'])(
    '时区转换后的UTC年份超出协议范围时拒绝 %s',
    (value) => {
      try {
        expect(() => importTimestamp(value)).toThrow('日期无效');
      } catch (cause) {
        throw new Error('导入解析器产生了服务端不接受的UTC年份', { cause });
      }
    },
  );
});
