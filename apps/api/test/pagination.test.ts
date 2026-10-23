import { describe, expect, it } from 'vitest';

import { decodeTransactionCursor, encodeTransactionCursor } from '../src/shared/pagination.js';

describe('交易不透明游标', () => {
  it.each([
    { kind: 'UUIDv4', id: '018f7f95-4b8a-4f5e-8d0c-2ebf4682c761' },
    { kind: 'UUIDv5', id: '056cf10d-2d59-599c-9d97-6749e866aa52' },
  ])('$kind 交易游标往返保留复合排序键且不直接暴露 UUID 或时间', ({ id }) => {
    const value = { happenedAt: new Date('2026-08-20T09:00:00.000Z'), id };

    const cursor = encodeTransactionCursor(value);

    expect(cursor).not.toContain(value.id);
    expect(cursor).not.toContain('2026-08-20');
    expect(decodeTransactionCursor(cursor)).toEqual(value);
  });

  it('拒绝损坏或字段不完整的游标', () => {
    expect(() => decodeTransactionCursor('not-a-valid-cursor')).toThrow('INVALID_CURSOR');
    expect(() => decodeTransactionCursor(Buffer.from(JSON.stringify({ v: 1 })).toString('base64url'))).toThrow(
      'INVALID_CURSOR',
    );
  });

  it('编码与解码均拒绝不符合实体 UUID 形状的标识', () => {
    const time = '2026-08-20T09:00:00.000Z';
    const id = '056cf10d-2d59-599c-9d97-6749e866aa5z';
    expect(() => encodeTransactionCursor({ happenedAt: new Date(time), id })).toThrow('INVALID_CURSOR');
    const cursor = Buffer.from(JSON.stringify({ v: 1, t: time, i: id })).toString('base64url');
    expect(() => decodeTransactionCursor(cursor)).toThrow('INVALID_CURSOR');
  });

  it.each([
    '2026-02-30T09:00:00.000Z',
    '2026-08-20T24:00:00.000Z',
    '2026-08-20T09:00:00Z',
    '2026-08-20T09:00:00.00Z',
    '2026-08-20T17:00:00.000+08:00',
    '0000-08-20T09:00:00.000Z',
  ])('解码拒绝不存在或非规范的 UTC 毫秒时间：%s', (time) => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, t: time, i: '056cf10d-2d59-599c-9d97-6749e866aa52' })).toString(
      'base64url',
    );
    expect(() => decodeTransactionCursor(cursor)).toThrow('INVALID_CURSOR');
  });

  it.each([new Date(Number.NaN), new Date('0000-08-20T09:00:00.000Z'), new Date('+010000-08-20T09:00:00.000Z')])(
    '编码拒绝无法按协议回读的日期：%s',
    (happenedAt) => {
      expect(() => encodeTransactionCursor({ happenedAt, id: '056cf10d-2d59-599c-9d97-6749e866aa52' })).toThrow(
        'INVALID_CURSOR',
      );
    },
  );
});
