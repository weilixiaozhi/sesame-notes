import { describe, expect, it } from 'vitest';
import { newAccountGroupSelection } from './default-assignment';

describe('新账号自动归入默认组', () => {
  it('未手选时完全省略group_id，不发送null或固定默认ID', () => {
    const value = newAccountGroupSelection('');
    expect(value).toEqual({});
    expect(Object.hasOwn(value, 'group_id')).toBe(false);
  });
  it('明确选择默认或其他组时只发送一个服务端组引用', () => {
    expect(newAccountGroupSelection('server-selected-group')).toEqual({ group_id: 'server-selected-group' });
  });
  it('不接受null作为合法的前端组选择', () => {
    expect(() => newAccountGroupSelection(null as unknown as string)).toThrow();
  });
});
