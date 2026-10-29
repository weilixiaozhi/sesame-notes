import { describe, expect, it } from 'vitest';
import { bannerListSchema, bannerUploadSchema } from '../../../api/banner-contracts';
import { bannerImageId, bannerPreview, defaultBanner } from './model';
import type { BannerEntry } from './model';

const id = 'a'.repeat(64);
const entry: BannerEntry = {
  slot: 'fitness-plan-library',
  target: 'fitness-template-library',
  image_path: `/api/v1/banners/media/${id}`,
  is_enabled: true,
  version: 2,
  updated_at: '2026-10-29T00:00:00.000Z',
};

describe('Banner 配置边界', () => {
  it('恢复默认会同时重置图片、跳转和启用状态，保留并发版本', () => {
    const result = defaultBanner(entry);
    expect(result).toEqual({ ...entry, target: entry.slot, image_path: null, is_enabled: false });
    expect(bannerPreview(result)).toBe('/banner-defaults/plan-library.png');
    expect(bannerPreview({ ...entry, is_enabled: false })).toBe('/banner-defaults/plan-library.png');
  });
  it('未发布素材只走后台鉴权预览，拒绝外部地址和路径穿越', () => {
    expect(bannerImageId(entry.image_path)).toBe(id);
    expect(bannerPreview(entry)).toBe(`/api/v1/admin/banners/media/${id}`);
    expect(() => bannerImageId(`https://other.example/api/v1/banners/media/${id}`)).toThrow();
    expect(() => bannerImageId('/api/v1/banners/media/../users')).toThrow();
  });
  it('完整列表必须包含两个不同位置，不能将未知目标或半份列表当成有效配置', () => {
    const second = { ...entry, slot: 'fitness-template-library' };
    expect(bannerListSchema.safeParse({ items: [entry, second] }).success).toBe(true);
    expect(bannerListSchema.safeParse({ items: [entry] }).success).toBe(false);
    expect(bannerListSchema.safeParse({ items: [entry, entry] }).success).toBe(false);
    expect(bannerListSchema.safeParse({ items: [entry, { ...second, target: '/settings' }] }).success).toBe(false);
  });
  it('上传响应中图片标识必须与图片路径一致', () => {
    const upload = { id, image_path: entry.image_path, width: 2160, height: 720 };
    expect(bannerUploadSchema.safeParse(upload).success).toBe(true);
    expect(bannerUploadSchema.safeParse({ ...upload, id: 'b'.repeat(64) }).success).toBe(false);
  });
});
