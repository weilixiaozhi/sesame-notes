import { describe, expect, it } from 'vitest';
import { transactionQueryWhere } from '../src/modules/accounting/testing.js';

describe('交易查询与统计共用筛选', () => {
  it('默认筛选不附加交易范围限制，统计与明细共用全部记录', () => {
    expect(transactionQueryWhere({})).toEqual({});
  });
  it('采用同一左闭右开时间区间，原币种与未分类筛选不改变金额单位', () => {
    expect(
      transactionQueryWhere({
        start_at: '2026-09-01T00:00:00.000Z',
        end_at: '2026-10-01T00:00:00.000Z',
        currency_code: 'USD',
        category_id: 'uncategorized',
      }),
    ).toEqual({
      happenedAt: { gte: new Date('2026-09-01T00:00:00.000Z'), lt: new Date('2026-10-01T00:00:00.000Z') },
      currencyCode: 'USD',
      categoryId: null,
    });
  });
  it.each([
    { start_at: '2026-02-31T00:00:00.000Z' },
    { end_at: 'invalid' },
    { start_at: '2026-10-01T00:00:00.000Z', end_at: '2026-10-01T00:00:00.000Z' },
    { start_at: '2026-10-02T00:00:00.000Z', end_at: '2026-10-01T00:00:00.000Z' },
  ])('拒绝无效或反向日期范围 %j', (query) => {
    expect(() => transactionQueryWhere(query)).toThrow();
  });
});
