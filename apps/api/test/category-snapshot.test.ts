import { describe, expect, it } from 'vitest';

import { categorySnapshotUpdate } from '../src/modules/accounting/testing.js';

describe('分类快照级联', () => {
  it('重命名或改类型时更新交易快照', () => {
    expect(categorySnapshotUpdate('餐饮', 'expense')).toEqual({
      categoryName: '餐饮',
      categoryKind: 'expense',
    });
  });

  it('删除分类时完整清空交易中的分类引用和快照', () => {
    expect(categorySnapshotUpdate(null, null)).toEqual({
      categoryId: null,
      categoryName: null,
      categoryKind: null,
    });
  });
});
