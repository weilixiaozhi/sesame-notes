import type { api } from '../../../api/client';
import { bannerImagePathSchema } from '../../../api/banner-contracts';

export type BannerEntry = Awaited<ReturnType<typeof api.adminBanners.list>>['items'][number];
export type BannerTarget = BannerEntry['target'];
export const bannerSlots = {
  'fitness-plan-library': { title: '计划页 · 计划库入口', image: '/banner-defaults/plan-library.png' },
  'fitness-template-library': { title: '模板页 · 模板库入口', image: '/banner-defaults/template-library.png' },
};
export const bannerTargets: Record<BannerTarget, string> = {
  'fitness-plan-library': '计划库',
  'fitness-template-library': '模板库',
  'fitness-exercises': '动作库',
  'fitness-plans': '我的计划',
  'fitness-templates': '我的模板',
};

/** 仅从服务端受控素材地址提取标识，外站链接不能进入管理预览。 */
export function bannerImageId(path: string | null): string | null {
  if (path === null) return null;
  try {
    return bannerImagePathSchema.parse(path).split('/').at(-1)!;
  } catch {
    throw new Error('Banner 图片地址无效');
  }
}

/** 草稿和停用图片使用鉴权预览，默认内容与客户端内置素材一致。 */
export function bannerPreview(entry: BannerEntry): string {
  const id = entry.is_enabled ? bannerImageId(entry.image_path) : null;
  return id ? `/api/v1/admin/banners/media/${id}` : bannerSlots[entry.slot].image;
}

/** 恢复默认同时清除图片与目标覆盖，客户端始终保留可用入口。 */
export function defaultBanner(entry: BannerEntry): BannerEntry {
  return { ...entry, image_path: null, target: entry.slot, is_enabled: false };
}
