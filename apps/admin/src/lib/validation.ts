import { z } from 'zod';

export const accountName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9._-]{3,31}$/, '账号需为 4–32 位，以字母开头，可含数字、点、下划线及短横线。');
export const password = z.string().min(1, '请输入密码。');
export const reason = z.string().trim().min(1, '请填写操作原因。').max(500, '操作原因最多 500 个字符。');
export const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入登录账号、邮箱或手机号。').max(254, '登录信息最多 254 个字符。'),
  password,
});
export const passwordSchema = z
  .object({ old_password: z.string().min(1, '请输入当前密码。'), new_password: password, confirmation: z.string() })
  .refine((value) => value.new_password === value.confirmation, {
    path: ['confirmation'],
    message: '两次输入的新密码不一致。',
  });

/** 用 Zod 校验表单输入并返回首条友好提示，未知异常由调用边界记录。 */
export function validationError(schema: z.ZodType, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : result.error.issues[0]?.message || '请检查填写内容。';
}
