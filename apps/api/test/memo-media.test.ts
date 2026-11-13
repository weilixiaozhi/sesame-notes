import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { MAX_MEMO_IMAGE_BYTES, sanitizeMemoImage } from '../src/modules/memos/index.js';

/** 生成纯色 PNG 的 Base64，作为合法输入。 */
async function png(width: number, height: number): Promise<string> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();
  return bytes.toString('base64');
}

describe('备忘录图片解码与重编码边界', () => {
  it('超过输出最长边的图片等比缩小，并返回真实输出尺寸', async () => {
    const image = await sanitizeMemoImage('image/png', await png(3000, 1000));
    const metadata = await sharp(image.bytes).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(2048);
    expect(metadata.height).toBe(683);
    expect(image.width).toBe(2048);
    expect(image.height).toBe(683);
  });

  it('小图保持原始像素且剥离元数据', async () => {
    const source = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#223344' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const image = await sanitizeMemoImage('image/jpeg', source.toString('base64'));
    const metadata = await sharp(image.bytes).metadata();
    expect(metadata.exif).toBeUndefined();
    // 方向应用到像素：12x8 的横图在方向 6 后变成 8x12。
    expect(metadata.width).toBe(8);
    expect(metadata.height).toBe(12);
    expect(image.format).toBe('jpeg');
  });

  it('声明类型与实际格式不一致时拒绝', async () => {
    await expect(sanitizeMemoImage('image/jpeg', await png(8, 8))).rejects.toMatchObject({
      code: 'MEMO_MEDIA_INVALID',
    });
  });

  it('无法解码的字节与超出像素上限的图片分别拒绝', async () => {
    await expect(sanitizeMemoImage('image/png', Buffer.from('not-an-image').toString('base64'))).rejects.toMatchObject({
      code: 'MEMO_MEDIA_INVALID',
    });
    const huge = await sharp({ create: { width: 8000, height: 5001, channels: 3, background: 'white' } })
      .png()
      .toBuffer();
    await expect(sanitizeMemoImage('image/png', huge.toString('base64'))).rejects.toMatchObject({
      code: 'MEMO_MEDIA_TOO_LARGE',
    });
  });

  it('原始字节超过上限时返回过大错误', async () => {
    const big = Buffer.alloc(MAX_MEMO_IMAGE_BYTES + 1, 0x00);
    await expect(sanitizeMemoImage('image/png', big.toString('base64'))).rejects.toMatchObject({
      code: 'MEMO_MEDIA_TOO_LARGE',
    });
  });
});
