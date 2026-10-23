import { describe, expect, it, vi } from 'vitest';
import { credentialReorderPlan, mergeCredentialOrder, moveCredential, nextCredentialOrderKey } from './memo-order';
import type { MemoEntry } from './memo-content';

/** 边界顺序键用于验证真实 64 位整数，不通过浮点数构造。 */
function card(id: string, orderKey: string): MemoEntry {
  return {
    id,
    title: id,
    order_key: orderKey,
    memo_book_id: 'book',
    book_type: 'credentials',
    sync_id: 'sync',
    revision: 2,
    deleted_at: null,
    body_format: 'fields_v1',
    body: { fields: [] },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    book_updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('账号卡片完整顺序草稿', () => {
  it('新卡片从零开始，超过浮点安全范围后仍精确追加到完整本子末尾', () => {
    expect(nextCredentialOrderKey([])).toBe('0');
    expect(nextCredentialOrderKey([card('last', '9007199254740993'), card('first', '2')])).toBe('9007199254740994');
  });

  it('系统时间回拨不改变追加位置', () => {
    const entries = [card('last', '1792404505868')];
    vi.spyOn(Date, 'now').mockReturnValue(0);
    expect(nextCredentialOrderKey(entries)).toBe('1792404505869');
  });

  it('最大64位键拒绝溢出，重排压缩编号后可继续追加', () => {
    const entries = [card('a', '9223372036854775806'), card('b', '9223372036854775807')];
    expect(nextCredentialOrderKey([entries[0]!])).toBe('9223372036854775807');
    expect(() => nextCredentialOrderKey(entries)).toThrow('顺序编号已达上限');
    expect(() => nextCredentialOrderKey([entries[1]!])).toThrow('当前草稿已保留');
    const changes = credentialReorderPlan(entries, ['b', 'a']);
    expect(nextCredentialOrderKey(changes.map(({ entry, orderKey }) => ({ ...entry, order_key: orderKey })))).toBe('2');
    expect(() => nextCredentialOrderKey([card('invalid', '9223372036854775808')])).toThrow('顺序数据需要确认');
  });

  it('名称或时间排序下，完整可见顺序直接成为最终顺序', () => {
    const entries = [card('a', '0'), card('b', '1'), card('c', '2')];
    expect(mergeCredentialOrder(entries, ['c', 'b', 'a'], ['a', 'c', 'b'])).toEqual(['a', 'c', 'b']);
    expect(entries.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });

  it('搜索子集替换原有位置，隐藏卡片位置和相对顺序保持不变', () => {
    const entries = [card('a', '0'), card('hidden-1', '1'), card('b', '2'), card('hidden-2', '3'), card('c', '4')];
    expect(mergeCredentialOrder(entries, ['c', 'a', 'b'], ['b', 'c', 'a'])).toEqual([
      'b',
      'hidden-1',
      'c',
      'hidden-2',
      'a',
    ]);
    expect(() => mergeCredentialOrder(entries, ['a', 'b'], ['a', 'a'])).toThrow('卡片范围已变化');
    expect(() => mergeCredentialOrder(entries, ['missing'], ['missing'])).toThrow('卡片范围已变化');
  });

  it('超过浮点精度、重复键和最大64位键都生成唯一完整顺序', () => {
    const entries = [card('a', '9007199254740992'), card('b', '9007199254740992'), card('c', '9223372036854775807')];
    const changes = credentialReorderPlan(entries, ['c', 'a', 'b']);
    expect(changes.map(({ entry, orderKey }) => [entry.id, orderKey])).toEqual([
      ['c', '0'],
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(new Set(changes.map(({ orderKey }) => orderKey)).size).toBe(3);
    expect(entries.map(({ order_key }) => order_key)).toEqual([
      '9007199254740992',
      '9007199254740992',
      '9223372036854775807',
    ]);
  });

  it('只提交键发生变化的卡片，保留完整原始记录供修订号校验', () => {
    const entries = [card('a', '0'), card('b', '1'), card('c', '2')];
    expect(credentialReorderPlan(entries, ['b', 'a', 'c'])).toEqual([
      { entry: entries[1], orderKey: '0' },
      { entry: entries[0], orderKey: '1' },
    ]);
    expect(credentialReorderPlan(entries, ['a', 'b', 'c'])).toEqual([]);
  });

  it('身份缺失、重复和无效键拒绝提交，避免静默丢卡片', () => {
    const entries = [card('a', '0'), card('b', '1')];
    expect(() => credentialReorderPlan(entries, ['a'])).toThrow('卡片范围已变化');
    expect(() => credentialReorderPlan(entries, ['a', 'a'])).toThrow('卡片范围已变化');
    expect(() => credentialReorderPlan(entries, ['a', 'c'])).toThrow('卡片范围已变化');
    expect(() => credentialReorderPlan([card('a', '9223372036854775808')], ['a'])).toThrow('顺序数据需要确认');
    expect(() => credentialReorderPlan([card('a', '-1')], ['a'])).toThrow('顺序数据需要确认');
  });

  it('移动稳定身份，不修改源草稿，越界动作保持顺序', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveCredential(ids, 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveCredential(ids, 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(moveCredential(ids, 'a', -1)).toEqual(ids);
    expect(moveCredential(ids, 'missing', 0)).toEqual(ids);
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
