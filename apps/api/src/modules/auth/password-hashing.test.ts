import { expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './security.js';

it.each(['\uD800', '\uDC00', 'secret\uD800value'])(
  '密码拒绝未配对代理码元，避免 UTF-8 替换造成碰撞：%j',
  async (password) => {
    try {
      await expect(hashPassword(password)).rejects.toMatchObject({ statusCode: 400, code: 'PASSWORD_INVALID' });
      const replacement = password.toWellFormed();
      const hash = await hashPassword(replacement);
      expect(await verifyPassword(replacement, hash)).toBe(true);
      expect(await verifyPassword(password, hash)).toBe(false);
    } catch (cause) {
      throw new Error('密码 Unicode 精确编码边界验证失败', { cause });
    }
  },
);

it.each(['scrypt:abc:!', 'scrypt:abc:a', 'scrypt:abc:', 'scrypt:abc:!!!!'])('拒绝损坏的密码散列：%s', async (hash) => {
  try {
    expect(await verifyPassword('任意错误密码', hash)).toBe(false);
  } catch (cause) {
    throw new Error('损坏的密码散列拒绝验证失败', { cause });
  }
});

it('拒绝截断摘要及附加字段，保留签发器生成的完整格式', async () => {
  try {
    const password = '测试密码';
    const hash = await hashPassword(password);
    const [algorithm, salt, key] = hash.split(':');
    const truncatedKey = Buffer.from(key!, 'base64url').subarray(0, 1).toString('base64url');
    expect(await verifyPassword(password, `${algorithm}:${salt}:${truncatedKey}`)).toBe(false);
    expect(await verifyPassword(password, `${hash}:extra`)).toBe(false);
    expect(await verifyPassword(password, `${hash}\n`)).toBe(false);
    expect(await verifyPassword(password, hash)).toBe(true);
  } catch (cause) {
    throw new Error('密码散列完整性验证失败', { cause });
  }
});

it.each(['1', '1234', ' 密码 ', 'a'.repeat(128)].map((password) => ({ password, length: password.length })))(
  '非空密码按原文散列并精确验证：$length 字符',
  async ({ password }) => {
    try {
      const hash = await hashPassword(password);
      expect(hash).not.toBe(password);
      expect(await verifyPassword(password, hash)).toBe(true);
      expect(await verifyPassword(`${password}x`, hash)).toBe(false);
      if (password.trim() !== password) expect(await verifyPassword(password.trim(), hash)).toBe(false);
    } catch (cause) {
      throw new Error('密码散列与精确比较验证失败', { cause });
    }
  },
);
