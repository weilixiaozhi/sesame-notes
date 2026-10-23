import { describe, expect, it, vi } from 'vitest';

import sharp from 'sharp';

import { MAX_AVATAR_BYTES, decodeAvatar } from '../src/modules/accounts/testing.js';

/** 生成带 EXIF 方向元数据的 JPEG，验证重编码会剥离元数据 */
async function jpegWithExif(): Promise<string> {
  const buffer = await sharp({
    create: {
      width: 16,
      height: 32,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  return buffer.toString('base64');
}

describe('头像解码与重编码边界', () => {
  it('伪装为 PNG 的其他格式在原生元数据解析前被拒绝', async () => {
    const metadata = vi.spyOn(sharp.prototype, 'metadata');
    try {
      const input = Buffer.from('0000002066747970617669660000000061766966', 'hex').toString('base64');
      await expect(decodeAvatar('image/png', input)).rejects.toMatchObject({ code: 'AVATAR_INVALID' });
      expect(metadata).not.toHaveBeenCalled();
    } finally {
      metadata.mockRestore();
    }
  });
  it('合法 PNG 解码并重编码：输出仍是可解码 PNG，字节与输入不同（剥离元数据）', async () => {
    const source = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const output = await decodeAvatar('image/png', source.toString('base64'));
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(8);
    expect(meta.height).toBe(8);
  });

  it('JPEG 携带 EXIF 时重编码后元数据被剥离（定位信息不外泄）', async () => {
    const input = await jpegWithExif();
    const output = await decodeAvatar('image/jpeg', input);
    const meta = await sharp(output).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    // 方向已应用到像素：输出宽高与 EXIF 方向一致（16x32 竖图方向 6 → 32x16）
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(16);
  });

  it('声明 MIME 与实际格式不一致时拒绝（伪造内容类型）', async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(decodeAvatar('image/jpeg', png.toString('base64'))).rejects.toThrow('无法识别该图片，请重新选择');
  });

  it('无法解码的垃圾字节返回 AVATAR_INVALID', async () => {
    const garbage = Buffer.from('not-an-image-at-all-just-text').toString('base64');
    await expect(decodeAvatar('image/png', garbage)).rejects.toThrow('无法识别该图片，请重新选择');
  });

  it('原始字节超过上限返回 AVATAR_TOO_LARGE', async () => {
    const big = Buffer.alloc(MAX_AVATAR_BYTES + 1, 0x00);
    await expect(decodeAvatar('image/png', big.toString('base64'))).rejects.toThrow('图片过大，请选择较小的图片');
  });

  it('像素超过上限返回 AVATAR_TOO_LARGE（防解压炸弹）', async () => {
    // 两条边均符合 8192 上限，仅总像素刚超过 4000 万，独立验证总像素保护。
    const huge = await sharp({
      create: { width: 8000, height: 5001, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    await expect(decodeAvatar('image/png', huge.toString('base64'))).rejects.toThrow('图片过大，请选择较小的图片');
  });
});
