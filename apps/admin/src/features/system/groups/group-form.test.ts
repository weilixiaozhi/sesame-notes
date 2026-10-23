import { describe, expect, it } from 'vitest';
import { GROUP_SORT_MAX, GROUP_SORT_MIN, groupFormSchema } from './group-form';

const defaultGroupForm = { name: '默认分组', description: '', sort: -1_000_000, is_enabled: true, reason: '' };

describe('用户组排序与资料编辑', () => {
  it('默认组保留初始化排序时可直接修改名称和说明', () => {
    const result = groupFormSchema.safeParse({ ...defaultGroupForm, name: '基础用户', description: '修改默认组资料' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sort).toBe(-1_000_000);
  });
  it('接受服务端支持的完整整数边界', () => {
    for (const sort of [GROUP_SORT_MIN, -1, 0, 9999, GROUP_SORT_MAX])
      expect(groupFormSchema.safeParse({ ...defaultGroupForm, sort }).success).toBe(true);
  });
  it('范围外值和非整数显示友好的中文校验提示', () => {
    for (const sort of [GROUP_SORT_MIN - 1, GROUP_SORT_MAX + 1, 1.5]) {
      const result = groupFormSchema.safeParse({ ...defaultGroupForm, sort });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toMatch(/^排序/);
    }
  });
});
