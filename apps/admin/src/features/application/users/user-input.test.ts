import { describe, expect, it } from 'vitest';
import { avatarFileError, encodeAvatar, userPasswordSchema, userPhoneSchema } from './user-input';

describe('应用用户资料输入', () => {
  it('换绑区号必须来自选择目录，国内号码校验后保留国际区号与本地号码的边界', () => {
    expect(userPhoneSchema.parse({ country_code: '+86', phone: '138 1234 5678' })).toEqual({
      country_code: '+86',
      phone: '13812345678',
    });
    expect(userPhoneSchema.safeParse({ country_code: '+000', phone: '13812345678' }).success).toBe(false);
    expect(userPhoneSchema.safeParse({ country_code: '+86', phone: '+8613812345678' }).success).toBe(false);
    expect(userPhoneSchema.safeParse({ country_code: '+86', phone: '12345' }).success).toBe(false);
    expect(userPhoneSchema.safeParse({ country_code: '+852', phone: '5123 4567' }).success).toBe(true);
  });

  it('用户密码保留原始空格，允许短密码并遵循普通用户的长度上限', () => {
    for (const value of ['a', ' ', '  abc  ', 'a'.repeat(128)]) {
      expect(userPasswordSchema.parse({ new_password: value, confirmation: value }).new_password).toBe(value);
    }
    expect(userPasswordSchema.safeParse({ new_password: '', confirmation: '' }).success).toBe(false);
    expect(userPasswordSchema.safeParse({ new_password: 'a'.repeat(129), confirmation: 'a'.repeat(129) }).success).toBe(
      false,
    );
    expect(userPasswordSchema.safeParse({ new_password: ' a ', confirmation: 'a' }).success).toBe(false);
  });

  it('头像拒绝空文件、未知格式与超过 8 MiB 的图片', () => {
    expect(avatarFileError({ type: 'image/gif', size: 12 })).toContain('PNG');
    expect(avatarFileError({ type: 'image/png', size: 0 })).toContain('为空');
    expect(avatarFileError({ type: 'image/png', size: 8 * 1024 * 1024 + 1 })).toContain('8 MB');
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(avatarFileError({ type, size: 8 * 1024 * 1024 })).toBeNull();
    }
  });

  it('大文件分段编码保留完整字节，读取异常不泄露原始错误内容', async () => {
    const bytes = Uint8Array.from({ length: 20000 }, (_, index) => index % 256);
    const file = { arrayBuffer: async () => bytes.buffer } as File;
    expect(await encodeAvatar(file)).toBe(Buffer.from(bytes).toString('base64'));
    await expect(
      encodeAvatar({
        arrayBuffer: async () => {
          throw new Error('private-file-name');
        },
      } as unknown as File),
    ).rejects.toThrow('无法读取所选图片。');
  });
});
