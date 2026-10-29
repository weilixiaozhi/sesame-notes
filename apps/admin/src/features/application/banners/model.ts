import type { api } from '../../../api/client';
import { bannerImagePathSchema } from '../../../api/banner-contracts';

export type BannerEntry = Awaited<ReturnType<typeof api.adminBanners.list>>['items'][number];
export type BannerTarget = BannerEntry['target'];
export type BannerSlot = BannerEntry['slot'];
export type BannerStatistics = Awaited<ReturnType<typeof api.adminBanners.statistics>>;
export type BannerDraft = Pick<BannerEntry, 'slot' | 'target' | 'target_id' | 'target_name' | 'sort_order'> & {
  image_path: string | null;
};
export const bannerSlots = {
  'fitness-plan-library': { title: '计划页 · 计划库入口' },
  'fitness-template-library': { title: '模板页 · 模板库入口' },
};
export const bannerTargets: Record<BannerTarget, string> = {
  'fitness-plan-library': '计划库',
  'fitness-template-library': '模板库',
  'fitness-exercises': '动作库',
  'fitness-plans': '我的计划',
  'fitness-templates': '我的模板',
  'official-plan': '指定官方计划',
  'official-template': '指定官方模板',
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

/** 服务器图片使用鉴权预览，尚未选图的编辑草稿没有预览地址。 */
export function bannerPreview(entry: Pick<BannerDraft, 'image_path'>): string | undefined {
  const id = bannerImageId(entry.image_path);
  return id ? `/api/v1/admin/banners/media/${id}` : undefined;
}

/** 新增草稿只携带编辑字段，默认跳转对应位置的内容库。 */
export function newBannerDraft(slot: BannerSlot): BannerDraft {
  return {
    slot,
    image_path: null,
    target: slot,
    target_id: null,
    target_name: null,
    sort_order: 0,
  };
}

/** 官方详情展示可理解的内容名称，其他入口显示已注册页面名称。 */
export function bannerTargetLabel(entry: BannerEntry): string {
  return entry.target_id
    ? `${bannerTargets[entry.target]} · ${entry.target_name || '内容已不可用'}`
    : bannerTargets[entry.target];
}

/** 累计统计只按稳定身份对应，修改图片、位置或跳转不会清空该 Banner 的总量。 */
export function bannerMetrics(entry: BannerEntry, report?: BannerStatistics) {
  return report?.items.find((item) => item.banner_id === entry.id && item.source === 'remote');
}

/** 只在统计尚未返回时显示占位，已采集事实的累计零值正常显示。 */
export function bannerMetricCount(value: number | undefined): string {
  if (value === undefined) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}
