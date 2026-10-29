import type { Category, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { validateParentCategory } from '../src/modules/accounting/index.js';
import { categoryState, categoryVersionToken } from '../src/shared/category-version.js';
import {
  categoryIntentMatches,
  nextCategoryTimestamp,
  normalizeCategoryDraft,
  officialCategoryIdentity,
} from '../src/modules/accounting/testing.js';
const identities = JSON.parse(
  readFileSync(new URL('../src/modules/accounting/official-category-identities.json', import.meta.url), 'utf8'),
) as { items: Array<{ id: string; key: string; level: number; parent_id: string | null }> };

const row: Category = {
  id: identities.items[0]!.id,
  ownerId: '11111111-1111-4111-8111-111111111111',
  name: '云端自定义显示名',
  kind: 'expense',
  level: 1,
  parentId: null,
  sortOrder: 3,
  icon: 'cloud',
  createdAt: new Date(0),
  updatedAt: new Date('2026-01-01T00:00:00.123Z'),
  updatedByDeviceId: '22222222-2222-4222-8222-222222222222',
  deletedAt: null,
};
const draft = { name: row.name, kind: 'expense', level: 1, parent_id: null, sort_order: 3, icon: 'cloud' } as const;

describe('官方分类身份与基线规则', () => {
  it('已发布分类身份保持稳定，默认目录及父关系完整', () => {
    // 固定已有身份的业务字段快照，来源摘要与模板内容调整不能改变用户分类身份。
    const stable = identities.items
      .map(({ id, key, level, parent_id }) => ({ id, key, level, parent_id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(stable).toHaveLength(159);
    expect(createHash('sha256').update(JSON.stringify(stable)).digest('hex')).toBe(
      'a0cf81b4a229e8e3b082b1354f075e1a5372677a56840e704377fccc9ae69a2a',
    );
    const defaults = JSON.parse(
      readFileSync(new URL('../src/modules/accounting/default-category-catalog.json', import.meta.url), 'utf8'),
    ) as { items: Array<{ id: string; key: string; level: number; parent_id: string | null }> };
    for (const category of defaults.items) {
      expect(officialCategoryIdentity(category.id)).toEqual({
        id: category.id,
        key: category.key,
        level: category.level,
        parent_id: category.parent_id,
      });
    }
    for (const item of identities.items) {
      expect(officialCategoryIdentity(item.id.toUpperCase())).toEqual(item);
      if (item.level === 2) expect(officialCategoryIdentity(item.parent_id!)?.level).toBe(1);
    }
  });
  it('同名自定义和未知UUIDv5均不能被认领为官方分类', () => {
    expect(officialCategoryIdentity('aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa')).toBeUndefined();
    expect(officialCategoryIdentity('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')).toBeUndefined();
  });
  it.each([
    'ownerId',
    'id',
    'name',
    'kind',
    'level',
    'sortOrder',
    'icon',
    'parentId',
    'updatedAt',
    'updatedByDeviceId',
    'deletedAt',
  ] as const)('基线包括%s，不能把陈旧元数据或墓碑视作当前版本', (field) => {
    const changes: Record<typeof field, unknown> = {
      ownerId: '33333333-3333-4333-8333-333333333333',
      id: '44444444-4444-4444-8444-444444444444',
      name: '其他',
      kind: 'other',
      level: 2,
      sortOrder: 4,
      icon: null,
      parentId: '55555555-5555-4555-8555-555555555555',
      updatedAt: new Date('2026-01-01T00:00:00.124Z'),
      updatedByDeviceId: null,
      deletedAt: new Date('2026-01-02T00:00:00.000Z'),
    };
    expect(categoryVersionToken({ ...row, [field]: changes[field] })).not.toBe(categoryVersionToken(row));
  });
  it('同内容只按完整业务语义判断，墓碑与父节点不同不能被当作no-op', () => {
    expect(categoryIntentMatches(row, 'upsert', draft)).toBe(true);
    expect(categoryIntentMatches({ ...row, deletedAt: new Date() }, 'upsert', draft)).toBe(false);
    expect(categoryIntentMatches(row, 'upsert', { ...draft, sort_order: 4 })).toBe(false);
    expect(categoryIntentMatches(row, 'delete', null)).toBe(false);
    expect(categoryIntentMatches({ ...row, deletedAt: new Date() }, 'delete', null)).toBe(true);
  });
  it('层级只接受数字，不能隐式转换字符串或其他类型', () => {
    expect(normalizeCategoryDraft(draft, row.id)).toEqual(draft);
    for (const level of ['1', '2']) expect(() => normalizeCategoryDraft({ ...draft, level }, row.id)).toThrow();
    expect(() => normalizeCategoryDraft({ ...draft, sort_order: '3' }, row.id)).toThrow();
    expect(() => normalizeCategoryDraft({ ...draft, level: true }, row.id)).toThrow();
    expect(() => normalizeCategoryDraft({ ...draft, level: 2, parent_id: row.id }, row.id)).toThrow();
  });
  it.each([
    {
      name: '父身份无效',
      level: 2,
      parentId: 'not-a-uuid',
      code: 'INVALID_CATEGORY_PARENT',
    },
    {
      name: '一级带父分类',
      level: 1,
      parentId: '55555555-5555-4555-8555-555555555555',
      code: 'CATEGORY_PARENT_FORBIDDEN',
    },
    { name: '二级缺少父分类', level: 2, parentId: null, code: 'CATEGORY_PARENT_REQUIRED' },
    {
      name: '动态父节点不可用',
      level: 2,
      parentId: '55555555-5555-4555-8555-555555555555',
      code: 'CATEGORY_PARENT_UNAVAILABLE',
    },
  ])('父关系错误码区分 $name，静态问题不会被当作可同步恢复的依赖', async (scenario) => {
    try {
      const findFirst = vi.fn().mockResolvedValue(null);
      const database = { category: { findFirst } } as unknown as Prisma.TransactionClient;
      const payload = { ...draft, level: scenario.level, parent_id: scenario.parentId };
      if (scenario.code === 'CATEGORY_PARENT_UNAVAILABLE') {
        // 动态父节点是否可用由当前数据库事实判定，合法草稿不提前拒绝父身份。
        expect(normalizeCategoryDraft(payload, row.id)).toMatchObject({ parent_id: scenario.parentId, level: 2 });
      } else {
        expect(() => normalizeCategoryDraft(payload, row.id)).toThrowError(
          expect.objectContaining({ code: scenario.code, statusCode: 400 }),
        );
      }
      await expect(
        validateParentCategory(database, row.ownerId, scenario.parentId, scenario.level, row.id),
      ).rejects.toMatchObject({ code: scenario.code, statusCode: 400 });
      expect(findFirst).toHaveBeenCalledTimes(scenario.code === 'CATEGORY_PARENT_UNAVAILABLE' ? 1 : 0);
    } catch (cause) {
      throw new Error(`分类父关系错误码验证失败：${scenario.name}`, { cause });
    }
  });
  it('人工CAS更新保留毫秒单调性，快照直接使用同一token实现', () => {
    expect(nextCategoryTimestamp(row, new Date(0)).getTime()).toBe(row.updatedAt.getTime() + 1);
    expect(categoryState(row)).toMatchObject({ version_token: categoryVersionToken(row), deleted_at: null });
  });
});
