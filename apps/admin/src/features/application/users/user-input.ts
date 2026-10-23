import { phoneRegions } from '@sesame-notes/api-client';
import { z } from 'zod';

export const userPasswordSchema = z
  .object({
    new_password: z.string().min(1, '请输入新密码。').max(128, '新密码最多 128 个字符。'),
    confirmation: z.string(),
  })
  .refine((value) => value.new_password === value.confirmation, {
    path: ['confirmation'],
    message: '两次输入的新密码不一致。',
  });

export const userPhoneSchema = z
  .object({
    country_code: z
      .string()
      .refine((value) => phoneRegions.some((region) => region.code === value), '请选择有效区号。'),
    phone: z.string().transform((value) => value.trim().replace(/[\s()-]/g, '')),
  })
  .superRefine((value, context) => {
    const combined = `${value.country_code}${value.phone}`;
    if (
      !/^\d+$/.test(value.phone) ||
      !/^\+[1-9]\d{5,14}$/.test(combined) ||
      (value.country_code === '+86' && !/^1[3-9]\d{9}$/.test(value.phone))
    ) {
      context.addIssue({ code: 'custom', path: ['phone'], message: '请输入有效手机号，号码中无需重复填写区号。' });
    }
  });

const avatarContentTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarContentType = (typeof avatarContentTypes)[number];

/** 在读取文件前验证格式和体积，避免将空文件或超大图片读入内存。 */
export function avatarFileError(file: Pick<File, 'type' | 'size'>): string | null {
  if (!avatarContentTypes.includes(file.type as AvatarContentType)) return '请选择 PNG、JPEG 或 WebP 图片。';
  if (file.size === 0) return '图片内容为空，请重新选择。';
  if (file.size > 8 * 1024 * 1024) return '图片不能超过 8 MB。';
  return null;
}

/** 分段编码图片，避免一次展开过多字节超过浏览器函数参数上限。 */
export async function encodeAvatar(file: File): Promise<string> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  } catch {
    // 只保留可公开的错误信息，文件内容和文件名不进入错误日志。
    throw new Error('无法读取所选图片。');
  }
}
