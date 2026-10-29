// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { categoryImportId, categoryImportSources } from './category-transfer';
import { detectTransferMapping } from './transfer-model';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));

it('跨端分类来源黄金向量与目标ID保持一致，列顺序和首尾空白不改变来源', async () => {
  try {
    const table = {
      headers: ['金额', '时间', '分类', '二级分类', '币种', 'category_icon', 'sub_category_icon'],
      rows: [['1', '2026-09-30', '\u0085餐饮\u0085', '午餐', 'CNY', 'utensils', 'soup']],
    };
    const catalog = await categoryImportSources(table, detectTransferMapping(table.headers));
    const key = JSON.stringify(['category-row', 'f46b1764dc81c6da12e396c2cb064615f0efd5375337e3c6f3df0558f2b7c0c0', 0]);
    expect(catalog.rowKeys).toEqual([key]);
    expect(await categoryImportId('d4d1c885-9a7a-4c87-968e-70b7dbe565f5', key)).toBe(
      '1bff8a1e-d503-4b13-89a5-b934c372502b',
    );
    expect(catalog.sources.get(key)?.parentKey).toBe(JSON.stringify(['category-parent', key]));
  } catch (cause) {
    throw new Error('跨端分类来源身份验证失败', { cause });
  }
});

it('源分类不能自指，同一个来源ID也不能表示不同父子结构', async () => {
  try {
    const headers = ['时间', '金额', '分类', '二级分类', 'category_scope', 'category_id', 'parent_category_id'];
    const self = { headers, rows: [['2026-09-30', '1', '餐饮', '午餐', 'account:source', 'same-id', 'same-id']] };
    await expect(categoryImportSources(self, detectTransferMapping(headers))).rejects.toThrow('不能将自身作为父分类');
    const conflicting = {
      headers,
      rows: [
        ['2026-09-30', '1', '餐饮', '午餐', 'account:source', 'child', 'parent-a'],
        ['2026-09-30', '2', '工作', '午餐', 'account:source', 'child', 'parent-b'],
      ],
    };
    await expect(categoryImportSources(conflicting, detectTransferMapping(headers))).rejects.toThrow('包含不一致内容');
  } catch (cause) {
    throw new Error('分类源自指与结构冲突验证失败', { cause });
  }
});
