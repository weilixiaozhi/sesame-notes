import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { validateBannerImage } from './banner-media.js';

describe('Banner 上传位图边界', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('将真实 %s 标准化为可校验的 WebP 字节', async (format) => {
    try {
      const source = await sharp({ create: { width: 300, height: 100, channels: 3, background: '#263f59' } })
        .toFormat(format)
        .toBuffer();
      const image = await validateBannerImage(`banner.${format}`, source.toString('base64'));
      expect(image.id).toBe(createHash('sha256').update(image.bytes).digest('hex'));
      expect(image).toMatchObject({ width: 300, height: 100 });
      expect((await sharp(image.bytes).metadata()).format).toBe('webp');
    } catch (cause) {
      throw new Error('Banner 位图标准化验证失败', { cause });
    }
  });

  it('拒绝伪装位图的 SVG、损坏文件、非法 Base64 和路径文件名', async () => {
    try {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>');
      await expect(validateBannerImage('banner.png', svg.toString('base64'))).rejects.toMatchObject({
        code: 'BANNER_MEDIA_FORMAT',
      });
      const broken = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      await expect(validateBannerImage('banner.png', broken.toString('base64'))).rejects.toMatchObject({
        code: 'BANNER_MEDIA_DECODE',
      });
      await expect(validateBannerImage('banner.png', 'not base64')).rejects.toMatchObject({
        code: 'BANNER_MEDIA_SIZE',
      });
      await expect(validateBannerImage('../banner.png', 'AAAA')).rejects.toMatchObject({
        code: 'BANNER_MEDIA_FILENAME',
      });
    } catch (cause) {
      throw new Error('Banner 无效图片边界验证失败', { cause });
    }
  });

  it('拒绝超过边长限制的图片和多帧 WebP', async () => {
    try {
      const wide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#fff' } })
        .png()
        .toBuffer();
      await expect(validateBannerImage('wide.png', wide.toString('base64'))).rejects.toMatchObject({
        code: 'BANNER_MEDIA_DIMENSIONS',
      });
      const frames = Buffer.concat([Buffer.alloc(3 * 4, 0), Buffer.alloc(3 * 4, 255)]);
      const animation = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } })
        .webp({ loop: 0, delay: [100, 100] })
        .toBuffer();
      await expect(validateBannerImage('animated.webp', animation.toString('base64'))).rejects.toMatchObject({
        code: 'BANNER_MEDIA_FORMAT',
      });
    } catch (cause) {
      throw new Error('Banner 尺寸和帧数边界验证失败', { cause });
    }
  });
});
