import { z } from 'zod';
import { canonicalEntryAmount } from './money';

const noteCharacters = new Intl.Segmenter('zh', { granularity: 'grapheme' });

/** 与客户端备注输入共用二十个可见字符的上限，组合表情按一个字符计算。 */
export function entryNoteCharacters(value: string): string[] {
  return Array.from(noteCharacters.segment(value), (part) => part.segment);
}

export const transactionFormSchema = z.object({
  amount: z
    .string()
    .refine((value) => canonicalEntryAmount(value) !== null, '请输入大于 0 的金额，最多 28 位整数、2 位小数'),
  nativeAmount: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/, '请选择有效的支出币种'),
  happenedAt: z
    .string()
    .min(1, '请选择日期和时间')
    .refine((value) => Number.isFinite(new Date(value).getTime()), '日期或时间无效'),
  categoryId: z.string().min(1, '请选择支出分类'),
  note: z
    .string()
    .refine((value) => !/[\r\n\u0085\u2028\u2029]/.test(value), '备注只能填写一行')
    .refine((value) => entryNoteCharacters(value).length <= 20, '备注最多 20 个字'),
  payerId: z.string(),
  aaMode: z.enum(['0', '1', '2']),
  splits: z.array(z.object({ memberId: z.string(), amount: z.string() })),
});
export type TransactionFormValues = z.infer<typeof transactionFormSchema>;
