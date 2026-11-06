import { describe, expect, it } from 'vitest';
import { bannerImageId, bannerPreview } from './model';
import type { BannerEntry } from './model';

const mediaId = 'a'.repeat(64);
const entry: BannerEntry = {
  id: '11111111-1111-4111-8111-111111111111',
  slot: 'fitness-plan-library',
  source: 'remote',
  target: 'fitness-template-library',
  target_id: null,
  target_name: null,
  image_path: `/api/v1/banners/media/${mediaId}`,
  version: 2,
  sort_order: 0,
  updated_at: '2026-10-29T00:00:00.000Z',
  updated_by: null,
};

describe('轮播入口与统计边界', () => {
  it('未发布图片只走后台鉴权预览，拒绝外部地址和路径穿越', () => {
    expect(bannerImageId(entry.image_path)).toBe(mediaId);
    expect(bannerPreview(entry)).toBe(`/api/v1/admin/banners/media/${mediaId}`);
    expect(() => bannerImageId(`https://other.example/api/v1/banners/media/${mediaId}`)).toThrow();
    expect(() => bannerImageId('/api/v1/banners/media/../users')).toThrow();
  });
});
