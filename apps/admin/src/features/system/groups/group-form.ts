import { z } from 'zod';

/** 用户组排序范围与服务端一致，支持默认组初始化的负排序值。 */
export const GROUP_SORT_MIN = -1_000_000;
export const GROUP_SORT_MAX = 1_000_000;
const sortRangeMessage = '排序需在 -1000000 到 1000000 之间。';

export const groupFormSchema = z.object({
  name: z.string().trim().min(1, '请输入用户组名称。').max(32),
  description: z.string().max(200),
  sort: z
    .number({ error: '请输入有效的排序数字。' })
    .int('排序必须为整数。')
    .min(GROUP_SORT_MIN, sortRangeMessage)
    .max(GROUP_SORT_MAX, sortRangeMessage),
  is_enabled: z.boolean(),
  reason: z.string().max(500),
});
