import { describe, expect, it } from 'vitest';
import { bannerListSchema, bannerUploadSchema } from '../../../api/banner-contracts';
import {
  bannerImageId,
  bannerPreview,
  newBannerDraft,
  currentBannerMetrics,
  bannerMetricCount,
  bannerTargetLabel,
} from './model';
import type { BannerEntry, BannerStatistics } from './model';

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

/** 构造具有明确采集覆盖和图片身份的统计响应。 */
function report(): BannerStatistics {
  return {
    range: { start_date: '2026-10-29', end_date: '2026-10-29', timezone: 'Asia/Shanghai' },
    scope: 'current',
    items: [
      { banner_id: entry.id, slot: entry.slot, source: 'remote', version: 2, impressions: 10, clicks: 2, ctr: 0.2 },
    ],
    coverage: { collection_started_at: '2026-10-28T00:00:00.000Z', complete: true, audience: 'authenticated_users' },
  };
}

describe('轮播入口与统计边界', () => {
  it('新增草稿没有图片和服务器身份，管理列表允许为空', () => {
    const draft = newBannerDraft('fitness-plan-library');
    expect(draft.target).toBe('fitness-plan-library');
    expect(draft.image_path).toBeNull();
    expect(draft).not.toHaveProperty('id');
    expect(bannerPreview(draft)).toBeUndefined();
    expect(bannerListSchema.safeParse({ items: [] }).success).toBe(true);
    expect(bannerListSchema.safeParse({ items: [{ ...entry, source: 'builtin', version: 0 }] }).success).toBe(false);
  });
  it('未发布图片只走后台鉴权预览，拒绝外部地址和路径穿越', () => {
    expect(bannerImageId(entry.image_path)).toBe(mediaId);
    expect(bannerPreview(entry)).toBe(`/api/v1/admin/banners/media/${mediaId}`);
    expect(() => bannerImageId(`https://other.example/api/v1/banners/media/${mediaId}`)).toThrow();
    expect(() => bannerImageId('/api/v1/banners/media/../users')).toThrow();
  });
  it('同一位置允许多张图片，拒绝重复身份或未注册目标', () => {
    const second = { ...entry, id: '22222222-2222-4222-8222-222222222222', sort_order: 1 };
    expect(bannerListSchema.safeParse({ items: [entry, second] }).success).toBe(true);
    expect(bannerListSchema.safeParse({ items: [entry, entry] }).success).toBe(false);
    expect(bannerListSchema.safeParse({ items: [{ ...entry, target: '/settings' }] }).success).toBe(false);
  });
  it('上传响应的图片标识必须与路径一致', () => {
    const upload = { id: mediaId, image_path: entry.image_path, width: 2160, height: 720 };
    expect(bannerUploadSchema.safeParse(upload).success).toBe(true);
    expect(bannerUploadSchema.safeParse({ ...upload, id: 'b'.repeat(64) }).success).toBe(false);
  });
  it('相同位置不同图片或配置版本不能串用曝光和点击', () => {
    expect(currentBannerMetrics(entry, report())?.clicks).toBe(2);
    expect(currentBannerMetrics({ ...entry, version: 3 }, report())).toBeUndefined();
    expect(currentBannerMetrics({ ...entry, id: 'other' }, report())).toBeUndefined();
    expect(currentBannerMetrics({ ...entry, slot: 'fitness-template-library' }, report())).toBeUndefined();
  });
  it('尚未采集的零值为空，真实零值和正数正常展示', () => {
    const partial = { ...report(), coverage: { ...report().coverage, complete: false } };
    expect(bannerMetricCount(0, partial)).toBe('—');
    expect(bannerMetricCount(undefined, report())).toBe('—');
    expect(bannerMetricCount(0, report())).toBe('0');
    expect(bannerMetricCount(2, partial)).toBe('2');
  });
  it('指定官方内容显示名称，内容不可用时不展示裸标识', () => {
    expect(
      bannerTargetLabel({ ...entry, target: 'official-template', target_id: 'template', target_name: '三分化·胸三头' }),
    ).toBe('指定官方模板 · 三分化·胸三头');
    expect(bannerTargetLabel({ ...entry, target: 'official-plan', target_id: 'plan' })).toContain('内容已不可用');
  });
});
