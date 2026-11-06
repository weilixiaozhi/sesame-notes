import { describe, expect, it } from 'vitest';
import { importTimestamp } from './timestamp';

describe('导入时间的共同年份边界', () => {
  it('零年份来源不能通过时区转换进入有效年份', () => {
    try {
      expect(() => importTimestamp('0000-12-31T23:00:00-01:00')).toThrow('日期无效');
    } catch (cause) {
      throw new Error('导入解析器接受了业务协议禁止的零年份', { cause });
    }
  });

  it('最小合法年份保留精确瞬间', () => {
    try {
      expect(importTimestamp('0001-01-01T00:00:00.000Z')).toBe('0001-01-01T00:00:00.000Z');
    } catch (cause) {
      throw new Error('合法导入时间被年份校验改写或拒绝', { cause });
    }
  });

  it('时区转换后的 UTC 年份不能超出协议上界', () => {
    try {
      expect(() => importTimestamp('9999-12-31T23:59:59-01:00')).toThrow('日期无效');
    } catch (cause) {
      throw new Error('导入解析器产生了服务端不接受的UTC年份', { cause });
    }
  });
});
